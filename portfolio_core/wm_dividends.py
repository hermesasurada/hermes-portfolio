"""wm(website-monitor) 회사 배당 공시 → 임시 배당 이벤트(2026-11-23 사용자 지시 "wm에서 배당소식은 포트폴리오에 반영해줘.
sa에도 같은 로직이 있으니 동일 기준으로").

wm이 2시간마다 받는 회사 IR 보도자료('The Home Depot Declares Quarterly Dividend of $2.33')의 본문을 wm이 요약할 때
`dividend_texts`(wm DB)에 남겨 두고, 여기서 읽기 전용으로 열어 sa 배당선언(`sa_dividends`)과 **같은 기준**으로 넣는다:
- `source='wm'`(임시). 같은 종목 배당락일 ±7일 안에 다른 출처 행(자체 수집·sa)이 있으면 넣지 않는다.
- 자체 수집(`dividend_refresh`)이 그 배당을 가져오면 ±7일 안의 임시 행(sa·wm)을 지운다(`sa_dividends.drop_superseded`).
- 수집 종목·USD만(본문 `$…per share`/`N cents per share`, 'C$'는 뺀다), 제목에 금액이 있으면 본문 금액과 같아야 한다.
- 금액·지급일·배당락일 중 하나라도 못 읽으면 넣지 않는다.

sa와 다른 점은 보도자료 문장 꼴뿐이다. 보도자료는 배당락일을 거의 적지 않고 기준일(of record)만 적는데, 미국은 2024-05-28
T+1 결제 전환 뒤 배당락일 = 기준일이다(Polygon 값도 그렇다 — NOC·KLAC·HD 등 2026년 행 전부 ex_date = record_date).
본문에 'ex-dividend date'가 따로 있으면 그것을 쓴다. 선언일은 기사 게시일(published_date, 없으면 발견일).
wm DB는 읽기 전용으로만 연다. 고르기·보관은 wm `wm_dividends.py`가 한다.

  python3 -m portfolio_core.wm_dividends [--days 7] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from .db import connect, ensure_dividend_tables
from .dividend_sources import _now_text
from .sa_dividends import _DATE, _parse_date, _window
from .tickers import ticker_currency

WM_DB_PATH = Path(os.environ.get(
    "WM_DB", Path.home() / "projects" / "website-monitor" / "data" / "website_monitor_v2.db"))
SOURCE = "wm"

# 'C$1.25 per share'(캐나다 달러)는 뺀다 — 앞에 영문자가 붙은 $는 받지 않는다.
_AMOUNT_RE = re.compile(
    r"(?<![A-Za-z])\$\s?(\d+(?:\.\d+)?)\s*(?:per\s+(?:common\s+)?share|/share|a\s+share)\b"
    r"|\b(\d+(?:\.\d+)?)\s+cents\s+per\s+(?:common\s+)?share\b", re.I)
_TITLE_AMOUNT_RE = re.compile(
    r"(?<![A-Za-z])\$\s?(\d+(?:\.\d+)?)(?!\s*(?:billion|million|bn|mn|[BMK]\b))|\b(\d+(?:\.\d+)?)\s+cents\b", re.I)
_PAY_RE = re.compile(r"\b(?:payable|be\s+paid|Payment\s+will\s+be\s+made)\s+(?:on\s+)?(?:or\s+about\s+)?" + _DATE, re.I)
_RECORD_RE = re.compile(r"\bof\s+record\b[^;]{0,60}?" + _DATE)
_EX_RE = re.compile(r"\bex-dividend\s+date\b[^.;]{0,30}?" + _DATE, re.I)
_DIVIDEND_WORD_RE = re.compile(r"\bdividend\b", re.I)
_LOOKBACK = 500      # 지급일 문장 앞에서 금액을 찾는 범위(3M: 금액 문장 다음 문장이 'The dividend is payable …')
_LOOKAROUND = 250    # 기준일을 찾는 범위(지급일 앞뒤 — 'to shareholders of record …'가 앞에 오는 꼴도 있다)


def _amount(m: re.Match) -> float:
    return float(m.group(1)) if m.group(1) else float(m.group(2)) / 100


def _title_amount(title: str) -> float | None:
    m = _TITLE_AMOUNT_RE.search(title or "")
    if not m:
        return None
    return float(m.group(1)) if m.group(1) else float(m.group(2)) / 100


def parse_release(title: str, body: str, article_day: date) -> dict | None:
    """보도자료 본문 → {amount, pay_date, record_date, ex_date, declaration_date}. 못 읽으면 None."""
    text = re.sub(r"\s+", " ", body or "")
    want = _title_amount(title)
    for pay_m in _PAY_RE.finditer(text):
        before = text[max(0, pay_m.start() - _LOOKBACK):pay_m.start()]
        first_div = _DIVIDEND_WORD_RE.search(before)
        if not first_div:
            continue
        amount_m = _AMOUNT_RE.search(before, first_div.start())   # '배당' 낱말 뒤 첫 주당 금액('to $0.2740 per share from $0.2715')
        if not amount_m:
            continue
        amount = _amount(amount_m)
        if amount <= 0 or (want is not None and abs(amount - want) > 1e-9):
            continue
        around = text[max(0, pay_m.start() - _LOOKAROUND):pay_m.end() + _LOOKAROUND]
        record_m = _RECORD_RE.search(around)
        ex_m = _EX_RE.search(around)
        pay = _parse_date(pay_m.group(1), article_day)
        record = _parse_date(record_m.group(1), article_day) if record_m else None
        ex = _parse_date(ex_m.group(1), article_day) if ex_m else record
        if not (pay and ex) or pay < ex:
            continue
        return {"amount": amount, "pay_date": pay, "ex_date": ex, "record_date": record,
                "declaration_date": article_day.isoformat()}
    return None


def _wm_rows(days: int) -> list[sqlite3.Row]:
    if not WM_DB_PATH.is_file():
        return []
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    conn = sqlite3.connect(f"file:{WM_DB_PATH}?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dividend_texts'").fetchone():
            return []
        return conn.execute(
            "SELECT a.id, d.ticker, a.title, a.published_date, a.discovered_date, d.body "
            "FROM dividend_texts d JOIN articles a ON a.id = d.article_id "
            "WHERE a.deleted = 0 AND a.discovered_date >= ? ORDER BY a.id",
            (since,),
        ).fetchall()
    finally:
        conn.close()


def _article_day(row: sqlite3.Row) -> date:
    stamp = str(row["published_date"] or row["discovered_date"] or "")
    return date.fromisoformat(stamp[:10])


def import_recent(days: int = 7, dry_run: bool = False) -> dict:
    """최근 N일 wm 배당 공시를 임시 배당 이벤트로 넣는다. 다른 출처 행이 있는 배당은 건드리지 않는다."""
    stats = {"articles": 0, "parsed": 0, "inserted": 0, "updated": 0, "covered": 0, "skipped": 0, "events": []}
    rows = _wm_rows(days)
    stats["articles"] = len(rows)
    if not rows:
        return stats
    now = _now_text()
    with connect() as conn:
        ensure_dividend_tables(conn)
        tracked = {r[0] for r in conn.execute("SELECT ticker FROM tickers")}
        for row in rows:
            ticker = str(row["ticker"] or "").strip().upper()
            if ticker not in tracked or ticker_currency(ticker) != "USD":
                stats["skipped"] += 1
                continue
            try:
                article_day = _article_day(row)
            except ValueError:
                stats["skipped"] += 1
                continue
            event = parse_release(row["title"], row["body"], article_day)
            if not event:
                stats["skipped"] += 1
                continue
            stats["parsed"] += 1
            lo, hi = _window(event["ex_date"])
            near = conn.execute(
                "SELECT ex_date, source FROM dividend_events WHERE ticker = ? AND ex_date BETWEEN ? AND ?",
                (ticker, lo, hi),
            ).fetchall()
            if any(r["source"] != SOURCE for r in near):
                stats["covered"] += 1          # 자체 수집이나 sa가 이미 넣었다
                continue
            label = f"{ticker} {event['ex_date']} ${event['amount']} (wm #{row['id']})"
            if dry_run:
                stats["events"].append(label)
                continue
            removed = conn.execute(
                "DELETE FROM dividend_events WHERE ticker = ? AND source = ? AND ex_date BETWEEN ? AND ?",
                (ticker, SOURCE, lo, hi),
            ).rowcount
            conn.execute(
                """
                INSERT INTO dividend_events
                  (ticker, ex_date, pay_date, amount, currency, source, fetched_at, declaration_date, record_date)
                VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?)
                ON CONFLICT(ticker, ex_date) DO NOTHING
                """,
                (ticker, event["ex_date"], event["pay_date"], event["amount"], SOURCE, now,
                 event["declaration_date"], event["record_date"]),
            )
            stats["updated" if removed else "inserted"] += 1
            if not removed:
                stats["events"].append(label)
        conn.commit()
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description="wm 회사 배당 공시 → 임시 배당 이벤트")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    print(json.dumps(import_recent(args.days, dry_run=args.dry_run), ensure_ascii=False))


if __name__ == "__main__":
    main()

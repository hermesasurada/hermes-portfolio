"""SA(Seeking Alpha) 배당선언 기사 → 임시 배당 이벤트(2026-10-28 사용자 지시).

sa-news 서비스가 받아 두는 'X declares $0.52 dividend' 기사는 미국 발표 직후(한국 새벽)에 들어온다. 포트폴리오의
자체 배당 수집(하루 한 번 07:17, 미국은 Polygon 권위)보다 대개 하루쯤 빠르다(2026-10-28 실측: WFC·ETN·CTAS·WMB가
SA에 02~04시에 들어왔는데 07:17 수집의 Polygon에는 아직 없었다). 그 사이를 SA 값으로 채운다.

규칙 — 자체 수집이 언제 오든 결국 자체 값만 남는다:
- SA 행은 `source='sa'`(임시). 같은 종목에 배당락일 ±7일 안의 자체 수집 행이 이미 있으면 넣지 않는다.
- 자체 수집(`dividend_refresh`)이 그 배당을 가져오면 ±7일 안의 `sa` 행을 지운다 — SA 편집자가 배당락일을 하루
  틀리게 적은 경우(WST: SA 11-09, Polygon 11-10)에도 키(종목, 배당락일)가 갈라진 사본이 남지 않게.
- 미국 달러 배당만(본문의 `$…/share`·`$…/ADS`, 수집 종목의 통화가 USD). 유로·대만달러 배당과 한국 종목은 뺀다.
- 금액·지급일·배당락일 중 하나라도 못 읽으면 넣지 않는다. 제목 금액과 본문 금액이 다르면 넣지 않는다.
- SA DB는 읽기 전용으로만 연다. sa 서비스 쪽은 고치지 않는다.

  python3 -m portfolio_core.sa_dividends [--days 7] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .db import connect, ensure_dividend_tables
from .dividend_sources import _now_text
from .tickers import ticker_currency

SA_DB_PATH = Path(os.environ.get("SA_NEWS_DB", Path.home() / "projects" / "sa-news" / "sa_news.db"))
SOURCE = "sa"
MATCH_WINDOW_DAYS = 7

_MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}
_DATE = r"([A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:,\s*\d{4})?)"
_AMOUNT_RE = re.compile(r"\bdeclares\s+\[?\$(\d+(?:\.\d+)?)/(?:share|ADS)\b", re.I)
_TITLE_AMOUNT_RE = re.compile(r"\bdeclares\s+\$(\d+(?:\.\d+)?)(?:/(?:share|ADS))?\b", re.I)
_PAY_RE = re.compile(r"\bPayable\s+" + _DATE)
_RECORD_RE = re.compile(r"\bof record\s+" + _DATE)
_EX_RE = re.compile(r"\bex-div(?:idend)?(?:\s+date)?\s+" + _DATE, re.I)
_PUBLISHED_RE = re.compile(r"\b" + _DATE + r",\s*\d{1,2}:\d{2}\s*[AP]M\s+ET\b")


def _parse_date(text: str, ref: date) -> str | None:
    m = re.match(r"([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?", text.strip())
    if not m or m.group(1).lower() not in _MONTHS:
        return None
    month, day = _MONTHS[m.group(1).lower()], int(m.group(2))
    year = int(m.group(3)) if m.group(3) else ref.year
    try:
        value = date(year, month, day)
        # 연도 없는 날짜: 기사보다 두 달 넘게 앞서면 다음 해(12월 기사의 'Payable Jan. 4')
        if not m.group(3) and (value - ref).days < -60:
            value = date(year + 1, month, day)
    except ValueError:
        return None
    return value.isoformat()


def parse_declaration(title: str, text: str, article_day: date) -> dict | None:
    """배당선언 기사 본문 → {amount, pay_date, record_date, ex_date, declaration_date}. 못 읽으면 None."""
    body = text or ""
    amount_m = _AMOUNT_RE.search(body)
    title_m = _TITLE_AMOUNT_RE.search(title or "")
    pay_m, ex_m = _PAY_RE.search(body), _EX_RE.search(body)
    if not (amount_m and title_m and pay_m and ex_m):
        return None
    amount = float(amount_m.group(1))
    if abs(amount - float(title_m.group(1))) > 1e-9 or amount <= 0:
        return None
    published_m = _PUBLISHED_RE.search(body)
    declared = _parse_date(published_m.group(1), article_day) if published_m else None
    ref = date.fromisoformat(declared) if declared else article_day
    record_m = _RECORD_RE.search(body)
    event = {
        "amount": amount,
        "pay_date": _parse_date(pay_m.group(1), ref),
        "ex_date": _parse_date(ex_m.group(1), ref),
        "record_date": _parse_date(record_m.group(1), ref) if record_m else None,
        "declaration_date": declared or article_day.isoformat(),
    }
    if not (event["pay_date"] and event["ex_date"]) or event["pay_date"] < event["ex_date"]:
        return None
    return event


def _sa_rows(days: int) -> list[sqlite3.Row]:
    if not SA_DB_PATH.is_file():
        return []
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    conn = sqlite3.connect(f"file:{SA_DB_PATH}?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT id, ticker, original_title, email_time_et, source_text FROM articles "
            "WHERE original_title LIKE '%declares%dividend%' AND email_time_et >= ? "
            "AND COALESCE(source_text, '') != '' ORDER BY id",
            (since,),
        ).fetchall()
    finally:
        conn.close()


def _article_day_et(stamp: str) -> date:
    """SA 수신 시각('2026-10-28 02:40 KST') → 미국 동부 날짜. 본문에 발행 시각 줄이 없을 때(sa_api 본문) 선언일로 쓴다."""
    text = stamp.replace("KST", "").strip()
    try:
        moment = datetime.strptime(text[:16], "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo("Asia/Seoul"))
    except ValueError:
        return date.fromisoformat(text[:10])
    return moment.astimezone(ZoneInfo("America/New_York")).date()


def _window(ex_date: str) -> tuple[str, str]:
    day = date.fromisoformat(ex_date)
    return ((day - timedelta(days=MATCH_WINDOW_DAYS)).isoformat(),
            (day + timedelta(days=MATCH_WINDOW_DAYS)).isoformat())


def import_recent(days: int = 7, dry_run: bool = False) -> dict:
    """최근 N일 SA 배당선언을 임시 배당 이벤트로 넣는다. 자체 수집 행이 있는 배당은 건드리지 않는다."""
    stats = {"articles": 0, "parsed": 0, "inserted": 0, "updated": 0, "covered": 0, "skipped": 0, "events": []}
    rows = _sa_rows(days)
    stats["articles"] = len(rows)
    if not rows:
        return stats
    now = _now_text()
    with connect() as conn:
        ensure_dividend_tables(conn)
        tracked = {r[0] for r in conn.execute("SELECT ticker FROM tickers")}
        for row in rows:
            ticker = str(row["ticker"] or "").split(",")[0].strip().upper()
            if ticker not in tracked or ticker_currency(ticker) != "USD":
                stats["skipped"] += 1
                continue
            try:
                article_day = _article_day_et(str(row["email_time_et"]))
            except ValueError:
                stats["skipped"] += 1
                continue
            event = parse_declaration(row["original_title"], row["source_text"], article_day)
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
                stats["covered"] += 1          # 자체 수집이 이미 가져왔다 — 자체 값이 우선
                continue
            label = f"{ticker} {event['ex_date']} ${event['amount']} (sa #{row['id']})"
            if dry_run:
                stats["events"].append(label)
                continue
            # 같은 배당의 SA 정정 기사: 이전 SA 행을 지우고 새로 쓴다(배당락일이 바뀌었을 수 있다)
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


def drop_superseded(conn, ticker: str, ex_dates: list[str]) -> int:
    """자체 수집이 가져온 배당(배당락일 목록)의 ±7일 안 SA 임시 행을 지운다. 지운 행 수."""
    removed = 0
    for ex_date in ex_dates:
        try:
            lo, hi = _window(ex_date)
        except (TypeError, ValueError):
            continue
        cur = conn.execute(
            "DELETE FROM dividend_events WHERE ticker = ? AND source = ? AND ex_date BETWEEN ? AND ?",
            (ticker, SOURCE, lo, hi),
        )
        removed += max(0, int(getattr(cur, "rowcount", 0) or 0))
    return removed


def main() -> None:
    ap = argparse.ArgumentParser(description="SA 배당선언 기사 → 임시 배당 이벤트")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    stats = import_recent(args.days, dry_run=args.dry_run)
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()

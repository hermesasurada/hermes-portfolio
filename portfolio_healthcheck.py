#!/usr/bin/env python3
"""포트폴리오 수집 파이프라인 일일 점검 — no_agent cron이 stdout을 Telegram으로
전달한다. 문제가 있으면 ⚠️ 요약을, --heartbeat면 정상일 때도 ✅ 한 줄을 출력.
(wm_healthcheck.py와 동일 패턴)

점검 항목 (DB 흔적만 읽음, 새 수집 없음 — load_collection_diagnostics 재사용):
- 배당 수집 실패: ticker_dividend_cache.status LIKE '%_error%'
- 펀더멘털·기술지표·배당·분할 캐시 최신성
- 실적일 수집 최신성 및 7일 이상 지난 원천 날짜
- 가격 정체: 전체 최신일 대비 4일 초과 뒤처진 종목
- 실시간·일배치 가격 수집 중단/0건: collector_runs 'price', 'price-daily'
"""
from __future__ import annotations

import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from portfolio_core.db import connect
from portfolio_core.fundamentals import STATS_CACHE_VERSION
from portfolio_core.paths import KST
from portfolio_core.queries import load_collection_diagnostics
from portfolio_core.technical_stats import TECHNICAL_CACHE_VERSION
from portfolio_core.tickers import asset_class

PRICE_RUN_MAX_AGE_HOURS = 36  # 주말 고려 — 평일 10분 주기 수집이 이보다 오래 멈추면 이상
DAILY_PRICE_RUN_MAX_AGE_HOURS = 48
DAILY_CACHE_MAX_AGE_HOURS = 36
MARKET_CACHE_MAX_AGE_HOURS = 120  # 주말·휴장 뒤 첫 일배치 전까지 허용


def _run_age_hours(updated_at: str | None) -> float | None:
    """collector_runs.updated_at은 ISO+타임존 형식 ('2026-06-11T11:00:29...+00:00')."""
    if not updated_at:
        return None
    try:
        ts = datetime.fromisoformat(updated_at)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=KST)
    return (datetime.now(KST) - ts).total_seconds() / 3600


def _issue_summary(label: str, rows: list[dict]) -> str:
    tickers = ", ".join(str(item["ticker"]) for item in rows[:8])
    more = f" 외 {len(rows) - 8}건" if len(rows) > 8 else ""
    return f"{label} {len(rows)}건: {tickers}{more}"


def _older_than(value: str | None, max_age_hours: float) -> bool:
    age = _run_age_hours(value)
    return age is None or age > max_age_hours


def check() -> list[str]:
    with connect() as conn:
        diag = load_collection_diagnostics(conn)
        fundamentals = [dict(row) for row in conn.execute(
            """
            SELECT t.ticker, t.name, s.version, s.fetched_at, s.source
            FROM tickers t
            LEFT JOIN ticker_stats_cache s ON s.ticker = t.ticker
            WHERE t.category IN ('kr', 'overseas')
            ORDER BY t.ticker
            """
        ).fetchall()]
        technicals = [dict(row) for row in conn.execute(
            """
            SELECT t.ticker, s.version, s.computed_at, s.price_count
            FROM tickers t
            LEFT JOIN ticker_technical_stats_cache s ON s.ticker = t.ticker
            WHERE t.category IN ('fx', 'crypto', 'overseas', 'kr', 'index')
            ORDER BY t.ticker
            """
        ).fetchall()]
        earnings = [dict(row) for row in conn.execute(
            """
            SELECT ticker, name, next_earnings_date, earnings_updated_at
            FROM tickers
            WHERE category IN ('kr', 'overseas')
            ORDER BY ticker
            """
        ).fetchall()]
        dividends = [dict(row) for row in conn.execute(
            """
            SELECT t.ticker, c.fetched_at, c.status
            FROM tickers t
            LEFT JOIN ticker_dividend_cache c ON c.ticker = t.ticker
            WHERE t.category IN ('kr', 'overseas')
            ORDER BY t.ticker
            """
        ).fetchall()]
        splits = [dict(row) for row in conn.execute(
            """
            SELECT t.ticker, c.fetched_at, c.status
            FROM tickers t
            LEFT JOIN ticker_split_cache c ON c.ticker = t.ticker
            WHERE t.category IN ('kr', 'overseas')
            ORDER BY t.ticker
            """
        ).fetchall()]

    problems: list[str] = []
    errors = diag["dividend_errors"]
    if errors:
        tickers = ", ".join(item["ticker"] for item in errors[:8])
        more = f" 외 {len(errors) - 8}건" if len(errors) > 8 else ""
        problems.append(f"배당 수집 실패 {len(errors)}건: {tickers}{more}")

    fundamental_issues = [
        row for row in fundamentals
        if row["version"] != STATS_CACHE_VERSION
        or row["source"] in (None, "unknown")
        or _older_than(row["fetched_at"], MARKET_CACHE_MAX_AGE_HOURS)
    ]
    if fundamental_issues:
        problems.append(_issue_summary("펀더멘털 캐시 지연/누락", fundamental_issues))

    technical_issues = [
        row for row in technicals
        if row["version"] != TECHNICAL_CACHE_VERSION
        or not row["price_count"]
        or _older_than(row["computed_at"], MARKET_CACHE_MAX_AGE_HOURS)
    ]
    if technical_issues:
        problems.append(_issue_summary("기술지표 캐시 지연/누락", technical_issues))

    stock_earnings = [
        row for row in earnings
        if asset_class(row["ticker"], row["name"] or "") == "stock"
    ]
    earnings_stale = [
        row for row in stock_earnings
        if _older_than(row["earnings_updated_at"], MARKET_CACHE_MAX_AGE_HOURS)
    ]
    if earnings_stale:
        problems.append(_issue_summary("실적일 조회 지연/누락", earnings_stale))

    past_cutoff = datetime.now(KST).date().toordinal() - 7
    earnings_past = []
    for row in stock_earnings:
        try:
            is_past = date.fromisoformat(str(row["next_earnings_date"])).toordinal() < past_cutoff
        except (TypeError, ValueError):
            is_past = False
        if is_past:
            earnings_past.append(row)
    if earnings_past:
        problems.append(_issue_summary("실적일 원천이 과거 날짜", earnings_past))

    dividend_stale = [
        row for row in dividends
        if _older_than(row["fetched_at"], DAILY_CACHE_MAX_AGE_HOURS)
    ]
    if dividend_stale:
        problems.append(_issue_summary("배당 캐시 지연/누락", dividend_stale))

    split_issues = [
        row for row in splits
        if str(row["status"] or "").startswith("error:")
        or _older_than(row["fetched_at"], DAILY_CACHE_MAX_AGE_HOURS)
    ]
    if split_issues:
        problems.append(_issue_summary("주식분할 캐시 지연/실패", split_issues))

    stale = diag["stale_prices"]
    if stale:
        tickers = ", ".join(item["ticker"] for item in stale[:8])
        more = f" 외 {len(stale) - 8}건" if len(stale) > 8 else ""
        problems.append(f"가격 정체(4일+) {len(stale)}건: {tickers}{more}")

    run = diag["price_run"]
    age = _run_age_hours(run["updated_at"]) if run else None
    if age is None:
        problems.append("가격 수집 기록 없음 (collector_runs)")
    elif age > PRICE_RUN_MAX_AGE_HOURS:
        problems.append(f"가격 수집 중단 의심 — 마지막 실행 {age:.0f}시간 전 ({run['updated_at']})")
    elif int(run["item_count"] or 0) == 0:
        problems.append(f"가격 수집 결과 0건 ({run['updated_at']})")

    daily_run = diag["daily_price_run"]
    daily_age = _run_age_hours(daily_run["updated_at"]) if daily_run else None
    if daily_age is None:
        problems.append("가격 일배치 기록 없음 (collector_runs: price-daily)")
    elif daily_age > DAILY_PRICE_RUN_MAX_AGE_HOURS:
        problems.append(
            f"가격 일배치 중단 의심 — 마지막 실행 {daily_age:.0f}시간 전 ({daily_run['updated_at']})"
        )
    elif int(daily_run["item_count"] or 0) == 0:
        problems.append(f"가격 일배치 결과 0건 ({daily_run['updated_at']})")

    return problems


def main(argv: list[str]) -> int:
    heartbeat = "--heartbeat" in argv
    problems = check()
    today = datetime.now(KST).strftime("%Y-%m-%d")
    if problems:
        print(f"⚠️ 포트폴리오 수집 점검 ({today}) — {len(problems)}건")
        for line in problems:
            print(f"- {line}")
        print("\n상세: 대시보드 ? 버튼 → 수집 진단")
    elif heartbeat:
        print(f"✅ 포트폴리오 수집 정상 ({today})")
    # else: silent (no stdout → no Telegram delivery)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

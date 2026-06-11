#!/usr/bin/env python3
"""포트폴리오 수집 파이프라인 일일 점검 — no_agent cron이 stdout을 Telegram으로
전달한다. 문제가 있으면 ⚠️ 요약을, --heartbeat면 정상일 때도 ✅ 한 줄을 출력.
(wm_healthcheck.py와 동일 패턴)

점검 항목 (DB 흔적만 읽음, 새 수집 없음 — load_collection_diagnostics 재사용):
- 배당 수집 실패: ticker_dividend_cache.status LIKE '%_error%'
- 가격 정체: 전체 최신일 대비 4일 초과 뒤처진 종목
- 가격 수집 자체 중단: collector_runs 'price'가 오래됨
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from portfolio_core.db import connect
from portfolio_core.paths import KST
from portfolio_core.queries import load_collection_diagnostics

PRICE_RUN_MAX_AGE_HOURS = 36  # 주말 고려 — 평일 10분 주기 수집이 이보다 오래 멈추면 이상


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


def check() -> list[str]:
    with connect() as conn:
        diag = load_collection_diagnostics(conn)

    problems: list[str] = []
    errors = diag["dividend_errors"]
    if errors:
        tickers = ", ".join(item["ticker"] for item in errors[:8])
        more = f" 외 {len(errors) - 8}건" if len(errors) > 8 else ""
        problems.append(f"배당 수집 실패 {len(errors)}건: {tickers}{more}")

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

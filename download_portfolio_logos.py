#!/usr/bin/env python3
"""추적 종목 로고를 일괄 수집하는 CLI — portfolio_core.logos.cache_logo 위임 래퍼.

과거엔 FMP fetch·폴백 맵을 이 파일이 독자 구현해 core(logos.py)와 drift가
났었다(폴백 누락, 정방형 판정 없이 워드마크로 되덮는 위험). 이제 로고 획득
정책(KR ETF 브랜드 → FMP 정방형 → 기업 파비콘 → FMP 워드마크 → 수동 폴백)은
core 한 곳에만 있고, 여기는 대상 티커 순회 + 진행 출력만 한다.

기본은 기존 로고 보존(core 기본값과 동일). 강제 재다운로드는 --force.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from portfolio_core.db import connect
from portfolio_core.logos import cache_logo


def target_tickers(holdings_only: bool) -> list[tuple[str, str | None]]:
    with connect() as conn:
        if holdings_only:
            rows = conn.execute(
                """
                SELECT DISTINCT h.ticker, t.name
                FROM holdings h LEFT JOIN tickers t ON t.ticker = h.ticker
                WHERE h.ticker IS NOT NULL ORDER BY h.ticker
                """
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT ticker, name FROM tickers
                WHERE ticker IS NOT NULL AND COALESCE(category, '') NOT IN ('fx', 'index')
                ORDER BY ticker
                """
            ).fetchall()
    return [(row["ticker"], row["name"]) for row in rows]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--holdings-only", action="store_true", help="보유 종목만 (기본: 관심종목 포함 전 추적종목)")
    parser.add_argument("--force", action="store_true", help="기존 로고도 다시 받는다 (기본: 있으면 보존)")
    parser.add_argument("--ticker", action="append", help="특정 티커만. 반복 지정 가능.")
    parser.add_argument("--sleep", type=float, default=0.08)
    args = parser.parse_args()

    if args.ticker:
        targets = [(t.strip().upper(), None) for t in args.ticker if t.strip()]
    else:
        targets = target_tickers(args.holdings_only)

    print(f"Tickers: {len(targets)} (force={args.force})")
    saved = kept = failed = 0
    for ticker, name in targets:
        result = cache_logo(ticker, name=name, keep_existing=not args.force)
        if result.get("saved"):
            saved += 1
            print(f"SAVE {ticker}: {result.get('path')} via {result.get('source')}")
        elif result.get("source") == "existing":
            kept += 1
        else:
            failed += 1
            print(f"FAIL {ticker}: {result.get('error')}")
        time.sleep(args.sleep)

    print(f"Done: saved={saved} kept={kept} failed={failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

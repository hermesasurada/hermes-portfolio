#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_core.db import connect
from portfolio_core.earnings_history import backfill_earnings_month


DEFAULT_LOG_DIR = Path.home() / "Library" / "Logs" / "hermes"
DEFAULT_LOGS = [
    DEFAULT_LOG_DIR / "portfolio-price-daily-kr.log",
    DEFAULT_LOG_DIR / "portfolio-price-daily-overseas.log",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="수집 로그와 캐시에서 월별 실적일 이력을 복원합니다.")
    parser.add_argument("--month", required=True, help="복원할 월(YYYY-MM)")
    parser.add_argument("--dry-run", action="store_true", help="결과를 롤백하고 건수만 확인")
    args = parser.parse_args()

    with connect() as conn:
        result = backfill_earnings_month(conn, args.month, DEFAULT_LOGS)
        if args.dry_run:
            conn.rollback()
    mode = "dry-run" if args.dry_run else "applied"
    print(
        f"[{mode}] {args.month}: candidates={result['candidate_count']}, "
        f"inserted={result['inserted']} "
        f"(cache={result['inserted_yfinance_cache']}, log={result['inserted_collector_log']}), "
        f"duplicates={result['skipped_duplicate']}, untracked={result['skipped_untracked']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

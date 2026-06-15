#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from collect_prices import parse_categories
from portfolio_core.price_store import (
    collector_run_due,
    save_daily_prices,
    update_collector_run,
    update_price_cache,
)
from portfolio_core.snapshot_collector import collect_snapshots
from portfolio_core.technical_stats import refresh_technical_stats_cache

TECHNICAL_REFRESH_SECONDS = 10 * 60


@contextmanager
def collector_lock(scope: str):
    lock_path = Path(f"/tmp/hermes-portfolio-quotes-{scope}.lock")
    with lock_path.open("w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Skipped: another quote collector is still running")
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect low-request current-price snapshots.")
    parser.add_argument(
        "--category",
        action="append",
        help="Category to update: fx, crypto, overseas, kr, index, all.",
    )
    parser.add_argument("--ticker", action="append", help="Limit to a ticker. Can be repeated.")
    parser.add_argument("--skip-technicals", action="store_true")
    args = parser.parse_args()
    categories = parse_categories(args.category)
    technical_run_name = f"technical:{','.join(categories)}"

    lock_scope = "-".join(categories)
    with collector_lock(lock_scope) as acquired:
        if not acquired:
            return 0
        fetched, errors = collect_snapshots(categories, args.ticker)
        cache_entries = []
        row_count = 0
        for item in fetched:
            row_count += save_daily_prices(item.ticker, item.recent, item.source)
            cache_entries.append((item.ticker, item.price, item.currency, item.source))
        if cache_entries:
            update_price_cache(cache_entries)

        if (
            fetched
            and not args.skip_technicals
            and collector_run_due(technical_run_name, TECHNICAL_REFRESH_SECONDS)
        ):
            updated = refresh_technical_stats_cache(item.ticker for item in fetched)
            update_collector_run(technical_run_name, updated)
            print(f"Updated {updated} technical stats")

        print(f"Snapshot updated {len(fetched)} tickers / {row_count} rows")
        if errors:
            print(f"Missing {len(errors)} tickers: {', '.join(errors)}")
        return 0 if fetched or not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())

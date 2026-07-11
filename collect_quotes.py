#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from collect_prices import collector_lock, parse_categories
from portfolio_core.db import initialize_schema
from portfolio_core.price_store import (
    collector_run_due,
    load_watch,
    save_daily_prices,
    update_collector_run,
    update_price_cache,
)
from portfolio_core.snapshot_collector import collect_snapshots
from portfolio_core.technical_stats import refresh_technical_stats_cache

TECHNICAL_REFRESH_SECONDS = 10 * 60


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

    lock_scope = f"quotes-{'-'.join(categories)}"
    with collector_lock(lock_scope) as acquired:
        if not acquired:
            return 0
        initialize_schema()
        fetched, errors = collect_snapshots(categories, args.ticker)
        cache_entries = []
        row_count = 0
        for item in fetched:
            row_count += save_daily_prices(item.ticker, item.recent, item.source)
            cache_entries.append((item.ticker, item.price, item.currency, item.source))
        if cache_entries:
            update_price_cache(cache_entries)

        if not args.skip_technicals and collector_run_due(technical_run_name, TECHNICAL_REFRESH_SECONDS):
            watch = load_watch(categories=categories, tickers=args.ticker)
            technical_tickers = sorted({
                ticker
                for category in categories
                for ticker in watch.get(category, [])
            })
            updated = refresh_technical_stats_cache(technical_tickers)
            update_collector_run(technical_run_name, updated)
            print(f"Updated {updated} technical stats")

        print(f"Snapshot updated {len(fetched)} tickers / {row_count} rows")
        if errors:
            print(f"Missing {len(errors)} tickers: {', '.join(errors)}")
        return 0 if fetched or not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())

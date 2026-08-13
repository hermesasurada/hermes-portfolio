#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from portfolio_core.collect_common import parse_categories
from portfolio_core.collectors import fetch_history_rows, fetch_yahoo_history_batch, yahoo_batch_target
from portfolio_core.db import connect, initialize_schema
from portfolio_core.price_store import load_watch, save_daily_prices


def chunks(items: list, size: int):
    for offset in range(0, len(items), size):
        yield items[offset : offset + size]


def needs_ohlc(ticker: str, years: int) -> bool:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL THEN 1 ELSE 0 END) AS ohlc
            FROM daily_prices
            WHERE ticker = ? AND date >= date('now', ?)
            """,
            (ticker, f"-{max(1, years)} years"),
        ).fetchone()
    total = int(row["total"] or 0)
    ohlc = int(row["ohlc"] or 0)
    return total == 0 or ohlc < max(2, int(total * 0.98))


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill OHLC history for candle charts.")
    parser.add_argument("--category", action="append", help="fx, crypto, overseas, kr, index, all")
    parser.add_argument("--ticker", action="append", help="Limit to a ticker; repeatable.")
    parser.add_argument("--years", type=int, default=10)
    parser.add_argument("--chunk-size", type=int, default=40)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    initialize_schema()
    categories = parse_categories(args.category)
    watch = load_watch(categories=categories, tickers=args.ticker)
    category_of = {
        ticker: category
        for category in categories
        for ticker in watch.get(category, [])
    }
    wanted = {
        ticker: category
        for ticker, category in category_of.items()
        if args.force or needs_ohlc(ticker, args.years)
    }
    if not wanted:
        print("OHLC coverage already complete")
        return 0

    saved_tickers = 0
    saved_rows = 0
    errors: list[str] = []
    yahoo_targets = []
    for ticker, category in wanted.items():
        target = yahoo_batch_target(category, ticker)
        if target is None and ticker == "KOSPI":
            target = ("KOSPI", "^KS11", "KRW")
        if target is not None:
            yahoo_targets.append(target)
    for batch in chunks(yahoo_targets, max(1, args.chunk_size)):
        histories, missing = fetch_yahoo_history_batch(batch, period=f"{max(1, args.years)}y")
        errors.extend(missing)
        for ticker, rows in histories.items():
            count = save_daily_prices(ticker, rows, "yf-ohlc-backfill")
            if count:
                saved_tickers += 1
                saved_rows += count
                print(f"  + {ticker}: {count} OHLC rows")

    yahoo_tickers = {ticker for ticker, _symbol, _currency in yahoo_targets}
    for ticker, category in wanted.items():
        if ticker in yahoo_tickers:
            continue
        try:
            rows = fetch_history_rows(category, ticker, period=f"{max(1, args.years)}y")
            source = "fdr-ohlc-backfill" if category in {"kr", "index"} else "upbit-ohlc-backfill"
            count = save_daily_prices(ticker, rows, source)
        except Exception as exc:
            print(f"  x {ticker}: {type(exc).__name__}: {exc}")
            errors.append(ticker)
            continue
        if count:
            saved_tickers += 1
            saved_rows += count
            print(f"  + {ticker}: {count} OHLC rows")

    print(f"Backfilled {saved_tickers} tickers / {saved_rows} OHLC rows")
    if errors:
        print(f"Missing {len(set(errors))} tickers: {', '.join(sorted(set(errors)))}")
    return 0 if saved_tickers or not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())

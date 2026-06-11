#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
import time
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from portfolio_core.collectors import (
    CollectedPrice,
    fetch_history_rows,
    fetch_investing_kr_earnings_date,
    fetch_price,
    fetch_yahoo_earnings_date,
)
from portfolio_core.corporate_actions import refresh_stock_splits
from portfolio_core.db import connect, ensure_dividend_tables
from portfolio_core.dividends import refresh_dividend_events
from portfolio_core.price_store import (
    CATEGORIES,
    earnings_update_due_tickers,
    history_backfill_status,
    load_watch,
    load_ticker_profiles,
    save_daily_prices,
    update_earnings_dates,
    update_price_cache,
)
from portfolio_core.technical_stats import refresh_technical_stats_cache
from portfolio_core.tickers import asset_class

KR_EARNINGS_DELAY_SECONDS = 0.8
# 신규 보유 종목 과거 이력 자동 백필: 이력이 이 행수 미만이고 아직 백필한 적
# 없으면 1회 전체 이력을 받아 채운다. (stock 보유 카테고리 한정)
HISTORY_BACKFILL_MIN_ROWS = 60
HISTORY_BACKFILL_CATEGORIES = ("overseas", "kr")


def backfill_new_tickers(categories: list[str], tickers: list[str] | None) -> tuple[int, list[str]]:
    target_categories = [c for c in categories if c in HISTORY_BACKFILL_CATEGORIES]
    if not target_categories:
        return 0, []
    watch = load_watch(categories=target_categories, tickers=tickers)
    category_of: dict[str, str] = {}
    for category in target_categories:
        for ticker in watch.get(category, []):
            category_of.setdefault(ticker, category)
    if not category_of:
        return 0, []
    status = history_backfill_status(category_of.keys())
    rows_saved = 0
    backfilled: list[str] = []
    for ticker, category in category_of.items():
        count, already = status.get(ticker, (0, False))
        if already or count >= HISTORY_BACKFILL_MIN_ROWS:
            continue
        try:
            rows = fetch_history_rows(category, ticker)
        except Exception as exc:
            print(f"  x {ticker} backfill: {exc}")
            continue
        if not rows:
            continue
        source = "fdr-backfill" if category == "kr" else "yf-backfill"
        saved = save_daily_prices(ticker, rows, source)
        if saved:
            rows_saved += saved
            backfilled.append(ticker)
            print(f"  ↺ backfilled {ticker}: {saved} history rows")
    return rows_saved, backfilled


def parse_categories(values: list[str] | None) -> list[str]:
    if not values:
        return list(CATEGORIES)
    categories: list[str] = []
    for value in values:
        categories.extend(item.strip() for item in value.split(",") if item.strip())
    if "all" in categories:
        return list(CATEGORIES)
    unknown = sorted(set(categories) - set(CATEGORIES))
    if unknown:
        raise SystemExit(f"Unknown category: {', '.join(unknown)}")
    return sorted(set(categories), key=list(CATEGORIES).index)


def collect_prices(categories: list[str], tickers: list[str] | None, history_start: str) -> tuple[list[CollectedPrice], list[str]]:
    watch = load_watch(categories=categories, tickers=tickers)
    fetched: list[CollectedPrice] = []
    errors: list[str] = []

    for category in categories:
        for ticker in watch.get(category, []):
            try:
                result = fetch_price(category, ticker, history_start=history_start)
            except Exception as exc:
                print(f"  x {ticker} ({category}): {exc}")
                errors.append(ticker)
                continue
            if result is None:
                print(f"  x {ticker} ({category}): no price")
                errors.append(ticker)
                continue
            fetched.append(result)
            print(f"  + {result.ticker}: {result.price:,.4f} {result.currency} ({result.price_date}, {result.source})")

    return fetched, errors


def collect_earnings_dates(
    categories: list[str],
    tickers: list[str] | None,
    max_age_hours: float,
    force: bool = False,
) -> tuple[list[tuple[str, str | None]], list[str]]:
    if "overseas" not in categories and "kr" not in categories:
        return [], []
    watch = load_watch(categories=["overseas", "kr"], tickers=tickers)
    overseas_tickers = watch.get("overseas", []) if "overseas" in categories else []
    kr_tickers = watch.get("kr", []) if "kr" in categories else []
    profiles = load_ticker_profiles(kr_tickers)
    kr_stock_tickers = [
        ticker
        for ticker in kr_tickers
        if asset_class(ticker, profiles.get(ticker.upper(), {}).get("name") or "") == "stock"
    ]
    selected_tickers = overseas_tickers + kr_stock_tickers
    due_tickers = selected_tickers if force else earnings_update_due_tickers(selected_tickers, max_age_hours=max_age_hours)
    skipped = len(selected_tickers) - len(due_tickers)
    if skipped > 0:
        print(f"  - skipped {skipped} fresh earnings dates")
    fetched: list[tuple[str, str | None]] = []
    errors: list[str] = []
    for ticker in due_tickers:
        try:
            if ticker.endswith((".KS", ".KQ")):
                time.sleep(KR_EARNINGS_DELAY_SECONDS)
                earnings_date = fetch_investing_kr_earnings_date(ticker)
            else:
                earnings_date = fetch_yahoo_earnings_date(ticker)
        except urllib.error.HTTPError as exc:
            print(f"  x {ticker} earnings: HTTP {exc.code}")
            errors.append(ticker)
            if ticker.endswith((".KS", ".KQ")) and exc.code == 403:
                print("  x stopped Korean earnings refresh after Investing.com challenge")
                break
        except Exception as exc:
            print(f"  x {ticker} earnings: {exc}")
            errors.append(ticker)
            continue
        fetched.append((ticker, earnings_date))
        print(f"  + {ticker} earnings: {earnings_date or '-'}")
    return fetched, errors


def load_dividend_tickers(tickers: list[str] | None = None) -> list[str]:
    wanted = {ticker.strip().upper() for ticker in tickers or [] if ticker and ticker.strip()}
    filter_sql = ""
    params: list[object] = []
    if wanted:
        placeholders = ",".join("?" for _ in wanted)
        filter_sql = f"AND UPPER(h.ticker) IN ({placeholders})"
        params.extend(sorted(wanted))
    with connect() as conn:
        ensure_dividend_tables(conn)
        rows = conn.execute(
            f"""
            SELECT DISTINCT UPPER(h.ticker) AS ticker
            FROM holdings h
            WHERE h.ticker IS NOT NULL
              AND TRIM(h.ticker) <> ''
              AND COALESCE(h.qty, 0) > 0
              {filter_sql}
            ORDER BY ticker
            """,
            params,
        ).fetchall()
    return [row["ticker"] for row in rows]


def collect_dividend_events(tickers: list[str] | None = None) -> int:
    dividend_tickers = load_dividend_tickers(tickers)
    if not dividend_tickers:
        return 0
    refresh_dividend_events(dividend_tickers)
    return len(dividend_tickers)


def collect_stock_splits(tickers: list[str] | None = None) -> int:
    split_tickers = load_dividend_tickers(tickers)
    if not split_tickers:
        return 0
    updated = refresh_stock_splits(split_tickers)
    for ticker, count in updated.items():
        print(f"  + {ticker} splits: {count}")
    return len(updated)


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect portfolio prices into stock_history.db.")
    parser.add_argument(
        "--category",
        action="append",
        help="Category to update: fx, crypto, overseas, kr, index, all. Can be repeated or comma-separated.",
    )
    parser.add_argument("--ticker", action="append", help="Limit to a ticker. Can be repeated.")
    parser.add_argument("--history-start", default="20250101", help="FDR start date for Korean stock history.")
    parser.add_argument("--skip-earnings", action="store_true", help="Do not update earnings dates.")
    parser.add_argument("--skip-dividends", action="store_true", help="Do not update dividend event cache.")
    parser.add_argument("--skip-splits", action="store_true", help="Do not update stock split history.")
    parser.add_argument("--force-earnings", action="store_true", help="Refresh earnings dates even if recently updated.")
    parser.add_argument("--earnings-max-age-hours", type=float, default=24, help="Refresh earnings dates older than this many hours.")
    args = parser.parse_args()

    categories = parse_categories(args.category)
    fetched, errors = collect_prices(categories, args.ticker, args.history_start)

    cache_entries = []
    row_count = 0
    for item in fetched:
        row_count += save_daily_prices(item.ticker, item.recent, item.source)
        cache_entries.append((item.ticker, item.price, item.currency, item.source))
    if cache_entries:
        update_price_cache(cache_entries)

    backfill_count, backfilled = backfill_new_tickers(categories, args.ticker)
    if backfill_count:
        row_count += backfill_count
        print(f"Backfilled {len(backfilled)} new tickers / {backfill_count} history rows")

    technical_tickers = {item.ticker for item in fetched} | set(backfilled)
    technical_updated = refresh_technical_stats_cache(technical_tickers)
    if technical_updated:
        print(f"Updated {technical_updated} technical stats")
    earnings_errors: list[str] = []
    if not args.skip_earnings:
        earnings_entries, earnings_errors = collect_earnings_dates(
            categories,
            args.ticker,
            args.earnings_max_age_hours,
            args.force_earnings,
        )
        updated_earnings = update_earnings_dates(earnings_entries)
        if updated_earnings:
            print(f"Updated {updated_earnings} earnings dates")
    if not args.skip_dividends:
        dividend_count = collect_dividend_events(args.ticker)
        if dividend_count:
            print(f"Checked dividend events for {dividend_count} held tickers")
    if not args.skip_splits:
        split_count = collect_stock_splits(args.ticker)
        if split_count:
            print(f"Updated stock splits for {split_count} held tickers")

    print(f"Updated {len(fetched)} tickers / {row_count} daily rows")
    all_errors = errors + [f"{ticker}:earnings" for ticker in earnings_errors]
    if all_errors:
        print(f"Failed {len(all_errors)} tickers: {', '.join(all_errors)}")
    return 0 if fetched or not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import math
import re
import time

from .collectors import fetch_history_rows, fetch_investing_kr_earnings_date, fetch_yahoo_earnings_date
from .corporate_actions import refresh_stock_splits
from .db import connect, ensure_ticker_metadata_columns
from .fundamentals import fetch_fundamentals
from .logos import cache_logo
from .price_store import infer_category, save_daily_prices, update_earnings_dates
from .technical_stats import refresh_technical_stats_cache
from .ticker_lookup import resolve_kr_suffix
from .tickers import asset_class


def normalize_hydration_ticker(value: str) -> str:
    ticker = re.sub(r"\s+", "", str(value or "")).upper()
    if re.fullmatch(r"\d{6}", ticker):
        return resolve_kr_suffix(ticker)
    return ticker


def hydrate_ticker(ticker: str, years: int = 10) -> dict:
    ticker = normalize_hydration_ticker(ticker)
    result = {"ticker": ticker, "history_rows": 0, "stats": False, "earnings": None, "logo": None, "error": None}
    with connect() as conn:
        ensure_ticker_metadata_columns(conn)
        meta = conn.execute("SELECT name FROM tickers WHERE ticker = ?", (ticker,)).fetchone()
    name = (meta["name"] if meta and meta["name"] else "")
    try:
        category = infer_category(ticker)
        rows = fetch_history_rows(category, ticker, period=f"{years}y")
        source = "fdr-history" if category == "kr" else "upbit-history" if category == "crypto" else "yf-history"
        if rows:
            result["history_rows"] = save_daily_prices(ticker, rows, source)
            last_date, _ = rows[-1]
            result["last_date"] = last_date
            result["technical_stats"] = refresh_technical_stats_cache([ticker])
    except Exception as exc:
        result["error"] = f"history: {exc}"

    try:
        with connect() as conn:
            fetch_fundamentals(conn, [ticker])
        result["stats"] = True
    except Exception as exc:
        result["stats_error"] = str(exc)

    try:
        category = infer_category(ticker)
        if category == "overseas":
            earnings = fetch_yahoo_earnings_date(ticker)
        elif category == "kr" and asset_class(ticker, name or "") == "stock":
            time.sleep(0.8)
            earnings = fetch_investing_kr_earnings_date(ticker)
        else:
            earnings = None
        update_earnings_dates([(ticker, earnings)])
        result["earnings"] = earnings
    except Exception as exc:
        result["earnings_error"] = str(exc)

    try:
        result["logo"] = cache_logo(ticker, name=name)
    except Exception as exc:
        result["logo_error"] = str(exc)

    try:
        result["stock_splits"] = refresh_stock_splits([ticker], force=True).get(ticker, 0)
    except Exception as exc:
        result["stock_splits_error"] = str(exc)

    return result


def estimate_hydration_minutes(count: int) -> int:
    return max(1, math.ceil(count * 0.6))

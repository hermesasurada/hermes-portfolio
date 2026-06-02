from __future__ import annotations

import math
import re
import time
from datetime import date

from .collectors import fetch_investing_kr_earnings_date, fetch_yahoo_earnings_date
from .constants import MARKET_INDEXES
from .db import connect, ensure_ticker_metadata_columns
from .fundamentals import fetch_fundamentals
from .logos import cache_logo
from .price_store import infer_category, save_daily_prices, update_earnings_dates, update_price_cache
from .technical_stats import refresh_technical_stats_cache
from .tickers import asset_class, normalize_yfinance_symbol, ticker_currency


def normalize_hydration_ticker(value: str) -> str:
    ticker = re.sub(r"\s+", "", str(value or "")).upper()
    if re.fullmatch(r"\d{6}", ticker):
        return f"{ticker}.KS"
    return ticker


def history_start_years(years: int = 5) -> str:
    today = date.today()
    return f"{today.year - years:04d}{today.month:02d}{today.day:02d}"


def fetch_history_rows(ticker: str, years: int = 5) -> tuple[list[tuple[str, float]], str]:
    category = infer_category(ticker)
    start = history_start_years(years)
    if category == "kr":
        from FinanceDataReader import DataReader as fdr

        df = fdr(ticker.replace(".KS", "").replace(".KQ", ""), start)
        source = "fdr-history"
    elif ticker == "KOSPI":
        from FinanceDataReader import DataReader as fdr

        df = fdr(MARKET_INDEXES[ticker]["symbol"], start)
        source = "fdr-index-history"
    else:
        import yfinance as yf

        symbol = normalize_yfinance_symbol(ticker) or ticker
        df = yf.Ticker(symbol).history(start=f"{start[:4]}-{start[4:6]}-{start[6:]}")
        source = "yf-history"
    if df is None or df.empty or "Close" not in df:
        return [], source
    rows = [
        (day.strftime("%Y-%m-%d"), float(value))
        for day, value in df["Close"].dropna().items()
    ]
    return rows, source


def hydrate_ticker(ticker: str, years: int = 5) -> dict:
    ticker = normalize_hydration_ticker(ticker)
    result = {"ticker": ticker, "history_rows": 0, "stats": False, "earnings": None, "logo": None, "error": None}
    with connect() as conn:
        ensure_ticker_metadata_columns(conn)
        meta = conn.execute("SELECT name, currency FROM tickers WHERE ticker = ?", (ticker,)).fetchone()
    currency = (meta["currency"] if meta and meta["currency"] else ticker_currency(ticker))
    name = (meta["name"] if meta and meta["name"] else "")
    try:
        rows, source = fetch_history_rows(ticker, years=years)
        if rows:
            result["history_rows"] = save_daily_prices(ticker, rows, source)
            last_date, last_price = rows[-1]
            update_price_cache([(ticker, last_price, currency, source)])
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
        result["logo"] = cache_logo(ticker)
    except Exception as exc:
        result["logo_error"] = str(exc)

    return result


def estimate_hydration_minutes(count: int) -> int:
    return max(1, math.ceil(count * 0.6))


def deficient_tickers(years: int = 5) -> list[str]:
    cutoff = f"{date.today().year - years:04d}-{date.today().month:02d}-{date.today().day:02d}"
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT t.ticker,
                   MIN(p.date) AS first_date,
                   COUNT(p.date) AS price_count,
                   sc.ticker AS stats_ticker
            FROM tickers t
            LEFT JOIN daily_prices p ON p.ticker = t.ticker
            LEFT JOIN ticker_stats_cache sc ON sc.ticker = t.ticker
            WHERE t.category NOT IN ('fx')
            GROUP BY t.ticker
            HAVING price_count = 0 OR first_date > ? OR stats_ticker IS NULL
            ORDER BY t.ticker
            """,
            (cutoff,),
        ).fetchall()
    return [row["ticker"] for row in rows]


def hydrate_deficient_tickers(years: int = 5) -> dict:
    tickers = deficient_tickers(years=years)
    return {"tickers": tickers, "hydration": [hydrate_ticker(ticker, years=years) for ticker in tickers]}

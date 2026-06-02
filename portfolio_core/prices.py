from __future__ import annotations

import sqlite3
from datetime import datetime

from .constants import FX_DEFAULT_RATES, FX_TICKERS
from .db import connect
from .paths import KST


def latest_prices(conn: sqlite3.Connection) -> dict[str, dict]:
    rows = conn.execute(
        """
        WITH latest AS (
            SELECT dp.ticker, dp.date, dp.close, dp.source
            FROM daily_prices dp
            JOIN (
                SELECT ticker, MAX(date) AS date
                FROM daily_prices INDEXED BY idx_daily_prices_ticker_date_desc
                WHERE close IS NOT NULL
                GROUP BY ticker
            ) latest_date
              ON latest_date.ticker = dp.ticker
             AND latest_date.date = dp.date
            WHERE dp.close IS NOT NULL
        )
        SELECT
            l.ticker,
            l.date,
            l.close,
            l.source,
            previous.date AS previous_date,
            previous.close AS previous_close
        FROM latest l
        LEFT JOIN daily_prices previous
          ON previous.rowid = (
            SELECT p.rowid
            FROM daily_prices AS p INDEXED BY idx_daily_prices_ticker_date_desc
            WHERE p.ticker = l.ticker
              AND p.close IS NOT NULL
              AND p.date < l.date
              AND ABS(p.close - l.close) > MAX(ABS(l.close) * 0.000001, 0.0001)
            ORDER BY p.date DESC
            LIMIT 1
          )
        ORDER BY l.ticker
        """
    ).fetchall()
    prices: dict[str, dict] = {}
    for row in rows:
        prices[row["ticker"]] = {
            "price": row["close"],
            "date": row["date"],
            "source": row["source"],
            "previous_price": row["previous_close"],
            "previous_date": row["previous_date"],
        }
    return prices


def fx_rates(prices: dict[str, dict]) -> dict[str, float]:
    return {
        currency: float(prices.get(ticker, {}).get("price") or FX_DEFAULT_RATES[currency])
        for currency, ticker in (("USD", "USDKRW"), ("EUR", "EURKRW"), ("JPY", "JPYKRW"))
    } | {
        "KRW": FX_DEFAULT_RATES["KRW"],
    }


def fx_previous_rates(prices: dict[str, dict]) -> dict[str, float]:
    return {
        currency: float(
            prices.get(ticker, {}).get("previous_price")
            or prices.get(ticker, {}).get("price")
            or FX_DEFAULT_RATES[currency]
        )
        for currency, ticker in (("USD", "USDKRW"), ("EUR", "EURKRW"), ("JPY", "JPYKRW"))
    } | {
        "KRW": FX_DEFAULT_RATES["KRW"],
    }


def fx_updated_at(prices: dict[str, dict]) -> str | None:
    dates = [
        prices.get(key, {}).get("date")
        for key in FX_TICKERS
        if prices.get(key, {}).get("date")
    ]
    return max(dates) if dates else None


def price_updated_at(prices: dict[str, dict]) -> str | None:
    dates = [
        info.get("date")
        for ticker, info in prices.items()
        if ticker not in FX_TICKERS and info.get("date")
    ]
    return max(dates) if dates else None


def price_cache_updated_at() -> str | None:
    try:
        with connect() as conn:
            row = conn.execute(
                """
                SELECT updated_at
                FROM collector_runs
                WHERE name = 'price'
                """
            ).fetchone()
    except sqlite3.OperationalError:
        return None
    raw = row["updated_at"] if row else None
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST)
        return dt.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")
    except ValueError:
        return raw

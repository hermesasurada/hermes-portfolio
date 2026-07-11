from __future__ import annotations

import sqlite3
from datetime import datetime

from .constants import FX_DEFAULT_RATES, FX_TICKERS
from .db import connect
from .paths import KST
from .us_live_quotes import apply_us_live_prices, us_market_status


def latest_prices(conn: sqlite3.Connection, tickers: list[str] | None = None) -> dict[str, dict]:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers or [] if ticker and ticker.strip()})
    ticker_filter = ""
    params: list[object] = []
    if clean_tickers:
        ticker_filter = f"AND ticker IN ({','.join('?' for _ in clean_tickers)})"
        params.extend(clean_tickers)
    rows = conn.execute(
        f"""
        WITH latest AS (
            SELECT dp.ticker, dp.date, dp.close, dp.source
            FROM daily_prices dp
            JOIN (
                SELECT ticker, MAX(date) AS date
                FROM daily_prices INDEXED BY idx_daily_prices_ticker_date_desc
                WHERE close IS NOT NULL
                  {ticker_filter}
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
        """,
        params,
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


def build_market_snapshot(
    prices: dict[str, dict],
    ticker_rows: list,
    include_extended: bool = False,
    market_status: dict | None = None,
) -> dict:
    status = market_status or us_market_status()
    live_meta = apply_us_live_prices(prices, ticker_rows, include_extended, status)
    return {
        "prices": prices,
        "rates": fx_rates(prices),
        "previous_rates": fx_previous_rates(prices),
        "market_status": {**status, **live_meta},
    }


def price_view(
    ticker: str,
    currency: str,
    snapshot: dict,
) -> dict:
    prices = snapshot["prices"]
    rates = snapshot["rates"]
    previous_rates = snapshot["previous_rates"]
    current = prices.get(ticker, {})
    current_price = current.get("price")
    previous_price = current.get("previous_price")
    regular_price = current.get("regular_price")
    regular_previous_price = current.get("regular_previous_price")
    change = None
    change_pct = None
    change_krw_pct = None
    if current_price is not None and previous_price not in (None, 0):
        change = float(current_price) - float(previous_price)
        change_pct = change / float(previous_price) * 100
    if regular_price is not None and regular_previous_price not in (None, 0):
        change_pct = (float(regular_price) - float(regular_previous_price)) / float(regular_previous_price) * 100

    rate = rates.get(currency, 1.0)
    previous_rate = previous_rates.get(currency, rate)
    change_price = regular_price if regular_price is not None else current_price
    change_previous = regular_previous_price if regular_previous_price is not None else previous_price
    if change_price is not None and change_previous not in (None, 0) and previous_rate not in (None, 0):
        previous_krw_price = float(change_previous) * float(previous_rate)
        current_krw_price = float(change_price) * float(rate)
        if currency != "KRW" and previous_krw_price:
            change_krw_pct = (current_krw_price - previous_krw_price) / previous_krw_price * 100

    return {
        "price_record": current,
        "current_price": current_price,
        "previous_price": previous_price,
        "change": change,
        "change_pct": change_pct,
        "change_krw_pct": change_krw_pct,
        "fx_rate": rate,
        "previous_fx_rate": previous_rate,
    }


def _fx_pairs() -> tuple[tuple[str, str], ...]:
    # FX_TICKERS 기반 (USDKRW→USD …). 새 통화 추가 시 자동 반영.
    return tuple((ticker[:-3], ticker) for ticker in FX_TICKERS if ticker.endswith("KRW"))


def fx_rates(prices: dict[str, dict]) -> dict[str, float]:
    return {
        currency: float(prices.get(ticker, {}).get("price") or FX_DEFAULT_RATES[currency])
        for currency, ticker in _fx_pairs()
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
        for currency, ticker in _fx_pairs()
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

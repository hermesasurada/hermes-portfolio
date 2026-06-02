from __future__ import annotations

import json
import logging
import sqlite3
import threading
import urllib.request
from datetime import datetime
from urllib.parse import quote

from .constants import FX_DEFAULT_RATES, FX_TICKERS
from .paths import KST, PRICE_CACHE_PATH, US_EASTERN
from .tickers import is_us_stock_ticker, ticker_currency

US_LIVE_CACHE_SECONDS = 600
US_LIVE_QUOTE_CACHE: dict[tuple[str, str], dict] = {}
US_LIVE_QUOTE_LOCK = threading.Lock()


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


def us_market_status() -> dict:
    now_et = datetime.now(US_EASTERN)
    minutes = now_et.hour * 60 + now_et.minute
    regular_start = 9 * 60 + 30
    regular_end = 16 * 60
    is_weekday = now_et.weekday() < 5
    is_regular = is_weekday and regular_start <= minutes < regular_end
    return {
        "is_regular": is_regular,
        "now_et": now_et.strftime("%Y-%m-%d %H:%M ET"),
        "label": "정규장" if is_regular else "장외",
        "cache_seconds": US_LIVE_CACHE_SECONDS,
    }


def yahoo_quote_batch(symbols: list[str]) -> dict[str, dict]:
    if not symbols:
        return {}
    fields = ",".join(
        [
            "symbol",
            "marketState",
            "regularMarketPrice",
            "regularMarketPreviousClose",
            "preMarketPrice",
            "postMarketPrice",
            "regularMarketTime",
            "preMarketTime",
            "postMarketTime",
        ]
    )
    url = (
        "https://query1.finance.yahoo.com/v7/finance/quote"
        f"?symbols={quote(','.join(symbols))}&fields={quote(fields)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    results = payload.get("quoteResponse", {}).get("result", [])
    return {str(item.get("symbol", "")).upper(): item for item in results if item.get("symbol")}


def extended_quote_pick(quote_row: dict) -> tuple[float | None, str | None]:
    """Select the pre/post-market price and its source label from a Yahoo quote row.

    Prefers the price matching the reported marketState, then falls back to whichever
    extended price (pre, then post) is present.
    """
    market_state = str(quote_row.get("marketState") or "").upper()
    pre = quote_row.get("preMarketPrice")
    post = quote_row.get("postMarketPrice")
    if market_state == "PRE" and pre:
        return float(pre), "yf-pre"
    if market_state in {"POST", "POSTPOST"} and post:
        return float(post), "yf-after"
    if pre:
        return float(pre), "yf-pre"
    if post:
        return float(post), "yf-after"
    return None, None


def live_price_from_quote(quote_row: dict, include_extended: bool, regular_hours: bool) -> tuple[float | None, str | None]:
    if include_extended and not regular_hours:
        price, source = extended_quote_pick(quote_row)
        if price is not None:
            return price, source
    if quote_row.get("regularMarketPrice"):
        return float(quote_row["regularMarketPrice"]), "yf-live"
    return None, None


def extended_change_from_quote(quote_row: dict, regular_hours: bool) -> dict:
    if regular_hours:
        return {}
    extended_price, source = extended_quote_pick(quote_row)
    base_price = quote_row.get("regularMarketPrice") or quote_row.get("regularMarketPreviousClose")
    if extended_price is None or not base_price:
        return {}
    base_price = float(base_price)
    if base_price == 0:
        return {}
    change = extended_price - base_price
    return {
        "extended_price": extended_price,
        "extended_base_price": base_price,
        "extended_change": change,
        "extended_change_pct": change / base_price * 100,
        "extended_source": source,
    }


def regular_change_from_quote(quote_row: dict) -> dict:
    regular_price = quote_row.get("regularMarketPrice")
    previous_close = quote_row.get("regularMarketPreviousClose")
    if regular_price in (None, 0) or previous_close in (None, 0):
        return {}
    regular_price = float(regular_price)
    previous_close = float(previous_close)
    change = regular_price - previous_close
    return {
        "regular_price": regular_price,
        "regular_previous_price": previous_close,
        "regular_change": change,
        "regular_change_pct": change / previous_close * 100,
    }


def fetch_us_live_quotes(symbols: list[str], include_extended: bool, regular_hours: bool) -> dict[str, dict]:
    mode = "regular" if regular_hours else "extended"
    now_ts = datetime.now().timestamp()
    fresh: dict[str, dict] = {}
    stale: dict[str, dict] = {}
    missing: list[str] = []
    with US_LIVE_QUOTE_LOCK:
        for symbol in symbols:
            cache_key = (symbol, mode)
            cached = US_LIVE_QUOTE_CACHE.get(cache_key)
            if cached and now_ts - cached.get("fetched_ts", 0) < US_LIVE_CACHE_SECONDS:
                fresh[symbol] = cached
            else:
                if cached:
                    stale[symbol] = cached
                missing.append(symbol)

    if missing:
        try:
            quote_rows = yahoo_quote_batch(missing)
            for symbol in missing:
                quote_row = quote_rows.get(symbol.upper(), {})
                price, source = live_price_from_quote(quote_row, include_extended, regular_hours)
                if price is None:
                    continue
                item = {
                    "price": price,
                    "source": source,
                    "market_state": quote_row.get("marketState"),
                    "fetched_ts": now_ts,
                    **regular_change_from_quote(quote_row),
                    **extended_change_from_quote(quote_row, regular_hours),
                }
                with US_LIVE_QUOTE_LOCK:
                    US_LIVE_QUOTE_CACHE[(symbol, mode)] = item
                fresh[symbol] = item
        except Exception as exc:
            logging.warning(
                "[us-live] batch quote failed for %d symbols; using stale cache/db prices: %s",
                len(missing),
                exc,
            )
            fresh.update(stale)
    return fresh


def apply_us_live_prices(prices: dict[str, dict], ticker_rows: list[sqlite3.Row], include_extended: bool, regular_hours: bool) -> dict:
    use_live = regular_hours or include_extended
    us_tickers = [
        row["ticker"]
        for row in ticker_rows
        if is_us_stock_ticker(row["ticker"], row["currency"] or ticker_currency(row["ticker"]))
    ]
    meta = {
        "is_regular": regular_hours,
        "include_extended": bool(include_extended and not regular_hours),
        "use_live": use_live,
        "live_count": 0,
        "us_ticker_count": len(us_tickers),
    }
    if not us_tickers:
        return meta
    live_quotes = fetch_us_live_quotes(us_tickers, include_extended or not regular_hours, regular_hours)
    market_today = datetime.now(US_EASTERN).strftime("%Y-%m-%d")
    for ticker, live in live_quotes.items():
        current = prices.get(ticker)
        if current:
            for key in (
                "regular_price",
                "regular_previous_price",
                "regular_change",
                "regular_change_pct",
                "extended_price",
                "extended_base_price",
                "extended_change",
                "extended_change_pct",
                "extended_source",
            ):
                if live.get(key) is not None:
                    current[key] = live.get(key)
            if live.get("market_state") is not None:
                current["extended_market_state"] = live.get("market_state")
        elif live.get("extended_price") is not None:
            prices[ticker] = {
                "price": None,
                "date": market_today,
                "source": None,
                "market_state": live.get("market_state"),
                "previous_price": None,
                "previous_date": None,
                "regular_price": live.get("regular_price"),
                "regular_previous_price": live.get("regular_previous_price"),
                "regular_change": live.get("regular_change"),
                "regular_change_pct": live.get("regular_change_pct"),
                "extended_price": live.get("extended_price"),
                "extended_base_price": live.get("extended_base_price"),
                "extended_change": live.get("extended_change"),
                "extended_change_pct": live.get("extended_change_pct"),
                "extended_source": live.get("extended_source"),
                "extended_market_state": live.get("market_state"),
            }
            current = prices[ticker]
        if not use_live:
            continue
        live_price = live.get("price")
        if live_price is None:
            continue
        if current:
            regular_close = current.get("price")
            regular_date = current.get("date")
            if regular_date == market_today and current.get("previous_price") is not None:
                previous_price = current.get("previous_price")
                previous_date = current.get("previous_date")
            else:
                previous_price = regular_close
                previous_date = regular_date
            current["previous_price"] = previous_price
            current["previous_date"] = previous_date
            current["price"] = live_price
            current["date"] = market_today
            current["source"] = live.get("source") or "yf-live"
            current["market_state"] = live.get("market_state")
        else:
            prices[ticker] = {
                "price": live_price,
                "date": market_today,
                "source": live.get("source") or "yf-live",
                "market_state": live.get("market_state"),
                "previous_price": None,
                "previous_date": None,
            }
        meta["live_count"] += 1
    return meta


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
    if not PRICE_CACHE_PATH.exists():
        return None
    try:
        raw = json.loads(PRICE_CACHE_PATH.read_text()).get("updated")
        if not raw:
            return None
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST)
        return dt.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")
    except Exception:
        return None

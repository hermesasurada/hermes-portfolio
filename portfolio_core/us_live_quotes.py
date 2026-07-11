from __future__ import annotations

import http.cookiejar
import json
import logging
import sqlite3
import threading
import urllib.error
import urllib.request
from datetime import datetime
from urllib.parse import quote

from .db import connect
from .market_calendar import us_equity_market_status
from .paths import US_EASTERN
from .tickers import is_us_stock_ticker, ticker_currency

# 배치 1회로 전 종목 시세를 받으므로(크럼 인증) 짧게 잡아도 외부 요청은 분당 1회 수준.
US_LIVE_CACHE_SECONDS = 60
SHARED_LIVE_CACHE_SECONDS = 90
US_LIVE_QUOTE_CACHE: dict[tuple[str, str], dict] = {}
US_LIVE_QUOTE_LOCK = threading.Lock()
US_LIVE_FALLBACK_IN_FLIGHT: set[tuple[str, str]] = set()

# Yahoo 크럼+쿠키 세션 (yfinance 내부 방식). 발급 비용이 있으니 캐시·재사용.
YAHOO_CRUMB_LOCK = threading.Lock()
_YAHOO_OPENER: urllib.request.OpenerDirector | None = None
_YAHOO_CRUMB: str | None = None


def _build_yahoo_session() -> tuple[urllib.request.OpenerDirector, str]:
    """fc.yahoo.com에서 A1 쿠키를 받고 getcrumb로 크럼 토큰을 발급한다.
    v7/quote가 인증을 요구하도록 바뀐 뒤 배치를 되살리는 유일한 방법."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]
    try:  # 404를 내지만 Set-Cookie(A1/A3)는 응답 헤더에서 적재됨
        opener.open("https://fc.yahoo.com", timeout=8).read()
    except urllib.error.HTTPError:
        pass
    with opener.open("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=8) as resp:
        crumb = resp.read().decode("utf-8").strip()
    if not crumb or "<" in crumb:
        raise RuntimeError("failed to obtain Yahoo crumb")
    return opener, crumb


def _yahoo_session(force: bool = False) -> tuple[urllib.request.OpenerDirector, str]:
    global _YAHOO_OPENER, _YAHOO_CRUMB
    with YAHOO_CRUMB_LOCK:
        if force or _YAHOO_OPENER is None or not _YAHOO_CRUMB:
            _YAHOO_OPENER, _YAHOO_CRUMB = _build_yahoo_session()
        return _YAHOO_OPENER, _YAHOO_CRUMB


def us_market_status() -> dict:
    return {
        **us_equity_market_status(),
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
    base = (
        "https://query1.finance.yahoo.com/v7/finance/quote"
        f"?symbols={quote(','.join(symbols))}&fields={quote(fields)}"
    )

    def _call(opener: urllib.request.OpenerDirector, crumb: str) -> dict:
        with opener.open(f"{base}&crumb={quote(crumb)}", timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))

    opener, crumb = _yahoo_session()
    try:
        payload = _call(opener, crumb)
    except urllib.error.HTTPError as exc:
        if exc.code not in (401, 403):
            raise
        opener, crumb = _yahoo_session(force=True)  # 크럼 만료 → 1회만 재발급 후 재시도
        payload = _call(opener, crumb)
    results = payload.get("quoteResponse", {}).get("result", [])
    return {str(item.get("symbol", "")).upper(): item for item in results if item.get("symbol")}


def extended_quote_pick(quote_row: dict) -> tuple[float | None, str | None]:
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


def live_quote_item_from_row(
    quote_row: dict,
    include_extended: bool,
    regular_hours: bool,
    fetched_ts: float,
) -> dict | None:
    price, source = live_price_from_quote(quote_row, include_extended, regular_hours)
    if price is None:
        return None
    return {
        "price": price,
        "source": source or "yf-live",
        "market_state": quote_row.get("marketState"),
        "fetched_ts": fetched_ts,
        **regular_change_from_quote(quote_row),
        **extended_change_from_quote(quote_row, regular_hours),
    }


def cache_us_live_quote(symbol: str, mode: str, item: dict) -> None:
    with US_LIVE_QUOTE_LOCK:
        US_LIVE_QUOTE_CACHE[(symbol, mode)] = item


def load_shared_quote_rows(symbols: list[str], max_age_seconds: int = SHARED_LIVE_CACHE_SECONDS) -> dict[str, dict]:
    clean = sorted({symbol.upper() for symbol in symbols if symbol})
    if not clean:
        return {}
    placeholders = ",".join("?" for _ in clean)
    cutoff = datetime.now().timestamp() - max_age_seconds
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT ticker, fetched_ts, payload_json
            FROM ticker_live_quotes
            WHERE ticker IN ({placeholders}) AND fetched_ts >= ?
            """,
            [*clean, cutoff],
        ).fetchall()
    result: dict[str, dict] = {}
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        payload["_shared_fetched_ts"] = float(row["fetched_ts"])
        result[row["ticker"].upper()] = payload
    return result


def schedule_us_live_fallback(symbols: list[str], mode: str, include_extended: bool, regular_hours: bool) -> None:
    unique_symbols = sorted({symbol.upper() for symbol in symbols if symbol})
    if not unique_symbols:
        return
    todo: list[str] = []
    with US_LIVE_QUOTE_LOCK:
        for symbol in unique_symbols:
            key = (symbol, mode)
            if key in US_LIVE_FALLBACK_IN_FLIGHT:
                continue
            US_LIVE_FALLBACK_IN_FLIGHT.add(key)
            todo.append(symbol)
    if not todo:
        return
    threading.Thread(
        target=fetch_us_live_fallback_worker,
        args=(todo, mode, include_extended, regular_hours),
        daemon=True,
    ).start()


def fetch_us_live_fallback_worker(symbols: list[str], mode: str, include_extended: bool, regular_hours: bool) -> None:
    updated = 0
    try:
        import yfinance as yf

        for symbol in symbols:
            try:
                info = yf.Ticker(symbol).info or {}
                item = live_quote_item_from_row(info, include_extended, regular_hours, datetime.now().timestamp())
                if not item:
                    continue
                cache_us_live_quote(symbol, mode, item)
                updated += 1
            except Exception as exc:
                logging.warning("[us-live] yfinance fallback failed for %s: %s", symbol, exc)
        logging.info("[us-live] yfinance fallback refreshed %d/%d symbols", updated, len(symbols))
    except Exception as exc:
        logging.warning("[us-live] yfinance fallback worker failed: %s", exc)
    finally:
        with US_LIVE_QUOTE_LOCK:
            for symbol in symbols:
                US_LIVE_FALLBACK_IN_FLIGHT.discard((symbol, mode))


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
        shared_rows = load_shared_quote_rows(missing)
        still_missing: list[str] = []
        for symbol in missing:
            quote_row = shared_rows.get(symbol.upper())
            if not quote_row:
                still_missing.append(symbol)
                continue
            item = live_quote_item_from_row(
                quote_row,
                include_extended,
                regular_hours,
                float(quote_row.get("_shared_fetched_ts") or now_ts),
            )
            if not item:
                still_missing.append(symbol)
                continue
            cache_us_live_quote(symbol, mode, item)
            fresh[symbol] = item
        missing = still_missing

    if missing:
        try:
            quote_rows = yahoo_quote_batch(missing)
            unresolved: list[str] = []
            for symbol in missing:
                quote_row = quote_rows.get(symbol.upper(), {})
                item = live_quote_item_from_row(quote_row, include_extended, regular_hours, now_ts)
                if not item:
                    unresolved.append(symbol)
                    continue
                cache_us_live_quote(symbol, mode, item)
                fresh[symbol] = item
            schedule_us_live_fallback(unresolved, mode, include_extended, regular_hours)
        except Exception as exc:
            logging.warning(
                "[us-live] batch quote failed for %d symbols; using stale cache/db prices and refreshing in background: %s",
                len(missing),
                exc,
            )
            fresh.update(stale)
            schedule_us_live_fallback(missing, mode, include_extended, regular_hours)
    return fresh


def apply_us_live_prices(
    prices: dict[str, dict],
    ticker_rows: list[sqlite3.Row],
    include_extended: bool,
    market_status: dict,
) -> dict:
    regular_hours = bool(market_status.get("is_regular"))
    is_closed = bool(market_status.get("is_closed"))
    use_live = (regular_hours or include_extended) and not is_closed
    us_tickers = [
        row["ticker"]
        for row in ticker_rows
        if is_us_stock_ticker(row["ticker"], row["currency"] or ticker_currency(row["ticker"]))
    ]
    meta = {
        "is_regular": regular_hours,
        "is_closed": is_closed,
        "include_extended": bool(include_extended and not regular_hours and not is_closed),
        "use_live": use_live,
        "live_count": 0,
        "us_ticker_count": len(us_tickers),
    }
    if not us_tickers or is_closed:
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

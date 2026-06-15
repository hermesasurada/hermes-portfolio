from __future__ import annotations

import html
import json
import math
import re
import sqlite3
import urllib.request
from datetime import datetime
from urllib.parse import quote

from .paths import KST
from .tickers import is_korean_stock_ticker, kr_ticker_code, normalize_yfinance_symbol

STATS_CACHE_SECONDS = 30 * 60
STATS_CACHE_VERSION = 7
PB_SANITY_MAX = 300  # P/B가 이 값 초과면 데이터 오류로 간주(공란)


def finite_number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def stats_cache_expires_today() -> bool:
    return datetime.now(KST).weekday() < 5


def load_stats_cache_item(conn: sqlite3.Connection, ticker: str, now_ts: float, fresh_only: bool = True) -> dict | None:
    row = conn.execute(
        """
        SELECT version, fetched_ts, source, market_cap, dividend_yield, trailing_pe, forward_pe, price_to_book, next_earnings_date
        FROM ticker_stats_cache
        WHERE ticker = ?
        """,
        (ticker,),
    ).fetchone()
    if not row:
        return None
    if int(row["version"] or 0) != STATS_CACHE_VERSION:
        return None
    if row["source"] == "unknown":
        return None
    if fresh_only and stats_cache_expires_today() and now_ts - float(row["fetched_ts"] or 0) >= STATS_CACHE_SECONDS:
        return None
    return {
        "market_cap": finite_number(row["market_cap"]),
        "dividend_yield": finite_number(row["dividend_yield"]),
        "trailing_pe": normalize_pe(row["trailing_pe"]),
        "forward_pe": normalize_pe(row["forward_pe"]),
        "price_to_book": normalize_pe(row["price_to_book"]),
        "next_earnings_date": row["next_earnings_date"],
    }


def save_stats_cache_item(conn: sqlite3.Connection, ticker: str, source: str, data: dict, raw: dict | None = None) -> None:
    conn.execute(
        """
        INSERT INTO ticker_stats_cache
          (ticker, version, fetched_ts, fetched_at, source, market_cap, dividend_yield, trailing_pe, forward_pe, price_to_book, next_earnings_date, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
          version = excluded.version,
          fetched_ts = excluded.fetched_ts,
          fetched_at = excluded.fetched_at,
          source = excluded.source,
          market_cap = excluded.market_cap,
          dividend_yield = excluded.dividend_yield,
          trailing_pe = excluded.trailing_pe,
          forward_pe = excluded.forward_pe,
          price_to_book = excluded.price_to_book,
          next_earnings_date = excluded.next_earnings_date,
          raw_json = excluded.raw_json
        """,
        (
            ticker,
            STATS_CACHE_VERSION,
            datetime.now().timestamp(),
            datetime.now(KST).isoformat(timespec="seconds"),
            source,
            finite_number(data.get("market_cap")),
            finite_number(data.get("dividend_yield")),
            normalize_pe(data.get("trailing_pe")),
            normalize_pe(data.get("forward_pe")),
            normalize_pe(data.get("price_to_book")),
            data.get("next_earnings_date"),
            json.dumps(raw or {}, ensure_ascii=False, default=str),
        ),
    )


def parse_number(text: str | None) -> float | None:
    if text is None:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", html.unescape(str(text)))
    if cleaned in {"", "-", ".", "-."}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def normalize_pe(value) -> float | None:
    number = finite_number(value)
    if number is None:
        return None
    return number if number > 0 else None


def fetch_naver_fundamentals(ticker: str) -> tuple[dict, dict]:
    code = kr_ticker_code(ticker)
    url = f"https://stock.naver.com/api/domestic/detail/{quote(code)}/detail?codeType=KRX"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        obj = json.loads(resp.read().decode("utf-8"))
    if obj.get("type") == "EF":
        return {
            "market_cap": None,
            "dividend_yield": None,
            "trailing_pe": None,
            "forward_pe": None,
            "next_earnings_date": None,
        }, obj
    now_price = parse_number(obj.get("nowPrice"))
    dividend_amount = parse_number(obj.get("dividendAmount"))
    dividend_yield = dividend_amount / now_price * 100 if dividend_amount is not None and now_price not in (None, 0) else None
    return {
        "market_cap": parse_number(obj.get("marketSum")),
        "dividend_yield": dividend_yield,
        "trailing_pe": normalize_pe(parse_number(obj.get("per"))),
        "forward_pe": normalize_pe(parse_number(obj.get("estimatedPer"))),
        "price_to_book": normalize_pe(parse_number(obj.get("pbr"))),  # PBR = P/B
        "next_earnings_date": None,
    }, obj


def fetch_fundamentals(conn: sqlite3.Connection, tickers: list[str], refresh_stale: bool = True) -> dict[str, dict]:
    earnings_by_ticker = {
        row["ticker"]: row["next_earnings_date"]
        for row in conn.execute(
            """
            SELECT ticker, next_earnings_date
            FROM tickers
            WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''
            """
        ).fetchall()
    }
    now_ts = datetime.now().timestamp()
    result: dict[str, dict] = {}
    for ticker in tickers:
        cached = load_stats_cache_item(conn, ticker, now_ts)
        if cached:
            cached["next_earnings_date"] = earnings_by_ticker.get(ticker)
            result[ticker] = cached
            continue
        stale = load_stats_cache_item(conn, ticker, now_ts, fresh_only=False)
        if stale:
            stale["next_earnings_date"] = earnings_by_ticker.get(ticker)
            if not refresh_stale:
                result[ticker] = stale
                continue
        elif not refresh_stale:
            result[ticker] = {"next_earnings_date": earnings_by_ticker.get(ticker)}
            continue
        data: dict = {}
        source = "unknown"
        raw: dict | None = None
        fetched = False
        try:
            if is_korean_stock_ticker(ticker):
                data, raw = fetch_naver_fundamentals(ticker)
                source = "naver"
                fetched = True
            else:
                symbol = normalize_yfinance_symbol(ticker)
                if symbol:
                    import yfinance as yf

                    info = yf.Ticker(symbol).info or {}
                    dividend_yield = info.get("dividendYield")
                    if dividend_yield is None:
                        dividend_yield = info.get("trailingAnnualDividendYield")
                    # yfinance는 거래통화 != 재무통화(ADR·해외기업)일 때 주당순자산
                    # (bookValue)을 잘못 환산해 P/B가 비현실적으로 폭발한다
                    # (예: ASML 1500, TSM 65). 통화 불일치/이상치는 신뢰 불가 → 공란.
                    price_to_book = normalize_pe(info.get("priceToBook"))
                    trading_ccy = info.get("currency")
                    financial_ccy = info.get("financialCurrency")
                    if price_to_book is not None and trading_ccy and financial_ccy and trading_ccy != financial_ccy:
                        price_to_book = None
                    if price_to_book is not None and price_to_book > PB_SANITY_MAX:
                        price_to_book = None
                    data = {
                        "market_cap": finite_number(info.get("marketCap")),
                        "dividend_yield": finite_number(dividend_yield),
                        "trailing_pe": normalize_pe(info.get("trailingPE")),
                        "forward_pe": normalize_pe(info.get("forwardPE")),
                        "price_to_book": price_to_book,
                        "next_earnings_date": earnings_by_ticker.get(ticker),
                    }
                    source = "yfinance"
                    raw = {"info": info}
                    fetched = True
        except Exception as exc:
            print(f"[stats] fundamentals failed for {ticker}: {exc}")
            if stale:
                result[ticker] = stale
                continue
        if fetched:
            data["next_earnings_date"] = earnings_by_ticker.get(ticker)
            save_stats_cache_item(conn, ticker, source, data, raw)
            # 펀더멘털 네트워크 조회는 종목 수에 따라 오래 걸린다. 종목별로
            # 커밋해 분 단위 가격 스냅샷의 SQLite 쓰기를 장시간 막지 않는다.
            conn.commit()
        result[ticker] = data
    conn.commit()
    return result

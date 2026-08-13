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
from .tickers import asset_class, is_korean_stock_ticker, kr_ticker_code, normalize_yfinance_symbol

STATS_CACHE_SECONDS = 30 * 60
STATS_CACHE_VERSION = 8
PB_SANITY_MAX = 300  # P/B가 이 값 초과면 데이터 오류로 간주(공란)

YFINANCE_PROFILE_FIELDS = {
    "gross_margin": "grossMargins",
    "operating_margin": "operatingMargins",
    "ebitda_margin": "ebitdaMargins",
    "profit_margin": "profitMargins",
    "return_on_assets": "returnOnAssets",
    "return_on_equity": "returnOnEquity",
    "revenue_growth": "revenueGrowth",
    "earnings_growth": "earningsGrowth",
    "earnings_quarterly_growth": "earningsQuarterlyGrowth",
    "debt_to_equity": "debtToEquity",
    "free_cash_flow": "freeCashflow",
    "payout_ratio": "payoutRatio",
    "short_percent_float": "shortPercentOfFloat",
    "short_percent_shares": "sharesPercentSharesOut",
    "short_ratio": "shortRatio",
    "insider_ownership": "heldPercentInsiders",
    "institutional_ownership": "heldPercentInstitutions",
}


def finite_number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def dividend_yield_from_run_rate(annualized_run_rate, current_price) -> float | None:
    """연환산 주당배당과 현재가로 배당수익률(%)을 계산한다."""
    annualized = finite_number(annualized_run_rate)
    price = finite_number(current_price)
    if annualized is None or annualized <= 0 or price is None or price <= 0:
        return None
    return annualized / price * 100


def history_backed_dividend_yield(
    conn: sqlite3.Connection,
    ticker: str,
    current_price=None,
) -> float | None:
    """한국 종목의 시세 원천이 배당값을 비워도 수집된 배당이력으로 보완한다.

    배당이력의 귀속연도·지급주기·특별배당 판정은 dividends 모듈의 기존
    연환산 로직을 그대로 사용한다. 따라서 단순히 최근 지급액을 4배 하는
    것보다 연배당·반기배당과 확정된 향후 배당을 정확히 반영한다.
    """
    if not is_korean_stock_ticker(ticker):
        return None
    price = finite_number(current_price)
    if price is None or price <= 0:
        try:
            row = conn.execute(
                """
                SELECT close
                FROM daily_prices
                WHERE ticker = ? AND close IS NOT NULL AND close > 0
                ORDER BY date DESC
                LIMIT 1
                """,
                (ticker,),
            ).fetchone()
        except sqlite3.Error:
            row = None
        price = finite_number(row["close"]) if row else None
    if price is None or price <= 0:
        return None
    try:
        # 순환 import를 피하고, 배당이력이 필요한 누락 종목에만 로드한다.
        from .dividends import load_dividend_history

        summary = load_dividend_history(ticker).get("summary") or {}
    except (KeyError, TypeError, ValueError, sqlite3.Error):
        return None
    return dividend_yield_from_run_rate(summary.get("annualized_run_rate"), price)


def apply_history_dividend_yield(
    conn: sqlite3.Connection,
    ticker: str,
    data: dict,
    current_price=None,
) -> dict:
    if finite_number(data.get("dividend_yield")) is not None:
        return data
    derived = history_backed_dividend_yield(conn, ticker, current_price)
    if derived is None:
        return data
    result = dict(data)
    result["dividend_yield"] = derived
    return result


def _yfinance_info(raw: dict | str | None) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    return raw.get("info") if isinstance(raw.get("info"), dict) else raw


def yfinance_dividend_yield(raw: dict | str | None) -> float | None:
    """Yahoo 배당률을 정규화하고 거래·재무통화 혼합 오류를 제거한다.

    해외기업의 신규 미국 상장 종목은 거래가격은 USD인데 기존 본주 배당금은
    재무통화로 남는 경우가 있다. 이때 연간배당금이 거래가격보다 커지는 명백한
    단위 불일치는 Yahoo가 계산한 배당률도 신뢰하지 않는다(SKHY 회귀 사례).
    """
    info = _yfinance_info(raw)
    dividend_yield = info.get("dividendYield")
    if dividend_yield is None:
        dividend_yield = info.get("trailingAnnualDividendYield")

    trading_currency = str(info.get("currency") or "").strip().upper()
    financial_currency = str(info.get("financialCurrency") or "").strip().upper()
    annual_rate = finite_number(info.get("trailingAnnualDividendRate"))
    trading_price = finite_number(
        info.get("currentPrice")
        or info.get("regularMarketPrice")
        or info.get("regularMarketPreviousClose")
        or info.get("previousClose")
    )
    if (
        trading_currency
        and financial_currency
        and trading_currency != financial_currency
        and annual_rate is not None
        and trading_price is not None
        and trading_price > 0
        and annual_rate > trading_price
    ):
        return None
    return finite_number(dividend_yield)


def yfinance_profile_metrics(raw: dict | str | None) -> dict:
    """관심목록 전용 기업 프로필 지표를 yfinance info에서 정규화한다.

    캐시의 raw_json(문자열)과 신규 수집 직후 info(dict)를 모두 받아 기존
    캐시도 재수집 없이 바로 사용할 수 있게 한다.
    """
    info = _yfinance_info(raw)
    result = {
        field: finite_number(info.get(source_field))
        for field, source_field in YFINANCE_PROFILE_FIELDS.items()
    }
    financial_currency = str(info.get("financialCurrency") or "").strip().upper()
    result["financial_currency"] = financial_currency or None
    # 캐시의 과거 배당률도 raw_json을 기준으로 다시 검증해 즉시 교정한다.
    result["dividend_yield"] = yfinance_dividend_yield(info)
    return result


def stats_cache_expires_today() -> bool:
    return datetime.now(KST).weekday() < 5


def load_stats_cache_item(conn: sqlite3.Connection, ticker: str, now_ts: float, fresh_only: bool = True) -> dict | None:
    row = conn.execute(
        """
        SELECT version, fetched_ts, source, market_cap, aum, dividend_yield, dividend_growth_5y,
               trailing_pe, forward_pe, price_to_book, next_earnings_date, raw_json
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
    result = {
        "market_cap": finite_number(row["market_cap"]),
        "aum": finite_number(row["aum"]),
        "dividend_yield": finite_number(row["dividend_yield"]),
        "dividend_growth_5y": finite_number(row["dividend_growth_5y"]),
        "trailing_pe": normalize_pe(row["trailing_pe"]),
        "forward_pe": normalize_pe(row["forward_pe"]),
        "price_to_book": normalize_pe(row["price_to_book"]),
        "next_earnings_date": row["next_earnings_date"],
    }
    if row["source"] == "yfinance":
        result.update(yfinance_profile_metrics(row["raw_json"]))
    return result


def load_stats_cache_items(
    conn: sqlite3.Connection,
    tickers: list[str],
    now_ts: float,
    fresh_only: bool = True,
) -> dict[str, dict]:
    clean = sorted({ticker for ticker in tickers if ticker})
    if not clean:
        return {}
    marks = ",".join("?" for _ in clean)
    rows = conn.execute(
        f"""
        SELECT ticker, version, fetched_ts, source, market_cap, aum, dividend_yield, dividend_growth_5y,
               trailing_pe, forward_pe, price_to_book, next_earnings_date, raw_json
        FROM ticker_stats_cache
        WHERE ticker IN ({marks})
        """,
        clean,
    ).fetchall()
    result: dict[str, dict] = {}
    for row in rows:
        if int(row["version"] or 0) != STATS_CACHE_VERSION or row["source"] == "unknown":
            continue
        if fresh_only and stats_cache_expires_today() and now_ts - float(row["fetched_ts"] or 0) >= STATS_CACHE_SECONDS:
            continue
        item = {
            "market_cap": finite_number(row["market_cap"]),
            "aum": finite_number(row["aum"]),
            "dividend_yield": finite_number(row["dividend_yield"]),
            "dividend_growth_5y": finite_number(row["dividend_growth_5y"]),
            "trailing_pe": normalize_pe(row["trailing_pe"]),
            "forward_pe": normalize_pe(row["forward_pe"]),
            "price_to_book": normalize_pe(row["price_to_book"]),
            "next_earnings_date": row["next_earnings_date"],
        }
        if row["source"] == "yfinance":
            item.update(yfinance_profile_metrics(row["raw_json"]))
        result[row["ticker"]] = item
    return result


def save_stats_cache_item(conn: sqlite3.Connection, ticker: str, source: str, data: dict, raw: dict | None = None) -> None:
    conn.execute(
        """
        INSERT INTO ticker_stats_cache
          (ticker, version, fetched_ts, fetched_at, source, market_cap, aum, dividend_yield, trailing_pe, forward_pe, price_to_book, next_earnings_date, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
          version = excluded.version,
          fetched_ts = excluded.fetched_ts,
          fetched_at = excluded.fetched_at,
          source = excluded.source,
          market_cap = excluded.market_cap,
          aum = excluded.aum,
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
            finite_number(data.get("aum")),
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
            "aum": parse_number(obj.get("marketSum")),
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
        "aum": None,
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
    ticker_meta = {
        row["ticker"]: {
            "name": row["name"] or row["ticker"],
            "category": row["category"],
            "currency": row["currency"],
        }
        for row in conn.execute(
            """
            SELECT ticker, COALESCE(NULLIF(display_name, ''), name, ticker) AS name, category, currency
            FROM tickers
            WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''
            """
        ).fetchall()
    }
    now_ts = datetime.now().timestamp()
    cached_items = load_stats_cache_items(conn, tickers, now_ts)
    # Read-only API requests must keep serving the last collected fundamentals
    # after the refresh TTL expires. The collector owns refreshing stale rows.
    stale_items = load_stats_cache_items(conn, tickers, now_ts, fresh_only=False)
    result: dict[str, dict] = {}
    for ticker in tickers:
        cached = cached_items.get(ticker)
        if cached:
            cached = apply_history_dividend_yield(conn, ticker, cached)
            cached["next_earnings_date"] = earnings_by_ticker.get(ticker)
            result[ticker] = cached
            continue
        stale = stale_items.get(ticker)
        if stale:
            stale = apply_history_dividend_yield(conn, ticker, stale)
            stale["next_earnings_date"] = earnings_by_ticker.get(ticker)
            if not refresh_stale:
                result[ticker] = stale
                continue
        elif not refresh_stale:
            item = {"next_earnings_date": earnings_by_ticker.get(ticker)}
            result[ticker] = apply_history_dividend_yield(conn, ticker, item)
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
                    dividend_yield = yfinance_dividend_yield(info)
                    info_name = info.get("longName") or info.get("shortName") or info.get("displayName")
                    meta_name = ticker_meta.get(ticker, {}).get("name")
                    quote_type = str(info.get("quoteType") or "").upper()
                    is_etf = quote_type == "ETF" or asset_class(ticker, info_name or meta_name or "") == "etf"
                    aum = None
                    if is_etf:
                        aum = finite_number(info.get("totalAssets"))
                        if aum is None:
                            aum = finite_number(info.get("netAssets"))
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
                        "aum": aum,
                        "dividend_yield": finite_number(dividend_yield),
                        "trailing_pe": normalize_pe(info.get("trailingPE")),
                        "forward_pe": normalize_pe(info.get("forwardPE")),
                        "price_to_book": price_to_book,
                        "next_earnings_date": earnings_by_ticker.get(ticker),
                    }
                    data.update(yfinance_profile_metrics(info))
                    source = "yfinance"
                    raw = {"info": info}
                    fetched = True
                    # GICS 섹터는 정적 속성이라 tickers에 저장 (관심목록 섹터 컬럼·필터용)
                    sector = str(info.get("sector") or "").strip()
                    if sector:
                        conn.execute(
                            "UPDATE tickers SET sector = ? WHERE ticker = ? AND COALESCE(sector, '') <> ?",
                            (sector, ticker, sector),
                        )
        except Exception as exc:
            print(f"[stats] fundamentals failed for {ticker}: {exc}")
            if stale:
                result[ticker] = stale
                continue
        if fetched:
            data["next_earnings_date"] = earnings_by_ticker.get(ticker)
            current_price = parse_number(raw.get("nowPrice")) if source == "naver" and raw else None
            data = apply_history_dividend_yield(conn, ticker, data, current_price)
            save_stats_cache_item(conn, ticker, source, data, raw)
            # 펀더멘털 네트워크 조회는 종목 수에 따라 오래 걸린다. 종목별로
            # 커밋해 분 단위 가격 스냅샷의 SQLite 쓰기를 장시간 막지 않는다.
            conn.commit()
        result[ticker] = data
    conn.commit()
    return result

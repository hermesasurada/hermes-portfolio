from __future__ import annotations

import math
import re
import threading
import time
from datetime import date
from typing import Iterable

from .collectors import (
    fetch_investing_kr_earnings_date,
    fetch_yahoo_earnings_date,
)
from .constants import MARKET_INDEXES
from .db import connect, ensure_ticker_metadata_columns
from .fundamentals import fetch_fundamentals
from .logos import cache_logo
from .price_store import infer_category, save_daily_prices, update_earnings_dates, update_price_cache
from .technical_stats import refresh_technical_stats_cache
from .tickers import asset_class, normalize_yfinance_symbol, ticker_currency

# Cache the full KRX listing in-process so name-based lookups don't re-download
# it on every search. (#4)
_KRX_LISTING_CACHE: dict = {"df": None, "ts": 0.0}
_KRX_LISTING_TTL = 6 * 3600  # 6 hours
_KRX_LISTING_LOCK = threading.Lock()


def _krx_listing_df():
    with _KRX_LISTING_LOCK:
        now = time.time()
        cached = _KRX_LISTING_CACHE["df"]
        if cached is None or now - _KRX_LISTING_CACHE["ts"] > _KRX_LISTING_TTL:
            from FinanceDataReader import StockListing

            _KRX_LISTING_CACHE["df"] = StockListing("KRX")
            _KRX_LISTING_CACHE["ts"] = now
        return _KRX_LISTING_CACHE["df"]


def history_start_years(years: int = 5) -> str:
    today = date.today()
    return f"{today.year - years:04d}{today.month:02d}{today.day:02d}"


def normalize_lookup_ticker(value: str) -> str:
    ticker = re.sub(r"\s+", "", str(value or "")).upper()
    if re.fullmatch(r"\d{6}", ticker):
        return f"{ticker}.KS"
    return ticker


def lookup_krx_listing(query: str) -> dict | None:
    text = str(query or "").strip()
    if not text:
        return None
    compact = re.sub(r"\s+", "", text).upper()
    df = _krx_listing_df()
    if df is None or df.empty:
        return None
    code_column = "Code" if "Code" in df.columns else "Symbol"
    name_column = "Name"
    if code_column not in df.columns or name_column not in df.columns:
        return None
    rows = df.copy()
    rows["_code"] = rows[code_column].astype(str).str.zfill(6)
    rows["_name"] = rows[name_column].astype(str)
    exact_code = rows[rows["_code"] == compact.replace(".KS", "").replace(".KQ", "")]
    if not exact_code.empty:
        row = exact_code.iloc[0]
    else:
        exact_name = rows[rows["_name"].str.upper() == compact]
        if not exact_name.empty:
            row = exact_name.iloc[0]
        else:
            contains = rows[rows["_name"].str.contains(text, case=False, regex=False, na=False)]
            if contains.empty:
                return None
            row = contains.iloc[0]
    market_id = str(row.get("MarketId") or row.get("Market") or "")
    suffix = ".KQ" if market_id.upper() in {"KSQ", "KOSDAQ"} else ".KS"
    return {
        "ticker": f"{str(row['_code']).zfill(6)}{suffix}",
        "name": str(row["_name"]),
        "currency": "KRW",
        "category": "kr",
        "region": "KR",
    }


def ticker_region(ticker: str, category: str) -> str:
    if category == "kr":
        return "KR"
    if ticker.endswith((".PA", ".DE")):
        return "EU"
    if ticker.endswith(".T"):
        return "JP"
    if category == "index":
        return MARKET_INDEXES.get(ticker, {}).get("region") or "US"
    return "US"


def lookup_korean_ticker(ticker: str) -> dict | None:
    import json
    import urllib.request
    from urllib.parse import quote

    code = ticker.split(".")[0]
    url = f"https://stock.naver.com/api/domestic/detail/{quote(code)}/detail?codeType=KRX"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        obj = json.loads(resp.read().decode("utf-8"))
    name = obj.get("stockName") or obj.get("stockEndType") or obj.get("itemName") or obj.get("itemname")
    if not name:
        return None
    return {
        "ticker": ticker,
        "name": str(name),
        "currency": "KRW",
        "category": "kr",
        "region": "KR",
    }


def lookup_yahoo_ticker(ticker: str) -> dict | None:
    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker) or ticker
    info = yf.Ticker(symbol).info or {}
    name = info.get("longName") or info.get("shortName") or info.get("displayName")
    if not name:
        return None
    currency = info.get("currency") or ticker_currency(ticker)
    category = infer_category(ticker)
    return {
        "ticker": ticker,
        "name": str(name),
        "currency": str(currency).upper(),
        "category": category,
        "region": ticker_region(ticker, category),
    }


def lookup_ticker(value: str) -> dict:
    raw_value = str(value or "").strip()
    ticker = normalize_lookup_ticker(value)
    if not ticker:
        raise ValueError("종목코드를 입력해야 합니다.")
    if not re.fullmatch(r"[A-Z0-9.^-]+", ticker):
        found_by_name = lookup_krx_listing(raw_value)
        if found_by_name:
            return found_by_name
        raise ValueError(f"{raw_value} 종목을 찾지 못했습니다.")
    if ticker in MARKET_INDEXES:
        meta = MARKET_INDEXES[ticker]
        return {
            "ticker": ticker,
            "name": meta["name"],
            "currency": meta["currency"],
            "category": "index",
            "region": meta["region"],
        }
    if ticker == "BTC":
        return {"ticker": "BTC", "name": "Bitcoin", "currency": "KRW", "category": "crypto", "region": "KR"}
    with connect() as conn:
        row = conn.execute(
            "SELECT ticker, name, currency, category, region FROM tickers WHERE UPPER(ticker) = ?",
            (ticker,),
        ).fetchone()
    if row and row["name"]:
        category = infer_category(row["ticker"], row["category"])
        return {
            "ticker": row["ticker"],
            "name": row["name"],
            "currency": row["currency"] or ticker_currency(row["ticker"]),
            "category": category,
            "region": row["region"] or ticker_region(row["ticker"], category),
        }
    if ticker.endswith((".KS", ".KQ")):
        found = lookup_korean_ticker(ticker) or lookup_krx_listing(ticker)
    else:
        found = lookup_yahoo_ticker(ticker)
    if not found:
        raise ValueError(f"{ticker} 종목명을 찾지 못했습니다.")
    return found


def upsert_ticker(item: dict) -> dict:
    ticker = normalize_lookup_ticker(item.get("ticker") or "")
    if not ticker:
        raise ValueError("종목코드를 입력해야 합니다.")
    resolved = {
        **lookup_ticker(ticker),
        **{k: v for k, v in item.items() if k in {"name", "currency", "category", "region"} and v},
        "ticker": ticker,
    }
    category = infer_category(ticker, resolved.get("category"))
    currency = str(resolved.get("currency") or ticker_currency(ticker)).upper()
    region = str(resolved.get("region") or ticker_region(ticker, category)).upper()
    name = str(resolved.get("name") or ticker).strip()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO tickers (ticker, name, region, currency, added_date, category)
            VALUES (?, ?, ?, ?, DATE('now'), ?)
            ON CONFLICT(ticker) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), tickers.name),
                region = COALESCE(NULLIF(excluded.region, ''), tickers.region),
                currency = COALESCE(NULLIF(excluded.currency, ''), tickers.currency),
                category = COALESCE(NULLIF(excluded.category, ''), tickers.category)
            """,
            (ticker, name, region, currency, category),
        )
        conn.commit()
    return {"ticker": ticker, "name": name, "currency": currency, "category": category, "region": region}


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
    ticker = normalize_lookup_ticker(ticker)
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


def add_watchlist(items: Iterable[dict], hydrate: bool = True) -> dict:
    added = [upsert_ticker(item) for item in items]
    hydration = [hydrate_ticker(item["ticker"]) for item in added] if hydrate else []
    return {"ok": True, "tickers": added, "hydration": hydration}


def estimate_hydration_minutes(count: int) -> int:
    # Each ticker pulls ~5y history + fundamentals + earnings (with a throttle sleep)
    # + logo, roughly half a minute apiece. Round up, minimum 1 minute.
    return max(1, math.ceil(count * 0.6))


def add_watchlist_async(items: Iterable[dict]) -> dict:
    """Register tickers immediately, then hydrate them (history/fundamentals/
    earnings/logo) in a background thread so the request returns right away. (#2)"""
    added = [upsert_ticker(item) for item in items]
    tickers = [item["ticker"] for item in added]

    def _worker(target: list[str]) -> None:
        for ticker in target:
            try:
                hydrate_ticker(ticker)
            except Exception as exc:  # noqa: BLE001 — background best-effort
                print(f"[watchlist] background hydration failed for {ticker}: {exc}")

    if tickers:
        threading.Thread(
            target=_worker, args=(tickers,), name="watchlist-hydrate", daemon=True
        ).start()

    eta = estimate_hydration_minutes(len(tickers))
    return {
        "ok": True,
        "tickers": added,
        "async": True,
        "eta_minutes": eta,
        "message": f"종목 데이터 동기화에 시간이 소요됩니다. 약 {eta}분 뒤 새로고침해 확인하세요.",
    }


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

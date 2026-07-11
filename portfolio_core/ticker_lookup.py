from __future__ import annotations

import json
import re
import threading
import time
import urllib.request
from datetime import date, timedelta
from urllib.parse import quote

from .constants import CRYPTO_MARKETS, MARKET_INDEXES
from .db import connect
from .price_store import infer_category
from .tickers import kr_ticker_code, normalize_yfinance_symbol, ticker_currency

_KRX_LISTING_CACHE: dict = {"df": None, "ts": 0.0}
_KRX_LISTING_TTL = 6 * 3600
_KRX_LISTING_LOCK = threading.Lock()


def _recent_krx_listing_cache():
    import pandas as pd

    base_url = "https://raw.githubusercontent.com/FinanceData/fdr_krx_data_cache/refs/heads/master/data/listing/krx"
    for days_ago in range(1, 11):
        target = date.today() - timedelta(days=days_ago)
        try:
            return pd.read_csv(
                f"{base_url}/{target.isoformat()}.csv",
                dtype={"Code": str, "Dept": str, "ChangeCode": str, "MarketId": str},
            )
        except Exception:
            continue
    return None


def _krx_listing_df():
    with _KRX_LISTING_LOCK:
        now = time.time()
        cached = _KRX_LISTING_CACHE["df"]
        if cached is None or now - _KRX_LISTING_CACHE["ts"] > _KRX_LISTING_TTL:
            from FinanceDataReader import StockListing

            try:
                cached = StockListing("KRX")
            except Exception:
                cached = _recent_krx_listing_cache()
            _KRX_LISTING_CACHE.update({"df": cached, "ts": now})
        return cached


def lookup_krx_listing(query: str) -> dict | None:
    text = str(query or "").strip()
    if not text:
        return None
    compact = re.sub(r"\s+", "", text).upper()
    try:
        frame = _krx_listing_df()
    except Exception:
        return None
    if frame is None or frame.empty:
        return None
    code_column = "Code" if "Code" in frame.columns else "Symbol"
    if code_column not in frame.columns or "Name" not in frame.columns:
        return None
    rows = frame.copy()
    rows["_code"] = rows[code_column].astype(str).str.zfill(6)
    rows["_name"] = rows["Name"].astype(str)
    matched = rows[rows["_code"] == kr_ticker_code(compact)]
    if matched.empty:
        matched = rows[rows["_name"].str.upper() == compact]
    if matched.empty:
        matched = rows[rows["_name"].str.contains(text, case=False, regex=False, na=False)]
    if matched.empty:
        return None
    row = matched.iloc[0]
    market_id = str(row.get("MarketId") or row.get("Market") or "")
    suffix = ".KQ" if market_id.upper() in {"KSQ", "KOSDAQ"} else ".KS"
    return {
        "ticker": f"{str(row['_code']).zfill(6)}{suffix}",
        "name": str(row["_name"]),
        "currency": "KRW",
        "category": "kr",
        "region": "KR",
    }


def resolve_kr_suffix(code: str) -> str:
    listing = lookup_krx_listing(code)
    resolved = (listing or {}).get("ticker")
    return resolved if resolved and resolved.endswith((".KS", ".KQ")) else f"{code}.KS"


def normalize_lookup_ticker(value: str) -> str:
    ticker = re.sub(r"\s+", "", str(value or "")).upper()
    return resolve_kr_suffix(ticker) if re.fullmatch(r"\d{6}", ticker) else ticker


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


def lookup_registered_name(query: str) -> dict | None:
    compact = re.sub(r"\s+", "", str(query or "")).upper()
    if not compact:
        return None
    with connect() as conn:
        row = conn.execute(
            """
            SELECT ticker, name, currency, category, region
            FROM tickers
            WHERE REPLACE(UPPER(name), ' ', '') = ?
               OR REPLACE(UPPER(name), ' ', '') LIKE ?
            ORDER BY CASE WHEN REPLACE(UPPER(name), ' ', '') = ? THEN 0 ELSE 1 END,
                     LENGTH(name), ticker
            LIMIT 1
            """,
            (compact, f"%{compact}%", compact),
        ).fetchone()
    if not row:
        return None
    category = infer_category(row["ticker"], row["category"])
    return {
        "ticker": row["ticker"],
        "name": row["name"] or row["ticker"],
        "currency": row["currency"] or ticker_currency(row["ticker"]),
        "category": category,
        "region": row["region"] or ticker_region(row["ticker"], category),
    }


def lookup_korean_ticker(ticker: str) -> dict | None:
    code = kr_ticker_code(ticker)
    url = f"https://stock.naver.com/api/domestic/detail/{quote(code)}/detail?codeType=KRX"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=8) as response:
        obj = json.loads(response.read().decode("utf-8"))
    name = obj.get("stockName") or obj.get("stockEndType") or obj.get("itemName") or obj.get("itemname")
    if not name:
        return None
    return {"ticker": ticker, "name": str(name), "currency": "KRW", "category": "kr", "region": "KR"}


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
        found = lookup_registered_name(raw_value) or lookup_krx_listing(raw_value)
        if found:
            return found
        raise ValueError(f"{raw_value} 종목을 찾지 못했습니다.")
    if ticker in MARKET_INDEXES:
        meta = MARKET_INDEXES[ticker]
        return {"ticker": ticker, "name": meta["name"], "currency": meta["currency"], "category": "index", "region": meta["region"]}
    if ticker in CRYPTO_MARKETS:
        meta = CRYPTO_MARKETS[ticker]
        return {"ticker": ticker, "name": meta["name"], "currency": meta["currency"], "category": "crypto", "region": "KR"}
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
    found = (lookup_korean_ticker(ticker) or lookup_krx_listing(ticker)) if ticker.endswith((".KS", ".KQ")) else lookup_yahoo_ticker(ticker)
    if not found:
        raise ValueError(f"{ticker} 종목명을 찾지 못했습니다.")
    return found


def is_registered_ticker(ticker: str) -> bool:
    symbol = str(ticker or "").strip().upper()
    if not symbol:
        return False
    with connect() as conn:
        return conn.execute("SELECT 1 FROM tickers WHERE UPPER(ticker) = ? LIMIT 1", (symbol,)).fetchone() is not None

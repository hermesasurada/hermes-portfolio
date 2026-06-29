from __future__ import annotations

import re
import threading
import time
from datetime import date, timedelta
from typing import Iterable

from .constants import CRYPTO_MARKETS, MARKET_INDEXES
from .db import connect
from .hydration import deficient_tickers, estimate_hydration_minutes, hydrate_deficient_tickers, hydrate_ticker
from .interest_watchlists import sync_special_interest_items
from .price_store import infer_category
from .tickers import asset_class, display_name, kr_ticker_code, normalize_yfinance_symbol, ticker_currency

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

            try:
                listing = StockListing("KRX")
            except Exception:
                listing = _recent_krx_listing_cache()
            _KRX_LISTING_CACHE["df"] = listing
            _KRX_LISTING_CACHE["ts"] = now
        return _KRX_LISTING_CACHE["df"]


def _recent_krx_listing_cache():
    import pandas as pd

    base_url = (
        "https://raw.githubusercontent.com/FinanceData/fdr_krx_data_cache/"
        "refs/heads/master/data/listing/krx"
    )
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


def resolve_kr_suffix(code: str) -> str:
    """6자리 KR 단축코드의 거래소를 KRX 상장목록으로 판정해 .KS(KOSPI)/.KQ(KOSDAQ)를
    부여한다. 과거엔 무조건 .KS를 붙여 코스닥 종목(로보티즈·펄어비스 등)이 잘못
    등록되는 버그가 있었음. 조회 실패 시에만 .KS로 폴백."""
    try:
        listing = lookup_krx_listing(code)
        resolved = (listing or {}).get("ticker")
        if resolved and resolved.endswith((".KS", ".KQ")):
            return resolved
    except Exception:
        pass
    return f"{code}.KS"


def normalize_lookup_ticker(value: str) -> str:
    ticker = re.sub(r"\s+", "", str(value or "")).upper()
    if re.fullmatch(r"\d{6}", ticker):
        return resolve_kr_suffix(ticker)
    return ticker


def lookup_krx_listing(query: str) -> dict | None:
    text = str(query or "").strip()
    if not text:
        return None
    compact = re.sub(r"\s+", "", text).upper()
    try:
        df = _krx_listing_df()
    except Exception:
        return None
    if df is None or df.empty:
        return None
    code_column = "Code" if "Code" in df.columns else "Symbol"
    name_column = "Name"
    if code_column not in df.columns or name_column not in df.columns:
        return None
    rows = df.copy()
    rows["_code"] = rows[code_column].astype(str).str.zfill(6)
    rows["_name"] = rows[name_column].astype(str)
    exact_code = rows[rows["_code"] == kr_ticker_code(compact)]
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
            ORDER BY
                CASE WHEN REPLACE(UPPER(name), ' ', '') = ? THEN 0 ELSE 1 END,
                LENGTH(name),
                ticker
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

    code = kr_ticker_code(ticker)
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
        found_by_name = lookup_registered_name(raw_value) or lookup_krx_listing(raw_value)
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
    if ticker.endswith((".KS", ".KQ")):
        found = lookup_korean_ticker(ticker) or lookup_krx_listing(ticker)
    else:
        found = lookup_yahoo_ticker(ticker)
    if not found:
        raise ValueError(f"{ticker} 종목명을 찾지 못했습니다.")
    return found


def is_registered_ticker(ticker: str) -> bool:
    """이미 관리종목(tickers 테이블)에 등록된 심볼인지 — 중복 추가 차단용."""
    symbol = str(ticker or "").strip().upper()
    if not symbol:
        return False
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM tickers WHERE UPPER(ticker) = ? LIMIT 1",
            (symbol,),
        ).fetchone()
    return row is not None


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
    disp = display_name(name, ticker)
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO tickers (ticker, name, region, currency, added_date, category, display_name)
            VALUES (?, ?, ?, ?, DATE('now'), ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), tickers.name),
                region = COALESCE(NULLIF(excluded.region, ''), tickers.region),
                currency = COALESCE(NULLIF(excluded.currency, ''), tickers.currency),
                category = COALESCE(NULLIF(excluded.category, ''), tickers.category),
                display_name = COALESCE(NULLIF(tickers.display_name, ''), excluded.display_name)
            """,
            (ticker, name, region, currency, category, disp),
        )
        conn.commit()
    return {"ticker": ticker, "name": name, "currency": currency, "category": category, "region": region}


def add_watchlist(items: Iterable[dict], hydrate: bool = True) -> dict:
    added = [upsert_ticker(item) for item in items]
    sync_special_interest_items(added)
    hydration = [hydrate_ticker(item["ticker"]) for item in added] if hydrate else []
    return {"ok": True, "tickers": added, "hydration": hydration}


def add_watchlist_async(items: Iterable[dict]) -> dict:
    """Register tickers immediately, then hydrate them (history/fundamentals/
    earnings/logo) in a background thread so the request returns right away. (#2)"""
    added = [upsert_ticker(item) for item in items]
    sync_special_interest_items(added)
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

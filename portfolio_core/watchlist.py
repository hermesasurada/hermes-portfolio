from __future__ import annotations

import threading
from typing import Iterable

from .constants import FX_TICKERS, MARKET_INDEXES
from .db import connect
from .hydration import estimate_hydration_minutes, hydrate_ticker
from .interest_watchlists import load_interest_watchlists, sync_special_interest_items
from .logos import logo_stem
from .paths import LOGO_DIR
from .price_store import infer_category
from .ticker_lookup import (
    is_registered_ticker,
    lookup_ticker,
    normalize_lookup_ticker,
    ticker_region,
)
from .tickers import display_name, ticker_currency

# 수집 대상에서 종목을 뗄 때 함께 지울 시세·배당·캐시 테이블.
TICKER_DATA_TABLES = (
    "daily_prices",
    "daily_technical_indicators",
    "dividend_events",
    "ticker_dividend_cache",
    "stock_splits",
    "ticker_split_cache",
    "earnings_events",
    "ticker_stats_cache",
    "ticker_technical_stats_cache",
    "ticker_live_quotes",
    "ticker_extended_quotes",
    "interest_watchlist_items",
)


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


def purge_ticker_collected_data(conn, ticker: str) -> None:
    for table in TICKER_DATA_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE UPPER(ticker) = ?", (ticker,))


def delete_ticker_logo(ticker: str) -> None:
    stem = logo_stem(ticker)
    for ext in ("png", "svg"):
        path = LOGO_DIR / f"{stem}.{ext}"
        if path.is_file():
            path.unlink()


def _protected_collection_reason(ticker: str, category: str | None) -> str | None:
    if ticker in FX_TICKERS or str(category or "").lower() == "fx":
        return "환율"
    if ticker in MARKET_INDEXES or str(category or "").lower() == "index":
        return "지수"
    return None


def purge_untracked_collected_data() -> int:
    """tickers에 없고 보유·거래도 없는 종목의 시세·배당 잔여분을 지운다."""
    with connect() as conn:
        kept = {
            str(row["ticker"]).strip().upper()
            for row in conn.execute(
                "SELECT ticker FROM tickers WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''"
            )
            if row["ticker"]
        }
        kept.update(FX_TICKERS)
        kept.update(MARKET_INDEXES.keys())
        for table in ("holdings", "transactions"):
            for row in conn.execute(f"SELECT ticker FROM {table} WHERE ticker IS NOT NULL"):
                kept.add(str(row["ticker"]).strip().upper())
        found: set[str] = set()
        for table in TICKER_DATA_TABLES:
            for row in conn.execute(f"SELECT DISTINCT ticker FROM {table} WHERE ticker IS NOT NULL"):
                found.add(str(row["ticker"]).strip().upper())
        orphans = sorted(found - kept)
        for ticker in orphans:
            purge_ticker_collected_data(conn, ticker)
        conn.commit()
    return len(orphans)


def unregister_collected_ticker(payload: dict) -> dict:
    """기타 관심목록의 종목을 수집 대상에서 빼고 시세·배당 이력을 삭제한다."""
    ticker = normalize_lookup_ticker(payload.get("ticker") or "")
    if not ticker:
        raise ValueError("종목을 선택해야 합니다.")
    protected = _protected_collection_reason(ticker, None)
    if protected:
        raise ValueError(f"{protected} 종목은 수집 대상에서 제외할 수 없습니다.")
    with connect() as conn:
        row = conn.execute(
            "SELECT ticker, COALESCE(category, '') AS category FROM tickers WHERE UPPER(ticker) = ?",
            (ticker,),
        ).fetchone()
        if not row:
            raise ValueError("수집 대상에서 종목을 찾지 못했습니다.")
        protected = _protected_collection_reason(ticker, row["category"])
        if protected:
            raise ValueError(f"{protected} 종목은 수집 대상에서 제외할 수 없습니다.")
        if conn.execute(
            "SELECT 1 FROM interest_watchlist_items WHERE UPPER(ticker) = ?",
            (ticker,),
        ).fetchone():
            raise ValueError("관심그룹에 들어 있는 종목은 기타에서만 제외할 수 있습니다.")
        if conn.execute(
            "SELECT 1 FROM holdings WHERE UPPER(ticker) = ? AND qty > 0",
            (ticker,),
        ).fetchone():
            raise ValueError("보유 중인 종목은 수집 대상에서 제외할 수 없습니다.")
        if conn.execute(
            "SELECT 1 FROM transactions WHERE UPPER(ticker) = ?",
            (ticker,),
        ).fetchone():
            raise ValueError("거래 이력이 있는 종목은 수집 대상에서 제외할 수 없습니다.")
        purge_ticker_collected_data(conn, ticker)
        conn.execute("DELETE FROM holdings WHERE UPPER(ticker) = ?", (ticker,))
        conn.execute("DELETE FROM tickers WHERE UPPER(ticker) = ?", (ticker,))
        conn.commit()
    delete_ticker_logo(ticker)
    purge_untracked_collected_data()
    return load_interest_watchlists()

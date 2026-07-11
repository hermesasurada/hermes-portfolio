from __future__ import annotations

import threading
from typing import Iterable

from .db import connect
from .hydration import estimate_hydration_minutes, hydrate_ticker
from .interest_watchlists import sync_special_interest_items
from .price_store import infer_category
from .ticker_lookup import (
    is_registered_ticker,
    lookup_ticker,
    normalize_lookup_ticker,
    ticker_region,
)
from .tickers import display_name, ticker_currency


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

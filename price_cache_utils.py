#!/usr/bin/env python3
"""공통 가격 캐시 유틸리티 — price_updater_kr/overseas/portfolio_v2에서 공유."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from portfolio_core.tickers import ticker_currency

DATA_DIR = Path.home() / ".hermes" / "data" / "portfolio_v2"
CACHE_FILE = DATA_DIR / "price_cache.json"
CACHE_STALE_SECONDS = 600  # 10분


def load_cache() -> dict:
    """캐시 파일 로드. 실패 시 빈 dict 반환."""
    if not CACHE_FILE.exists():
        return {}
    try:
        with open(CACHE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(data: dict) -> None:
    """캐시 파일 저장."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(CACHE_FILE, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def cache_stale(cache: dict) -> bool:
    """캐시가 CACHE_STALE_SECONDS 이상 오래됐으면 True."""
    ts = cache.get("updated")
    if not ts:
        return True
    try:
        cached_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if cached_dt.tzinfo is None:
            cached_dt = cached_dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - cached_dt).total_seconds() > CACHE_STALE_SECONDS
    except Exception:
        return True


def get_cached_price(ticker: str):
    """캐시에서 가격 조회. 없거나 stale이면 None."""
    cache = load_cache()
    if cache_stale(cache):
        return None
    entry = cache.get("prices", {}).get(ticker)
    return entry["price"] if entry else None


def set_cached_price(ticker: str, price: float, currency: str, source: str = "live") -> None:
    """캐시에 단일 항목 업데이트 (기존 항목 보존)."""
    cache = load_cache()
    prices = cache.get("prices", {})
    prices[ticker] = {"price": price, "currency": currency, "source": source}
    save_cache({"updated": datetime.now(timezone.utc).isoformat(), "prices": prices})

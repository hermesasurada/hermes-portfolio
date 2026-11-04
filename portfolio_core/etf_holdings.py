"""ETF 구성종목 조회(2026-11-04 사용자 지시): 종목 세부페이지의 구성종목 팝업.

수집은 hermes 크론 etf-holdings-weekly(~/.hermes/scripts/distill/etf_holdings.py)가 맡고 여기서는 그 캐시만 읽는다.
"""
from __future__ import annotations

import json
from pathlib import Path

from .db import connect
from .tickers import asset_class

_loaded: tuple[int, dict] = (0, {})


def cache_path() -> Path:
    return Path.home() / ".hermes" / "vault-enrich" / "etf_holdings.json"


def _cache() -> dict:
    """파일이 바뀔 때만 다시 읽는다. 없거나 깨졌으면 빈 캐시(팝업이 '수집 전'을 보인다)."""
    global _loaded
    try:
        mtime = cache_path().stat().st_mtime_ns
    except OSError:
        return {}
    if mtime != _loaded[0]:
        try:
            _loaded = (mtime, json.loads(cache_path().read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return {}
    return _loaded[1]


def _entry(ticker: str) -> dict | None:
    if not ticker or ticker.startswith("_"):
        return None
    entry = _cache().get(ticker)
    return entry if isinstance(entry, dict) and entry.get("items") else None


def etf_holdings_available(ticker: str, name: str = "") -> bool:
    """버튼 표시 기준. 일본 ETF·레버리지처럼 이름으로 안 잡히는 ETF는 수집 결과로 판정한다."""
    return _entry(ticker) is not None or asset_class(ticker, name or "") == "etf"


def load_etf_universe() -> dict:
    """등록 종목 중 ETF 전체 — 수집기가 시장지수·미보유 ETF까지 받는 대상 목록."""
    with connect() as conn:
        rows = conn.execute("SELECT ticker, name FROM tickers").fetchall()
    known = {key for key in _cache() if not key.startswith("_")}
    return {"etfs": [{"ticker": row["ticker"], "name": row["name"] or row["ticker"]} for row in rows
                     if row["ticker"] in known or asset_class(row["ticker"], row["name"] or "") == "etf"]}


def _row(item: dict) -> dict:
    return {
        "symbol": str(item.get("symbol") or ""),
        "name": str(item.get("name") or ""),
        "weight": item.get("weight"),
        "estimated": bool(item.get("weight_estimated")),
        "type": str(item.get("type") or ""),
    }


def load_etf_holdings(ticker: str) -> dict:
    clean = str(ticker or "").strip().upper()
    entry = _entry(clean)
    if entry is None:
        return {"ticker": clean, "found": False, "items": [], "others": []}
    return {
        "ticker": clean,
        "found": True,
        "source": str(entry.get("source") or ""),
        "url": str(entry.get("url") or ""),
        "as_of": str(entry.get("as_of") or ""),
        "complete": bool(entry.get("complete")),
        "items": [_row(item) for item in entry["items"]],
        "others": [_row(item) for item in entry.get("others") or []],
    }

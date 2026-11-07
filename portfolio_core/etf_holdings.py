"""ETF 구성종목 조회(2026-11-04 사용자 지시): 종목 세부페이지의 구성종목 팝업.

수집은 hermes 크론 etf-holdings-weekly(~/.hermes/scripts/distill/etf_holdings.py)가 맡고 여기서는 그 캐시만 읽는다.
레버리지·인버스 ETF는 수집 대상이 아니다(2026-11-05 사용자 지시): 스왑 담보만 보여서 구성이 뜻이 없다.
"""
from __future__ import annotations

import json
from pathlib import Path

from .db import connect
from .leveraged import is_leveraged_product
from .tickers import asset_class

_loaded: tuple[int, dict] = (0, {})
# 이름 패턴이 놓치는 상품(1.25x, 이름 없는 COTG·LLYX)은 이 관심목록 소속으로 잡는다.
LEVERAGED_GROUP_NAME = "레버리지/롱숏 ETF"


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


def _leveraged_group() -> set[str]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT items.ticker FROM interest_watchlist_items AS items
            JOIN interest_watchlist_groups AS groups ON groups.id = items.group_id
            WHERE groups.name = ?
            """,
            (LEVERAGED_GROUP_NAME,),
        ).fetchall()
    return {row["ticker"] for row in rows}


def etf_holdings_available(ticker: str, name: str = "") -> bool:
    """버튼 표시 기준. 일본 ETF처럼 이름으로 안 잡히는 ETF는 수집 결과로 판정한다. 레버리지는 수집하지 않으니 버튼도 없다."""
    if is_leveraged_product(name) or ticker in _leveraged_group():
        return False
    return _entry(ticker) is not None or asset_class(ticker, name or "") == "etf"


def load_etf_universe() -> dict:
    """등록 종목 중 ETF 전체 — 수집기가 시장지수·미보유 ETF까지 받는 대상 목록.
    leveraged는 수집기가 보유·관심 경로에서도 건너뛰고 캐시에서 지우는 목록이다. 캐시를 지운 뒤에도 그대로여야 해서
    ETF 판정과 무관하게 이름·관심목록만 본다(Ultra Clean 같은 개별주가 섞여도 구성이 없어 해가 없다)."""
    with connect() as conn:
        rows = conn.execute("SELECT ticker, name, display_name FROM tickers").fetchall()
    known = {key for key in _cache() if not key.startswith("_")}
    leveraged = _leveraged_group() | {
        row["ticker"] for row in rows
        if is_leveraged_product(row["name"]) or is_leveraged_product(row["display_name"])
    }
    return {
        "etfs": [{"ticker": row["ticker"], "name": row["name"] or row["ticker"]} for row in rows
                 if row["ticker"] not in leveraged
                 and (row["ticker"] in known or asset_class(row["ticker"], row["name"] or "") == "etf")],
        "leveraged": sorted(leveraged),
    }


def _list_names() -> dict[str, str]:
    """관심목록에 보이는 명칭. 그룹 밖 종목도 관심목록 '기타'에 나오므로 tickers 전체가 대상이다."""
    with connect() as conn:
        rows = conn.execute("SELECT ticker, COALESCE(NULLIF(display_name, ''), name) AS name FROM tickers").fetchall()
    return {row["ticker"]: row["name"] for row in rows if row["name"]}


def _row(item: dict, names: dict[str, str] | None = None) -> dict:
    symbol = str(item.get("symbol") or "")
    return {
        "symbol": symbol,
        "name": (names or {}).get(symbol) or str(item.get("name") or ""),
        "weight": item.get("weight"),
        "estimated": bool(item.get("weight_estimated")),
        "type": str(item.get("type") or ""),
    }


def load_etf_holdings(ticker: str) -> dict:
    clean = str(ticker or "").strip().upper()
    entry = _entry(clean)
    if entry is None:
        return {"ticker": clean, "found": False, "items": [], "others": []}
    names = _list_names()
    return {
        "ticker": clean,
        "found": True,
        "source": str(entry.get("source") or ""),
        "url": str(entry.get("url") or ""),
        "as_of": str(entry.get("as_of") or ""),
        "complete": bool(entry.get("complete")),
        "items": [_row(item, names) for item in entry["items"]],
        "others": [_row(item) for item in entry.get("others") or []],
    }

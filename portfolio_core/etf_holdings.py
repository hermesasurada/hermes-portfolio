"""ETF 구성종목 조회(2026-11-04 사용자 지시): 종목 세부페이지의 구성종목 팝업.

수집은 hermes 크론 etf-holdings-weekly(~/.hermes/scripts/distill/etf_holdings.py)가 맡고 여기서는 그 캐시만 읽는다.
레버리지·인버스 ETF는 수집 대상이 아니다(2026-11-05 사용자 지시): 스왑 담보만 보여서 구성이 뜻이 없다.
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from .db import connect
from .leveraged import is_leveraged_product
from .tickers import asset_class

_loaded: tuple[int, dict] = (0, {})
_exposure: tuple[int, dict] = (0, {})
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


def _day_changes(tickers) -> dict[str, dict]:
    """당일 등락(2026-11-09 사용자 지시): 일봉 최신 종가 ÷ 직전 종가 — 목록 표와 같은 latest_prices 기준.
    한국 종목은 출처마다 .KS/.KQ가 달라 둘 다 찾는다. 포트폴리오에 일봉이 없는 종목은 빠진다(화면은 '-')."""
    from .prices import latest_prices

    tickers = list(tickers)      # 제너레이터로 받아도 아래에서 두 번 돈다
    wanted: set[str] = set()
    for ticker in tickers:
        text = str(ticker or "").strip().upper()
        if not text:
            continue
        wanted.add(text)
        match = re.fullmatch(r"([0-9A-Z]{6})\.(KS|KQ)", text)
        if match:
            wanted.add(f"{match.group(1)}.{'KQ' if match.group(2) == 'KS' else 'KS'}")
    if not wanted:
        return {}
    with connect() as conn:
        prices = latest_prices(conn, sorted(wanted))
    out: dict[str, dict] = {}
    for ticker, record in prices.items():
        price, previous = record.get("price"), record.get("previous_price")
        if price is None or not previous:
            continue
        out[ticker] = {"pct": round((float(price) / float(previous) - 1) * 100, 4), "date": record.get("date")}
    for ticker in list(wanted):    # 접미사가 다른 쪽으로만 있으면 요청한 표기로도 찾게 한다
        match = re.fullmatch(r"([0-9A-Z]{6})\.(KS|KQ)", ticker)
        if match and ticker not in out:
            other = f"{match.group(1)}.{'KQ' if match.group(2) == 'KS' else 'KS'}"
            if other in out:
                out[ticker] = out[other]
    # 포트폴리오에 일봉이 없는 구성종목(대부분 미등록)은 야후 최근 일봉으로 채운다
    missing = [ticker for ticker in tickers_upper(tickers) if ticker not in out]
    if missing:
        out.update(_yahoo_day_changes(missing))
    return out


def tickers_upper(tickers) -> list[str]:
    return sorted({str(t or "").strip().upper() for t in tickers if str(t or "").strip()})


_YAHOO_TTL = 900          # 15분: 팝업을 여러 번 열어도 야후를 다시 부르지 않는다
_yahoo_cache: dict[str, tuple[float, dict | None]] = {}
_yahoo_lock = threading.Lock()


def _yahoo_day_changes(symbols: list[str]) -> dict[str, dict]:
    """미등록 구성종목의 당일 등락 — 야후 v7 quote 일괄 조회(정규장 현재가 ÷ 전일 종가). 없음도 15분 캐시.
    웹서버 안에서 yfinance.download를 쓰지 않는다: 스레드마다 tkr-tz.db 연결을 열고 닫지 않아
    파일 열기 한도를 넘겨 서버 전체가 500을 냈다(2026-11-09). 기존 크럼 세션을 재사용한다."""
    from datetime import datetime, timezone

    from .us_live_quotes import yahoo_quote_batch

    now = time.time()
    with _yahoo_lock:
        fresh = {s: _yahoo_cache[s][1] for s in symbols if s in _yahoo_cache and now - _yahoo_cache[s][0] < _YAHOO_TTL}
    todo = [s for s in symbols if s not in fresh]
    fetched: dict[str, dict | None] = {}
    for offset in range(0, len(todo), 50):
        chunk = todo[offset:offset + 50]
        try:
            quotes = yahoo_quote_batch(chunk)
        except Exception as exc:       # noqa: BLE001 — 실패한 묶음은 캐시하지 않아 다음에 다시 시도한다
            print(f"[etf_holdings] yahoo day change failed ({len(chunk)} symbols): {exc}")
            break                      # 야후 장애 때 묶음 수 × 타임아웃만큼 팝업(웹 요청)이 멈추지 않게
        for symbol in chunk:
            row = quotes.get(symbol.upper()) or {}
            price, previous = row.get("regularMarketPrice"), row.get("regularMarketPreviousClose")
            stamp = row.get("regularMarketTime")
            fetched[symbol] = None if price is None or not previous else {
                "pct": round((float(price) / float(previous) - 1) * 100, 4),
                "date": datetime.fromtimestamp(int(stamp), timezone.utc).date().isoformat() if stamp else None,
            }
    with _yahoo_lock:
        for symbol, value in fetched.items():
            _yahoo_cache[symbol] = (now, value)
    merged = {**fresh, **fetched}
    return {symbol: value for symbol, value in merged.items() if value}

def _row(item: dict, names: dict[str, str] | None = None, changes: dict[str, dict] | None = None) -> dict:
    symbol = str(item.get("symbol") or "")
    change = (changes or {}).get(symbol.upper()) or {}
    return {
        "symbol": symbol,
        "name": (names or {}).get(symbol) or str(item.get("name") or ""),
        "weight": item.get("weight"),
        "estimated": bool(item.get("weight_estimated")),
        "type": str(item.get("type") or ""),
        "change_pct": change.get("pct"),
        "change_date": change.get("date"),
    }


def load_etf_holdings(ticker: str) -> dict:
    clean = str(ticker or "").strip().upper()
    entry = _entry(clean)
    if entry is None:
        return {"ticker": clean, "found": False, "items": [], "others": []}
    names = _list_names()
    try:
        changes = _day_changes(item.get("symbol") for item in [*entry["items"], *(entry.get("others") or [])])
    except Exception:          # noqa: BLE001 — 등락이 실패해도 구성종목은 보인다
        changes = {}
    return {
        "ticker": clean,
        "found": True,
        "source": str(entry.get("source") or ""),
        "url": str(entry.get("url") or ""),
        "as_of": str(entry.get("as_of") or ""),
        "complete": bool(entry.get("complete")),
        "items": [_row(item, names, changes) for item in entry["items"]],
        "others": [_row(item, None, changes) for item in entry.get("others") or []],
    }


# ── 역방향: 이 종목을 편입한 ETF(2026-11-09 사용자 지시) ──
# 수집된 캐시의 주식 구성(items)만 본다. 현금·채권·파생(others)의 스왑 등은 편입으로 치지 않는다.
# 한국 종목은 거래소 접미사(.KS/.KQ)가 출처마다 달라 6자리 코드로 맞춘다.
def _symbol_key(symbol: str) -> str:
    text = str(symbol or "").strip().upper()
    match = re.fullmatch(r"([0-9A-Z]{6})\.(KS|KQ)", text)
    return f"{match.group(1)}.KR" if match else text


def _exposure_index() -> dict[str, list[dict]]:
    """종목 키 → [{etf, weight, estimated}]. 캐시 파일이 바뀔 때만 다시 만든다."""
    global _exposure
    cache = _cache()
    stamp = _loaded[0]
    if cache and _exposure[0] == stamp:
        return _exposure[1]
    index: dict[str, dict[str, dict]] = {}
    for etf, entry in cache.items():
        if etf.startswith("_") or not isinstance(entry, dict):
            continue
        for item in entry.get("items") or []:
            key = _symbol_key(item.get("symbol"))
            if not key or key == _symbol_key(etf):
                continue
            row = index.setdefault(key, {}).setdefault(etf, {"etf": etf, "weight": None, "estimated": False})
            weight = item.get("weight")
            if weight is not None:   # 같은 ETF 안 중복 행(보통주·예탁증서 등)은 비중을 더한다
                row["weight"] = (row["weight"] or 0) + float(weight)
            row["estimated"] = row["estimated"] or bool(item.get("weight_estimated"))
    built = {key: list(rows.values()) for key, rows in index.items()}
    _exposure = (stamp, built)
    return built


def _registered(rows: list[dict], names: dict[str, str]) -> list[dict]:
    """등록에서 빠진 ETF는 캐시에 남아도 주간 갱신 대상이 아니라 낡고, 이름·차트도 없다 — 뺀다."""
    return [row for row in rows if row["etf"] in names]


def etf_exposure_count(ticker: str) -> int:
    """차트 상단 '편입 ETF' 버튼 표시용 개수."""
    rows = _exposure_index().get(_symbol_key(ticker), [])
    return len(_registered(rows, _list_names())) if rows else 0


def _held_tickers() -> set[str]:
    with connect() as conn:
        rows = conn.execute("SELECT DISTINCT ticker FROM holdings WHERE qty > 0").fetchall()
    return {row["ticker"] for row in rows}


def load_etf_exposure(ticker: str) -> dict:
    clean = str(ticker or "").strip().upper()
    cache = _cache()
    names = _list_names()
    rows = _registered(_exposure_index().get(_symbol_key(clean), []), names)
    collected = [key for key, entry in cache.items()
                 if key in names and isinstance(entry, dict) and entry.get("items")]
    held = _held_tickers()
    try:
        changes = _day_changes(row["etf"] for row in rows)
    except Exception:          # noqa: BLE001
        changes = {}
    items = []
    for row in rows:
        entry = cache.get(row["etf"]) or {}
        change = changes.get(row["etf"].upper()) or {}
        items.append({
            "etf": row["etf"],
            "name": names[row["etf"]],
            "weight": None if row["weight"] is None else round(row["weight"], 4),
            "estimated": row["estimated"],
            "as_of": str(entry.get("as_of") or ""),
            "complete": bool(entry.get("complete")),
            "held": row["etf"] in held,
            "change_pct": change.get("pct"),
            "change_date": change.get("date"),
        })
    # 비중 큰 순, 비중 없는 행은 뒤로
    items.sort(key=lambda r: (r["weight"] is None, -(r["weight"] or 0), r["name"]))
    return {
        "ticker": clean,
        "items": items,
        "collected": len(collected),
        # 상위 일부만 공개된 ETF는 '없음'이 미편입을 뜻하지 않는다
        "partial": sum(1 for key in collected if not cache[key].get("complete")),
    }

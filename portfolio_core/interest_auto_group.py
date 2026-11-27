"""새 종목 → 관심목록 그룹 자동 배정(2026-11-27 사용자 지시: '애매하면 기본으로 두고').

관리종목에 새 종목을 등록할 때(`add_watchlist_async`) 이미 있는 관심목록 그룹 가운데 맞는 곳에 넣는다.
확신이 없으면 아무 데도 넣지 않는다 — 그러면 화면의 가상 '기타' 그룹(어느 그룹에도 없는 수집 종목)에 남는다.

규칙(지금 그룹 구성에서 읽은 관례):
- 거래소 접미사·통화로 정해지는 것: 한국(.KS·.KQ) · 일본(.T·JPY) · 대만/중국(.TW·.HK·.SS·.SZ, TWD·HKD·CNY)
  · 유럽 종목(유럽 거래소 접미사, EUR·GBP·CHF·북유럽 통화) · 디지털자산(crypto).
- 미국 상장(USD, 접미사 없음):
  - 단일종목 레버리지/인버스 ETF(운용사·배수·방향·기초 종목을 이름에서 모두 읽었을 때만) → '레버리지/롱숏 ETF',
    수정종목명은 그룹 규칙 `운용사 기초티커 Long/Short 배수`로 넣는다. 레버리지처럼 보이는데 기초 종목을 못 읽으면 애매 → 배정 안 함.
  - 그 밖의 ETF → 미국. 회사는 야후 country로: 미국·그 밖 외국 ADR → 미국(ARM·NVO 등 관례), 중국·홍콩·대만 → 대만/중국.
  - country를 모르면 애매 → 배정 안 함.
- 그룹은 이미 있는 것만 쓴다(만들지 않음). 이미 어느 그룹에든 들어 있는 종목은 건드리지 않는다.
  찐관심·투자종료 같은 사용자 그룹에는 자동으로 넣지 않는다.
"""
from __future__ import annotations

import re

from .db import connect
from .interest_watchlists import insert_interest_item_if_missing, sync_special_interest_items
from .tickers import display_name as default_display_name

KOREA = "한국"
JAPAN = "일본"
GREATER_CHINA = "대만/중국"
EUROPE = "유럽 종목"
CRYPTO = "디지털자산"
US = "미국"
LEVERAGED = "레버리지/롱숏 ETF"

CHINA_SUFFIXES = {"TW", "TWO", "HK", "SS", "SZ"}
CHINA_CURRENCIES = {"TWD", "HKD", "CNY"}
EUROPE_SUFFIXES = {"DE", "F", "PA", "AS", "MI", "MC", "BR", "LS", "VI", "L", "SW", "ST", "OL", "CO", "HE", "IR", "AT", "WA", "PR", "BU"}
EUROPE_CURRENCIES = {"EUR", "GBP", "GBX", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF"}
CHINA_COUNTRIES = {"china", "hong kong", "taiwan"}

# 이름 앞부분 → 그룹 규칙의 짧은 운용사 이름. 긴 것부터 찾는다('Themes ETF Trust - Leverage Shares …').
LEVERAGE_ISSUERS = (
    ("leverage shares", "Leverage Shares"),
    ("graniteshares", "Granite"),
    ("granite", "Granite"),
    ("direxion", "Direxion"),
    ("t-rex", "T-REX"),
    ("tradr", "Tradr"),
    ("defiance", "Defiance"),
)
_LONG_WORDS = {"long", "bull"}
_SHORT_WORDS = {"short", "bear", "inverse"}
_NOISE_WORDS = {
    "etf", "daily", "target", "shares", "trust", "themes", "the", "fund", "x",
    "graniteshares", "granite", "direxion", "t-rex", "tradr", "defiance", "leverage",
} | _LONG_WORDS | _SHORT_WORDS
_MULTIPLE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*x(?![a-z])", re.IGNORECASE)


def _suffix(ticker: str) -> str:
    return ticker.rsplit(".", 1)[1].upper() if "." in ticker else ""


def _issuer(name: str) -> str | None:
    lowered = name.casefold()
    for key, label in LEVERAGE_ISSUERS:
        if key in lowered:
            return label
    return None


def _resolve_underlying(conn, word: str, own_ticker: str) -> str | None:
    """이름 속 한 단어 → 수집 중인 미국 종목 티커. 대문자 티커 그대로이거나, 회사명 첫 단어와 정확히 같을 때만."""
    if word.isupper() and re.fullmatch(r"[A-Z]{1,5}", word):
        row = conn.execute(
            "SELECT ticker FROM tickers WHERE UPPER(ticker) = ? AND COALESCE(category, '') NOT IN ('index', 'fx')",
            (word,),
        ).fetchone()
        if row and row["ticker"].upper() != own_ticker:
            return row["ticker"].upper()
    if len(word) < 4:
        return None
    matches = {
        row["ticker"].upper()
        for row in conn.execute(
            "SELECT ticker, name, display_name FROM tickers WHERE COALESCE(category, '') NOT IN ('index', 'fx') AND ticker NOT LIKE '%.%'"
        )
        if row["ticker"].upper() != own_ticker
        and any(re.split(r"[\s,]+", str(text or "").strip())[0].casefold() == word.casefold()
                for text in (row["name"], row["display_name"]) if text)
    }
    return matches.pop() if len(matches) == 1 else None


def leveraged_etf_parts(conn, ticker: str, name: str) -> tuple[bool, str | None]:
    """(레버리지처럼 보이는가, 그룹 규칙 이름 또는 None). 이름이 비면 (False, None)."""
    name = str(name or "").strip()
    issuer = _issuer(name)
    words = re.findall(r"[A-Za-z][A-Za-z0-9&-]*", name)
    lowered = {word.casefold() for word in words}
    directions = {"Long" for word in lowered if word in _LONG_WORDS} | {"Short" for word in lowered if word in _SHORT_WORDS}
    multiple = _MULTIPLE.search(name)
    if not (issuer and multiple and len(directions) == 1):
        return (bool(issuer and (multiple or directions)), None)
    candidates = [word for word in words if word.casefold() not in _NOISE_WORDS]
    resolved = {_resolve_underlying(conn, word, ticker.upper()) for word in candidates} - {None}
    if len(resolved) != 1:
        return (True, None)
    factor = multiple.group(1).rstrip("0").rstrip(".") if "." in multiple.group(1) else multiple.group(1)
    return (True, f"{issuer} {resolved.pop()} {directions.pop()} {factor}x")


def suggest_interest_group(conn, item: dict) -> tuple[str | None, str | None]:
    """(그룹 이름 또는 None, 바꿀 수정종목명 또는 None). None 그룹 = 애매해서 배정하지 않음."""
    ticker = str(item.get("ticker") or "").strip().upper()
    category = str(item.get("category") or "").lower()
    currency = str(item.get("currency") or "").upper()
    suffix = _suffix(ticker)
    if not ticker or category in {"index", "fx"}:
        return (None, None)
    if category == "crypto":
        return (CRYPTO, None)
    if category == "kr" or suffix in {"KS", "KQ"}:
        return (KOREA, None)
    if suffix == "T" or (not suffix and currency == "JPY"):
        return (JAPAN, None)
    if suffix in CHINA_SUFFIXES or (not suffix and currency in CHINA_CURRENCIES):
        return (GREATER_CHINA, None)
    if suffix in EUROPE_SUFFIXES or (not suffix and currency in EUROPE_CURRENCIES):
        return (EUROPE, None)
    if suffix or currency != "USD":
        return (None, None)
    looks_leveraged, leveraged_name = leveraged_etf_parts(conn, ticker, item.get("name") or "")
    if leveraged_name:
        return (LEVERAGED, leveraged_name)
    if looks_leveraged:
        return (None, None)
    if str(item.get("quote_type") or "").upper() == "ETF":
        return (US, None)
    country = str(item.get("country") or "").strip().casefold()
    if not country:
        return (None, None)
    if country in CHINA_COUNTRIES:
        return (GREATER_CHINA, None)
    return (US, None)


def auto_assign_interest_groups(items: list[dict]) -> dict[str, str]:
    """새로 등록한 종목들을 맞는 관심목록 그룹에 넣는다. 돌려주는 값: {티커: 넣은 그룹 이름}."""
    sync_special_interest_items(items)   # 지수·환율은 예전 규칙 그대로(그룹이 없으면 만든다)
    assigned: dict[str, str] = {}
    with connect() as conn:
        groups = {
            str(row["name"]).casefold(): (int(row["id"]), str(row["name"]))
            for row in conn.execute("SELECT id, name FROM interest_watchlist_groups")
        }
        for item in items:
            ticker = str(item.get("ticker") or "").strip().upper()
            if not ticker:
                continue
            if conn.execute("SELECT 1 FROM interest_watchlist_items WHERE UPPER(ticker) = ?", (ticker,)).fetchone():
                continue
            group_name, new_display = suggest_interest_group(conn, item)
            group = groups.get(str(group_name or "").casefold())
            if not group:
                continue
            if insert_interest_item_if_missing(conn, group[0], ticker):
                assigned[ticker] = group[1]
            if new_display:
                # 사용자가 고친 이름은 두고, 자동으로 들어간 기본 이름일 때만 그룹 규칙 이름으로 바꾼다.
                row = conn.execute("SELECT name, display_name FROM tickers WHERE ticker = ?", (ticker,)).fetchone()
                current = str((row["display_name"] if row else "") or "")
                if row and current in {"", default_display_name(row["name"], ticker), str(row["name"] or "")}:
                    conn.execute("UPDATE tickers SET display_name = ? WHERE ticker = ?", (new_display, ticker))
        conn.commit()
    return assigned

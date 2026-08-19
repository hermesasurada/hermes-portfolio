"""NXT(넥스트레이드) 시세 — 한국 개별주의 프리·애프터마켓 연장가격.

KRX 정규장(09:00~15:30) 밖에서도 NXT는 08:00~08:50(프리)·15:30~20:00(애프터)에
거래된다. 미국 연장가격과 같은 필드(extended_price/extended_base_price/...)로
채워 화면 코드를 그대로 쓴다.

제약(2026-08 실측):
- NXT는 ETF를 취급하지 않는다. 우선주·일부 중소형주도 미상장(HTTP 404).
  개별주 커버리지는 약 93%.
- 전용 배치 API가 없다. 폴링 API(SERVICE_ITEM)는 codeType=NXT를 무시하고
  KRX를 돌려주므로 종목별 호출을 병렬로 묶는다(45종목 0.3초 실측).
- NXT 메인마켓(09:00~15:20)은 KRX와 '병행' 거래라 연장이 아니다 — 그 시간대는
  연장으로 취급하지 않는다.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from .market_calendar import korea_equity_calendar_day
from .paths import KST
from .tickers import asset_class, is_korean_stock_ticker, kr_ticker_code

NXT_DETAIL_URL = "https://stock.naver.com/api/domestic/detail/{code}/detail?codeType=NXT"
NXT_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}
NXT_TIMEOUT = 8
NXT_MAX_WORKERS = 8
NXT_CACHE_SECONDS = 30

# 세션 경계(KST 분). 프리·애프터만 '연장'이고 메인은 KRX와 병행이라 제외한다.
NXT_PRE_OPEN = 8 * 60
NXT_PRE_CLOSE = 8 * 60 + 50
NXT_AFTER_OPEN = 15 * 60 + 30
NXT_AFTER_CLOSE = 20 * 60

# 미상장(404) 종목은 되묻지 않는다. 상장 종목 편입은 드물어 프로세스 수명 캐시로 충분.
_UNLISTED: set[str] = set()
_QUOTE_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_LOCK = threading.Lock()


def nxt_session_state(now: datetime | None = None) -> dict:
    """NXT 연장 세션 상태. 주말·한국 공휴일은 닫힘."""
    current = now.astimezone(KST) if now else datetime.now(KST)
    minutes = current.hour * 60 + current.minute
    calendar = korea_equity_calendar_day(current.date())
    open_day = calendar["status"] != "closed"
    phase = "closed"
    if open_day:
        if NXT_PRE_OPEN <= minutes < NXT_PRE_CLOSE:
            phase = "pre"
        elif NXT_AFTER_OPEN <= minutes < NXT_AFTER_CLOSE:
            phase = "after"
        elif NXT_PRE_CLOSE <= minutes < NXT_AFTER_OPEN:
            phase = "main"   # KRX 정규장과 병행 — 연장 아님
    return {
        "market": "NXT",
        "phase": phase,
        "is_extended": phase in {"pre", "after"},
        "label": {"pre": "프리마켓", "after": "애프터마켓", "main": "정규장", "closed": "장 마감"}[phase],
        "closed_reason": calendar["reason"] if not open_day else None,
    }


def _fetch_one(code: str) -> dict | None:
    request = urllib.request.Request(NXT_DETAIL_URL.format(code=code), headers=NXT_HEADERS)
    try:
        with urllib.request.urlopen(request, timeout=NXT_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            _UNLISTED.add(code)   # NXT 미상장 — ETF·우선주·일부 중소형주
        else:
            print(f"[nxt] {code} http {exc.code}")
        return None
    except Exception as exc:
        print(f"[nxt] {code} failed: {type(exc).__name__}")
        return None


def _number(value) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def fetch_nxt_quotes(tickers: list[str], now_ts: float | None = None) -> dict[str, dict]:
    """{ticker: {price, market_state, trade_time}} — 미상장·실패 종목은 빠진다."""
    now_ts = now_ts if now_ts is not None else datetime.now(KST).timestamp()
    targets: list[tuple[str, str]] = []
    result: dict[str, dict] = {}
    for ticker in tickers:
        code = kr_ticker_code(ticker)
        if not code or code in _UNLISTED:
            continue
        with _CACHE_LOCK:
            cached = _QUOTE_CACHE.get(ticker)
        if cached and now_ts - cached[0] < NXT_CACHE_SECONDS:
            result[ticker] = cached[1]
            continue
        targets.append((ticker, code))
    if not targets:
        return result

    with ThreadPoolExecutor(max_workers=min(NXT_MAX_WORKERS, len(targets))) as pool:
        payloads = list(pool.map(lambda item: _fetch_one(item[1]), targets))
    for (ticker, _code), payload in zip(targets, payloads):
        if not payload:
            continue
        price = _number(payload.get("nowPrice"))
        if not price:
            continue
        # 체결시각이 오늘(KST)이 아니면 묵은 값이다. 공휴일 달력이 틀리거나
        # 거래정지 종목이어도 옛 가격이 연장가로 새어나가지 않게 막는다.
        trade_time = str(payload.get("tradeTime") or "")
        if len(trade_time) >= 8 and trade_time[:8] != datetime.now(KST).strftime("%Y%m%d"):
            continue
        item = {
            "price": price,
            "market_state": payload.get("marketStatus"),
            "trade_time": payload.get("tradeTime"),
        }
        with _CACHE_LOCK:
            _QUOTE_CACHE[ticker] = (now_ts, item)
        result[ticker] = item
    return result


def _nxt_candidate(ticker: str, name: str) -> bool:
    """NXT 대상 후보 — 한국 상장 '개별주'만(ETF는 NXT 미취급)."""
    return is_korean_stock_ticker(ticker) and asset_class(ticker, name or "") == "stock"


def apply_kr_live_prices(
    prices: dict[str, dict],
    ticker_rows: list[sqlite3.Row],
    include_extended: bool,
    now: datetime | None = None,
) -> dict:
    """KRX 종가 위에 NXT 연장가격을 얹는다. prices[ticker]를 제자리 갱신."""
    session = nxt_session_state(now)
    candidates = [
        row["ticker"] for row in ticker_rows
        if _nxt_candidate(row["ticker"], (row["name"] if "name" in row.keys() else "") or "")
    ]
    meta = {
        **session,
        "include_extended": bool(include_extended and session["is_extended"]),
        "live_count": 0,
        "candidate_count": len(candidates),
    }
    if not meta["include_extended"] or not candidates:
        return meta

    quotes = fetch_nxt_quotes(candidates)
    for ticker, quote in quotes.items():
        current = prices.get(ticker)
        # 기준가는 오늘 KRX 종가 — 미국판의 regularMarketPrice와 같은 역할
        base = current.get("price") if current else None
        base_price = _number(base)
        extended_price = _number(quote.get("price"))
        if not current or not base_price or not extended_price:
            continue
        change = extended_price - base_price
        current["extended_price"] = extended_price
        current["extended_base_price"] = base_price
        current["extended_change"] = change
        current["extended_change_pct"] = change / base_price * 100
        current["extended_source"] = f"nxt-{session['phase']}"
        current["extended_market_state"] = quote.get("market_state")
        meta["live_count"] += 1
    return meta

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from html import unescape
from pathlib import Path
from typing import Any

from .constants import DIVIDEND_LOOKAHEAD_DAYS, DIVIDEND_LOOKBACK_DAYS, KOREAN_SUFFIXES
from .dates import now_kst_text, parse_iso_date, positive_float, to_iso_text, today_kst
from .opendart_dividends import fetch_opendart_dividends, is_opendart_candidate
from .paths import KST
from .tickers import normalize_yfinance_symbol, ticker_currency

DIVIDEND_CACHE_HOURS = 24
NASDAQ_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
SEIBRO_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
STOCKANALYSIS_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
CURRENCY_SYMBOLS = {
    "$": "USD",
    "€": "EUR",
    "¥": "JPY",
    "₩": "KRW",
}


# 공용 헬퍼 위임 (중복 제거). 사이트별 포맷 파서는 아래에 그대로 둔다.
_today = today_kst
_now_text = now_kst_text
_date_text = to_iso_text
_parse_date = parse_iso_date
_float_value = positive_float


def _date_from_us_text(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.strptime(value.strip(), "%m/%d/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _date_from_short_month_text(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip()
    if text.lower() in {"n/a", "na", "-", "—"}:
        return None
    for fmt in ("%Y-%m-%d", "%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _date_from_kr_text(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip()
    for fmt in ("%Y/%m/%d", "%Y.%m.%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _amount_from_text(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value)
    text = re.sub(r"[^0-9.\-]", "", text)
    return _float_value(text)


def _currency_from_amount_text(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return CURRENCY_SYMBOLS.get(text[:1], fallback)


def _fetch_text(url: str, headers: dict[str, str]) -> str:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=12) as resp:
        return resp.read().decode("utf-8", "ignore")


def _month_name_to_number(name: str) -> int | None:
    months = {
        "january": 1,
        "february": 2,
        "march": 3,
        "april": 4,
        "may": 5,
        "june": 6,
        "july": 7,
        "august": 8,
        "september": 9,
        "october": 10,
        "november": 11,
        "december": 12,
    }
    return months.get(name.lower())


def _date_from_english_text(month: str, day: str, year: str) -> str | None:
    month_number = _month_name_to_number(month)
    if not month_number:
        return None
    try:
        return date(int(year), month_number, int(day)).isoformat()
    except ValueError:
        return None


def _cache_due(fetched_at: str | None) -> bool:
    if not fetched_at:
        return True
    try:
        fetched = datetime.strptime(fetched_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)
    except ValueError:
        return True
    return datetime.now(KST) - fetched > timedelta(hours=DIVIDEND_CACHE_HOURS)


# ── Polygon.io (미국 배당 권위 소스) ────────────────────────────────────────
# 무료 티어 분당 5콜 제한이라 호출을 자체 스로틀링한다. 선언일·기준일·미래
# 확정분까지 제공해 yahoo/stockanalysis/nasdaq 조합보다 풍부.
POLYGON_ENV_PATH = Path.home() / ".hermes" / "polygon.env"
POLYGON_MAX_PER_MIN = 5
POLYGON_DIVIDENDS_URL = "https://api.polygon.io/v3/reference/dividends"
_polygon_key_cache: str | None = None
_polygon_call_times: list[float] = []


def _polygon_api_key() -> str | None:
    global _polygon_key_cache
    if _polygon_key_cache is not None:
        return _polygon_key_cache or None
    key = os.environ.get("POLYGON_API_KEY", "").strip()
    if not key and POLYGON_ENV_PATH.exists():
        try:
            for line in POLYGON_ENV_PATH.read_text().splitlines():
                line = line.strip()
                if line.startswith("POLYGON_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
        except Exception:
            key = ""
    _polygon_key_cache = key
    return key or None


def _polygon_throttle() -> None:
    """분당 POLYGON_MAX_PER_MIN 콜을 넘지 않도록 필요한 만큼 대기 (배치 전용)."""
    now = time.monotonic()
    while _polygon_call_times and now - _polygon_call_times[0] >= 60:
        _polygon_call_times.pop(0)
    if len(_polygon_call_times) >= POLYGON_MAX_PER_MIN:
        wait = 60 - (now - _polygon_call_times[0]) + 0.5
        if wait > 0:
            time.sleep(wait)
        now = time.monotonic()
        while _polygon_call_times and now - _polygon_call_times[0] >= 60:
            _polygon_call_times.pop(0)
    _polygon_call_times.append(time.monotonic())


def _polygon_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker and ticker != "BTC"


def _polygon_attempt_due(ticker: str, status: str | None) -> bool:
    return bool(_polygon_api_key()) and _polygon_candidate(ticker) and "polygon" not in (status or "")


def _fetch_polygon_dividends(ticker: str) -> list[dict]:
    key = _polygon_api_key()
    if not key:
        return []
    params = urllib.parse.urlencode({"ticker": ticker, "limit": 1000, "apiKey": key})
    req = urllib.request.Request(
        f"{POLYGON_DIVIDENDS_URL}?{params}",
        headers={"Accept": "application/json", "User-Agent": "portfolio-dividends/1.0"},
    )
    _polygon_throttle()
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    events = []
    for row in data.get("results", []):
        ex_date = row.get("ex_dividend_date")
        if not ex_date:
            continue
        events.append({
            "ticker": ticker,
            "ex_date": ex_date,
            "pay_date": row.get("pay_date"),
            "declaration_date": row.get("declaration_date"),
            "record_date": row.get("record_date"),
            "amount": _float_value(row.get("cash_amount")),
            "currency": row.get("currency") or "USD",
            "source": "polygon",
        })
    return events


def _nasdaq_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker


def _stockanalysis_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker and ticker != "BTC"


def _seibro_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "KRW" and ticker.upper().endswith(KOREAN_SUFFIXES)


def _nasdaq_attempt_due(ticker: str, status: str | None) -> bool:
    return _nasdaq_candidate(ticker) and "nasdaq" not in (status or "")


def _stockanalysis_attempt_due(ticker: str, status: str | None) -> bool:
    return _stockanalysis_candidate(ticker) and "stockanalysis" not in (status or "")


def _seibro_attempt_due(ticker: str, status: str | None) -> bool:
    return _seibro_candidate(ticker) and "seibro" not in (status or "")


def _opendart_attempt_due(ticker: str, status: str | None) -> bool:
    return is_opendart_candidate(ticker) and "opendart" not in (status or "")


def _kr_history_attempt_due(ticker: str, status: str | None) -> bool:
    return _seibro_candidate(ticker) and "kr_history" not in (status or "")


def _fetch_nasdaq_dividends(ticker: str) -> list[dict]:
    url = f"https://api.nasdaq.com/api/quote/{ticker}/dividends?assetclass=stocks"
    headers = {
        **NASDAQ_HEADERS,
        "Referer": f"https://www.nasdaq.com/market-activity/stocks/{ticker.lower()}/dividend-history",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=12) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    rows = (((payload.get("data") or {}).get("dividends") or {}).get("rows") or [])
    events = []
    for row in rows:
        ex_date = _date_from_us_text(row.get("exOrEffDate"))
        amount = _amount_from_text(row.get("amount"))
        if not ex_date or amount is None:
            continue
        dividend_type = str(row.get("type") or "").lower()
        if dividend_type and "cash" not in dividend_type:
            continue
        events.append(
            {
                "ticker": ticker,
                "ex_date": ex_date,
                "pay_date": _date_from_us_text(row.get("paymentDate")),
                "amount": amount,
                "currency": row.get("currency") or "USD",
                "source": "nasdaq",
            }
        )
    return events


def _fetch_seibro_dividends(ticker: str, name: str | None = None) -> list[dict]:
    code = ticker.split(".", 1)[0]
    if not re.fullmatch(r"\d{6}", code) or not name:
        return []
    query = urllib.parse.urlencode({"shotn_isin": code, "txt_sch": name})
    url = f"https://m.seibro.or.kr/cmuc/company/selectCompanySchedule.do?{query}"
    html = _fetch_text(url, SEIBRO_HEADERS)
    events = []
    for row_match in re.finditer(r"<tr>\s*(.*?)\s*</tr>", html, re.DOTALL):
        cells = [
            unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cell))).strip()
            for cell in re.findall(r"<td[^>]*>(.*?)</td>", row_match.group(1), re.DOTALL)
        ]
        if len(cells) < 2 or cells[1] != "배당/분배":
            continue
        record_date = _date_from_kr_text(cells[0])
        if not record_date:
            continue
        events.append(
            {
                "ticker": ticker,
                "ex_date": record_date,
                "pay_date": None,
                "amount": None,
                "currency": "KRW",
                "source": "seibro",
            }
        )
    return events


def _stockanalysis_urls(ticker: str) -> tuple[str, ...]:
    symbol = ticker.lower()
    return (
        f"https://stockanalysis.com/stocks/{symbol}/dividend/",
        f"https://stockanalysis.com/etf/{symbol}/dividend/",
    )


def _js_string_field(text: str, key: str) -> str | None:
    match = re.search(rf"{re.escape(key)}:\"((?:\\.|[^\"])*)\"", text)
    if not match:
        return None
    return bytes(match.group(1), "utf-8").decode("unicode_escape")


def _fetch_stockanalysis_dividends(ticker: str) -> list[dict]:
    fallback_currency = ticker_currency(ticker)
    html = ""
    for url in _stockanalysis_urls(ticker):
        try:
            html = _fetch_text(url, STOCKANALYSIS_HEADERS)
            if "history:[" in html:
                break
        except Exception:
            continue
    if "history:[" not in html:
        return []

    block_match = re.search(r"history:\[(.*?)\],chartData:", html, re.DOTALL)
    if not block_match:
        return []
    events = []
    for row_match in re.finditer(r"\{([^{}]+)\}", block_match.group(1)):
        row = row_match.group(1)
        ex_date = _date_from_short_month_text(_js_string_field(row, "dt"))
        amount_text = _js_string_field(row, "amt")
        amount = _amount_from_text(amount_text)
        if not ex_date or amount is None:
            continue
        events.append(
            {
                "ticker": ticker,
                "ex_date": ex_date,
                "pay_date": _date_from_short_month_text(_js_string_field(row, "pay")),
                "amount": amount,
                "currency": _currency_from_amount_text(amount_text, fallback_currency),
                "source": "stockanalysis",
            }
        )
    return events


def _fetch_yahoo_dividends(ticker: str) -> list[dict]:
    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker) or ticker
    stock = yf.Ticker(symbol)
    currency = ticker_currency(ticker)
    events: dict[str, dict] = {}

    hist = stock.history(period="18mo", actions=True)
    if hist is not None and not hist.empty and "Dividends" in hist:
        dividends = hist[hist["Dividends"].fillna(0) > 0]["Dividends"]
        for idx, amount in dividends.items():
            ex_date = _date_text(idx)
            amount_value = _float_value(amount)
            if ex_date and amount_value:
                events[ex_date] = {
                    "ticker": ticker,
                    "ex_date": ex_date,
                    "pay_date": None,
                    "amount": amount_value,
                    "currency": currency,
                    "source": "yf-history",
                }

    try:
        calendar = stock.calendar or {}
    except Exception:
        calendar = {}
    ex_date = _date_text(calendar.get("Ex-Dividend Date"))
    pay_date = _date_text(calendar.get("Dividend Date"))
    if ex_date:
        last_amount = None
        if events:
            last_amount = events[sorted(events)[-1]].get("amount")
        event = events.get(ex_date) or {
            "ticker": ticker,
            "ex_date": ex_date,
            "amount": last_amount,
            "currency": currency,
            "source": "yf-calendar",
        }
        event["pay_date"] = pay_date or event.get("pay_date")
        event["source"] = "yf-calendar"
        events[ex_date] = event

    return list(events.values())


def _source_error(source: str, ticker: str, exc: Exception) -> str:
    """소스별 수집 실패를 상태문자열+로그 한 줄로 남긴다 (launchd 로그로 추적 가능).
    상태는 'xxx_error(TypeName)' 형태 — 진단의 LIKE '%_error%' 매칭 유지."""
    print(f"[dividends] {ticker} {source} failed: {type(exc).__name__}: {exc}")
    return f"{source}_error({type(exc).__name__})"


def _fetch_dividends(ticker: str, name: str | None = None) -> tuple[list[dict], str]:
    events: dict[str, dict] = {}
    sources = []
    if _seibro_candidate(ticker):
        # OpenDART(현금배당결정 공시) = 한국 배당 권위 소스. 확정 주당배당금·
        # 배당기준일·지급예정일을 먼저 깔고(미래 확정분 포함), SEIBRO/yfinance는
        # OpenDART와 ±4일 내 겹치지 않는 ex_date만 보강(중복 방지).
        opendart_ex_dates: list[date] = []
        if is_opendart_candidate(ticker):
            try:
                opendart_events = fetch_opendart_dividends(ticker)
                sources.append("opendart" if opendart_events else "opendart0")
                for event in opendart_events:
                    if event.get("ex_date"):
                        events[event["ex_date"]] = event
                        try:
                            opendart_ex_dates.append(date.fromisoformat(event["ex_date"]))
                        except ValueError:
                            pass
            except Exception as exc:
                sources.append(_source_error("opendart", ticker, exc))

        def _near_opendart(ex_date_text: str) -> bool:
            if not opendart_ex_dates:
                return False
            try:
                d = date.fromisoformat(ex_date_text)
            except ValueError:
                return False
            return any(abs((d - od).days) <= 4 for od in opendart_ex_dates)

        try:
            seibro_events = _fetch_seibro_dividends(ticker, name)
            sources.append("seibro" if seibro_events else "seibro0")
            for event in seibro_events:
                ex = event.get("ex_date")
                if ex and not _near_opendart(ex):
                    events.setdefault(ex, event)
        except Exception as exc:
            sources.append(_source_error("seibro", ticker, exc))
        try:
            history_events = [
                event for event in _fetch_yahoo_dividends(ticker)
                if event.get("source") == "yf-history" and event.get("amount") is not None
            ]
            sources.append("kr_history" if history_events else "kr_history0")
            for event in history_events:
                ex = event.get("ex_date")
                if ex and not _near_opendart(ex):
                    events.setdefault(ex, {
                        **event,
                        "source": "kr-history",
                    })
        except Exception as exc:
            sources.append(_source_error("kr_history", ticker, exc))
    else:
        try:
            yahoo_events = _fetch_yahoo_dividends(ticker)
            if yahoo_events:
                sources.append("yahoo")
            for event in yahoo_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("yahoo", ticker, exc))

    if _stockanalysis_candidate(ticker):
        try:
            stockanalysis_events = _fetch_stockanalysis_dividends(ticker)
            sources.append("stockanalysis" if stockanalysis_events else "stockanalysis0")
            for event in stockanalysis_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("stockanalysis", ticker, exc))

    if _nasdaq_candidate(ticker):
        try:
            nasdaq_events = _fetch_nasdaq_dividends(ticker)
            sources.append("nasdaq" if nasdaq_events else "nasdaq0")
            for event in nasdaq_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("nasdaq", ticker, exc))

    # Polygon: 권위 소스이므로 마지막에 같은 ex_date를 덮어써 선언일/기준일/미래
    # 확정분까지 채운다. (분당 5콜 스로틀은 _fetch_polygon_dividends 내부 처리)
    if _polygon_candidate(ticker) and _polygon_api_key():
        try:
            polygon_events = _fetch_polygon_dividends(ticker)
            sources.append("polygon" if polygon_events else "polygon0")
            for event in polygon_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception as exc:
            sources.append(_source_error("polygon", ticker, exc))

    return list(events.values()), "+".join(sources) or "none"

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from html import unescape
from typing import Any

from .constants import KOREAN_SUFFIXES
from .paths import KST
from .tickers import normalize_yfinance_symbol, ticker_currency

DIVIDEND_CACHE_HOURS = 24
DIVIDEND_LOOKBACK_DAYS = 30
DIVIDEND_LOOKAHEAD_DAYS = 365
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
NASDAQ_PRESS_RELEASE_URLS = {
    "DE": (
        "https://www.nasdaq.com/press-release/deere-company-announces-quarterly-dividend-2026-02-25",
    ),
}
STOCKANALYSIS_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
DIVIDENDMAX_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
}
DIVIDENDMAX_URLS = {
    "DE": (
        "https://www.dividendmax.com/united-states/nyse/financial-services/deere-and-co/dividends",
    ),
}
CURRENCY_SYMBOLS = {
    "$": "USD",
    "€": "EUR",
    "¥": "JPY",
    "₩": "KRW",
}


def _today() -> date:
    return datetime.now(KST).date()


def _now_text() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


def _date_text(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "date") and not isinstance(value, date):
        value = value.date()
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    text = str(value)
    return text[:10] if len(text) >= 10 else None


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.strptime(value[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


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


def _float_value(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


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


def _nasdaq_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker


def _stockanalysis_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "USD" and "." not in ticker and ticker != "BTC"


def _seibro_candidate(ticker: str) -> bool:
    return ticker_currency(ticker) == "KRW" and ticker.upper().endswith(KOREAN_SUFFIXES)


def _nasdaq_attempt_due(ticker: str, status: str | None) -> bool:
    status_text = status or ""
    if not _nasdaq_candidate(ticker):
        return False
    if "nasdaq" not in status_text:
        return True
    return bool(NASDAQ_PRESS_RELEASE_URLS.get(ticker)) and "nasdaq_press" not in status_text


def _stockanalysis_attempt_due(ticker: str, status: str | None) -> bool:
    return _stockanalysis_candidate(ticker) and "stockanalysis" not in (status or "")


def _dividendmax_attempt_due(ticker: str, status: str | None) -> bool:
    return bool(DIVIDENDMAX_URLS.get(ticker)) and "dividendmax" not in (status or "")


def _seibro_attempt_due(ticker: str, status: str | None) -> bool:
    return _seibro_candidate(ticker) and "seibro" not in (status or "")


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


def _fetch_dividendmax_dividends(ticker: str) -> list[dict]:
    events = []
    for url in DIVIDENDMAX_URLS.get(ticker, ()):
        html = _fetch_text(url, DIVIDENDMAX_HEADERS)
        for row_match in re.finditer(r"<tr class='mdc-data-table__row'>(.*?)</tr>", html, re.DOTALL):
            cells = [
                unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cell))).strip()
                for cell in re.findall(r"<td class='mdc-data-table__cell'>(.*?)</td>", row_match.group(1), re.DOTALL)
            ]
            if len(cells) < 8 or cells[0] not in {"Paid", "Declared"}:
                continue
            amount = _amount_from_text(cells[7])
            if amount is None:
                continue
            if cells[7].lower().endswith("c"):
                amount /= 100
            ex_date = _date_from_short_month_text(cells[3])
            if not ex_date:
                continue
            events.append(
                {
                    "ticker": ticker,
                    "ex_date": ex_date,
                    "pay_date": _date_from_short_month_text(cells[4]),
                    "amount": amount,
                    "currency": cells[5] or ticker_currency(ticker),
                    "source": "dividendmax",
                }
            )
    return events


def _fetch_nasdaq_press_release_dividends(ticker: str) -> list[dict]:
    events = []
    for url in NASDAQ_PRESS_RELEASE_URLS.get(ticker, ()):
        req = urllib.request.Request(url, headers=NASDAQ_HEADERS)
        with urllib.request.urlopen(req, timeout=12) as resp:
            html = resp.read().decode("utf-8", "ignore")
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
        amount_match = re.search(r"dividend of \$([0-9]+(?:\.[0-9]+)?) per share", text, re.IGNORECASE)
        pay_match = re.search(r"payable ([A-Z][a-z]+) (\d{1,2}), (\d{4})", text)
        record_match = re.search(r"(?:record|stockholders of record) (?:as of |on )([A-Z][a-z]+) (\d{1,2}), (\d{4})", text)
        amount = _amount_from_text(amount_match.group(1) if amount_match else None)
        pay_date = _date_from_english_text(*pay_match.groups()) if pay_match else None
        record_date = _date_from_english_text(*record_match.groups()) if record_match else None
        if amount is None or not pay_date or not record_date:
            continue
        events.append(
            {
                "ticker": ticker,
                "ex_date": record_date,
                "pay_date": pay_date,
                "amount": amount,
                "currency": "USD",
                "source": "nasdaq-press",
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


def _fetch_dividends(ticker: str, name: str | None = None) -> tuple[list[dict], str]:
    events: dict[str, dict] = {}
    sources = []
    if _seibro_candidate(ticker):
        try:
            seibro_events = _fetch_seibro_dividends(ticker, name)
            sources.append("seibro" if seibro_events else "seibro0")
            for event in seibro_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception:
            sources.append("seibro_error")
        try:
            history_events = [
                event for event in _fetch_yahoo_dividends(ticker)
                if event.get("source") == "yf-history" and event.get("amount") is not None
            ]
            sources.append("kr_history" if history_events else "kr_history0")
            for event in history_events:
                if event.get("ex_date"):
                    events.setdefault(event["ex_date"], {
                        **event,
                        "source": "kr-history",
                    })
        except Exception:
            sources.append("kr_history_error")
    else:
        try:
            yahoo_events = _fetch_yahoo_dividends(ticker)
            if yahoo_events:
                sources.append("yahoo")
            for event in yahoo_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception:
            sources.append("yahoo_error")

    if _stockanalysis_candidate(ticker):
        try:
            stockanalysis_events = _fetch_stockanalysis_dividends(ticker)
            sources.append("stockanalysis" if stockanalysis_events else "stockanalysis0")
            for event in stockanalysis_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception:
            sources.append("stockanalysis_error")

    if _nasdaq_candidate(ticker):
        try:
            nasdaq_events = _fetch_nasdaq_dividends(ticker)
            sources.append("nasdaq" if nasdaq_events else "nasdaq0")
            for event in nasdaq_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception:
            sources.append("nasdaq_error")
        try:
            press_events = _fetch_nasdaq_press_release_dividends(ticker)
            if press_events:
                sources.append("nasdaq_press")
            for event in press_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception:
            sources.append("nasdaq_press_error")

    if DIVIDENDMAX_URLS.get(ticker):
        try:
            dividendmax_events = _fetch_dividendmax_dividends(ticker)
            sources.append("dividendmax" if dividendmax_events else "dividendmax0")
            for event in dividendmax_events:
                if event.get("ex_date"):
                    events[event["ex_date"]] = event
        except Exception:
            sources.append("dividendmax_error")

    return list(events.values()), "+".join(sources) or "none"

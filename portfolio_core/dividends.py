from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from html import unescape
from typing import Any

from .constants import FX_DEFAULT_RATES, KOREAN_SUFFIXES
from .db import connect, ensure_dividend_tables
from .paths import KST
from .prices import latest_prices
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


def _add_one_year(value: date) -> date:
    try:
        return value.replace(year=value.year + 1)
    except ValueError:
        return value.replace(year=value.year + 1, day=28)


KR_MARKET_HOLIDAY_OVERRIDES = {
    "2026-05-04",
}


def _kr_market_holidays(year: int) -> set[date]:
    fixed_days = (
        (1, 1),
        (3, 1),
        (5, 1),
        (5, 5),
        (6, 6),
        (8, 15),
        (10, 3),
        (10, 9),
        (12, 25),
    )
    holidays = {date(year, month, day) for month, day in fixed_days}
    holidays.update(
        parsed
        for parsed in (_parse_date(value) for value in KR_MARKET_HOLIDAY_OVERRIDES)
        if parsed and parsed.year == year
    )
    return holidays


def _is_kr_business_day(value: date) -> bool:
    return value.weekday() < 5 and value not in _kr_market_holidays(value.year)


def _nth_kr_business_day(year: int, month: int, nth: int) -> date:
    current = date(year, month, 1)
    count = 0
    while current.month == month:
        if _is_kr_business_day(current):
            count += 1
            if count == nth:
                return current
        current += timedelta(days=1)
    return date(year, month, 1)


def _next_month(value: date) -> tuple[int, int]:
    if value.month == 12:
        return value.year + 1, 1
    return value.year, value.month + 1


def _estimated_kr_monthly_etf_pay_date(record_date: date) -> date:
    year, month = _next_month(record_date)
    return _nth_kr_business_day(year, month, 2)


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


def refresh_dividend_events(tickers: list[str]) -> None:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return
    now = _now_text()
    with connect() as conn:
        ensure_dividend_tables(conn)
        placeholders = ",".join("?" for _ in clean_tickers)
        rows = conn.execute(
            f"""
            SELECT c.ticker, c.fetched_at, c.status, tk.name
            FROM ticker_dividend_cache c
            LEFT JOIN tickers tk ON tk.ticker = c.ticker
            WHERE c.ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall()
        fetched = {row["ticker"]: row["fetched_at"] for row in rows}
        statuses = {row["ticker"]: row["status"] for row in rows}
        names = {row["ticker"]: row["name"] for row in rows}
        for row in conn.execute(
            f"""
            SELECT ticker, name
            FROM tickers
            WHERE ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall():
            names[row["ticker"]] = row["name"]
        due = [
            ticker for ticker in clean_tickers
            if (
                _cache_due(fetched.get(ticker))
                or _stockanalysis_attempt_due(ticker, statuses.get(ticker))
                or _nasdaq_attempt_due(ticker, statuses.get(ticker))
                or _dividendmax_attempt_due(ticker, statuses.get(ticker))
                or _seibro_attempt_due(ticker, statuses.get(ticker))
                or _kr_history_attempt_due(ticker, statuses.get(ticker))
            )
        ]
        conn.commit()

    if not due:
        return

    with connect() as conn:
        ensure_dividend_tables(conn)
        for ticker in due:
            events, status = _fetch_dividends(ticker, names.get(ticker))
            if _seibro_candidate(ticker):
                conn.execute(
                    "DELETE FROM dividend_events WHERE ticker = ? AND source NOT IN ('seibro', 'kr-history')",
                    (ticker,),
                )
            for event in events:
                if not event.get("ex_date"):
                    continue
                conn.execute(
                    """
                    INSERT INTO dividend_events
                      (ticker, ex_date, pay_date, amount, currency, source, fetched_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(ticker, ex_date) DO UPDATE SET
                        pay_date = COALESCE(excluded.pay_date, dividend_events.pay_date),
                        amount = COALESCE(excluded.amount, dividend_events.amount),
                        currency = COALESCE(excluded.currency, dividend_events.currency),
                        source = excluded.source,
                        fetched_at = excluded.fetched_at
                    """,
                    (
                        ticker,
                        event["ex_date"],
                        event.get("pay_date"),
                        event.get("amount"),
                        event.get("currency") or ticker_currency(ticker),
                        event.get("source") or "yf",
                        now,
                    ),
                )
            conn.execute(
                """
                INSERT INTO ticker_dividend_cache (ticker, fetched_at, status)
                VALUES (?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    fetched_at = excluded.fetched_at,
                    status = excluded.status
                """,
                (ticker, now, status),
            )
        conn.commit()


def _tax_rate(currency: str) -> float:
    if currency == "KRW":
        return 15.4
    if currency == "JPY":
        return 15.315
    return 15.0


def _event_schedule_date(event) -> date | None:
    return _parse_date(event["pay_date"] or event["ex_date"])


def _same_period_key(value: date) -> tuple[int, int]:
    return value.month, min(value.day, 28)


def _closest_same_period_event(event, history_rows):
    target = _event_schedule_date(event)
    if not target:
        return None
    candidates = []
    for row in history_rows:
        if row["ticker"] != event["ticker"] or _float_value(row["amount"]) is None:
            continue
        row_date = _event_schedule_date(row)
        if not row_date or row_date >= target:
            continue
        if row_date.month != target.month:
            continue
        year_distance = abs((target.year - 1) - row_date.year)
        day_distance = abs(min(target.day, 28) - min(row_date.day, 28))
        candidates.append((year_distance, day_distance, -row_date.toordinal(), row))
    if not candidates:
        return None
    candidates.sort()
    return candidates[0][3]


def _monthly_distribution_tickers(history_rows) -> set[str]:
    months_by_ticker: dict[str, set[tuple[int, int]]] = {}
    cutoff = _today() - timedelta(days=550)
    for row in history_rows:
        if row["source"] != "kr-history" or _float_value(row["amount"]) is None:
            continue
        row_date = _event_schedule_date(row)
        if not row_date or row_date < cutoff:
            continue
        months_by_ticker.setdefault(row["ticker"], set()).add((row_date.year, row_date.month))
    return {ticker for ticker, months in months_by_ticker.items() if len(months) >= 8}


def _apply_monthly_kr_pay_date(candidate: dict, monthly_tickers: set[str]) -> None:
    if candidate.get("ticker") not in monthly_tickers:
        return
    source = str(candidate.get("source") or "")
    if not any(marker in source for marker in ("kr-history", "estimated-history", "seibro+history")):
        return
    record_date = _parse_date(candidate.get("ex_date") or candidate.get("pay_date"))
    if not record_date:
        return
    candidate["pay_date"] = _estimated_kr_monthly_etf_pay_date(record_date).isoformat()
    candidate["pay_date_estimated"] = True


def _consolidated_dividend_events(event_rows, history_rows) -> list[dict]:
    grouped: dict[tuple[str, int, int], dict] = {}
    monthly_tickers = _monthly_distribution_tickers(history_rows)
    for event in [*event_rows, *_estimated_events(history_rows, _today() - timedelta(days=DIVIDEND_LOOKBACK_DAYS), _today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS), event_rows)]:
        candidate = dict(event)
        candidate_amount = _float_value(candidate.get("amount"))
        if candidate_amount is None:
            reference = _closest_same_period_event(candidate, history_rows)
            if reference:
                candidate["amount"] = reference["amount"]
                candidate["currency"] = candidate["currency"] or reference["currency"]
                candidate["pay_date_estimated"] = True
                candidate["source"] = f"{candidate['source']}+history"
        if candidate.get("pay_date") is None and _float_value(candidate.get("amount")) is not None:
            candidate["pay_date"] = candidate.get("ex_date")
            candidate["pay_date_estimated"] = True
        if str(candidate.get("source") or "").startswith("estimated-history"):
            candidate["pay_date_estimated"] = True
        _apply_monthly_kr_pay_date(candidate, monthly_tickers)
        schedule_date = _event_schedule_date(candidate)
        if not schedule_date:
            continue
        key = (candidate["ticker"], schedule_date.year, schedule_date.month)
        current = grouped.get(key)
        if not current:
            grouped[key] = candidate
            continue
        current_amount = _float_value(current.get("amount"))
        next_amount = _float_value(candidate.get("amount"))
        if current_amount is None and next_amount is not None:
            current["amount"] = candidate["amount"]
            current["currency"] = current["currency"] or candidate["currency"]
            current["pay_date"] = current.get("pay_date") or candidate.get("pay_date")
            current["pay_date_estimated"] = current.get("pay_date_estimated") or candidate.get("pay_date_estimated")
            current["source"] = f"{current['source']}+history" if "history" not in str(current.get("source")) else current["source"]
        if not current.get("ex_date") and candidate.get("ex_date"):
            current["ex_date"] = candidate["ex_date"]
    return list(grouped.values())


def _estimated_events(history_rows, start: date, end: date, actual_rows) -> list[dict]:
    actual_months: set[tuple[str, int, int]] = set()
    for event in actual_rows:
        for text in (event["pay_date"], event["ex_date"]):
            actual_date = _parse_date(text)
            if actual_date:
                actual_months.add((event["ticker"], actual_date.year, actual_date.month))

    estimates = []
    seen: set[tuple[str, str]] = set()
    today = _today()
    for event in history_rows:
        base_date = _event_schedule_date(event)
        if not base_date or base_date > today:
            continue
        estimated_pay_date = _add_one_year(base_date)
        if estimated_pay_date < start or estimated_pay_date > end:
            continue
        if (event["ticker"], estimated_pay_date.year, estimated_pay_date.month) in actual_months:
            continue
        key = (event["ticker"], estimated_pay_date.isoformat())
        if key in seen:
            continue
        amount = _float_value(event["amount"])
        if amount is None:
            continue
        seen.add(key)
        estimates.append(
            {
                "ticker": event["ticker"],
                "ex_date": None,
                "pay_date": estimated_pay_date.isoformat(),
                "amount": amount,
                "currency": event["currency"],
                "source": "estimated-history",
            }
        )
    return estimates


def load_dividends(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = [int(value) for value in (account_ids or []) if str(value).strip()]
    account_filter = ""
    params: list[object] = []
    if cleaned_account_ids:
        placeholders = ",".join("?" for _ in cleaned_account_ids)
        account_filter = f"WHERE a.id IN ({placeholders})"
        params.extend(cleaned_account_ids)

    start = _today() - timedelta(days=DIVIDEND_LOOKBACK_DAYS)
    end = _today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS)

    with connect() as conn:
        ensure_dividend_tables(conn)
        holding_rows = conn.execute(
            f"""
            SELECT
                h.account_id,
                a.member,
                a.account_type,
                a.name AS account_name,
                h.ticker,
                h.qty,
                COALESCE(h.currency, tk.currency, '') AS currency,
                COALESCE(tk.name, h.name, h.ticker) AS name
            FROM holdings h
            JOIN accounts a ON a.id = h.account_id
            LEFT JOIN tickers tk ON tk.ticker = h.ticker
            {account_filter}
            ORDER BY a.id, h.ticker
            """,
            params,
        ).fetchall()

    holdings = [
        {
            "account_id": str(row["account_id"]),
            "member": row["member"],
            "account_type": row["account_type"],
            "account_name": row["account_name"],
            "ticker": row["ticker"],
            "name": row["name"] or row["ticker"],
            "qty": float(row["qty"] or 0),
            "currency": row["currency"] or ticker_currency(row["ticker"]),
        }
        for row in holding_rows
        if row["ticker"] and float(row["qty"] or 0) > 0
    ]
    tickers = sorted({row["ticker"] for row in holdings})
    refresh_dividend_events(tickers)

    with connect() as conn:
        ensure_dividend_tables(conn)
        prices = latest_prices(conn)
        placeholders = ",".join("?" for _ in tickers) if tickers else "''"
        event_rows = conn.execute(
            f"""
            SELECT ticker, ex_date, pay_date, amount, currency, source, fetched_at
            FROM dividend_events
            WHERE ticker IN ({placeholders})
              AND date(COALESCE(pay_date, ex_date)) BETWEEN ? AND ?
            ORDER BY date(COALESCE(pay_date, ex_date)), ticker
            """,
            [*tickers, start.isoformat(), end.isoformat()] if tickers else [start.isoformat(), end.isoformat()],
        ).fetchall()
        history_rows = conn.execute(
            f"""
            SELECT ticker, ex_date, pay_date, amount, currency, source, fetched_at
            FROM dividend_events
            WHERE ticker IN ({placeholders})
              AND amount IS NOT NULL
            ORDER BY ticker, date(COALESCE(pay_date, ex_date))
            """,
            tickers if tickers else [],
        ).fetchall()
        cache_rows = conn.execute(
            f"""
            SELECT ticker, fetched_at, status
            FROM ticker_dividend_cache
            WHERE ticker IN ({placeholders})
            """,
            tickers if tickers else [],
        ).fetchall()

    holdings_by_ticker: dict[str, list[dict]] = {}
    for holding in holdings:
        holdings_by_ticker.setdefault(holding["ticker"], []).append(holding)

    rates = {
        "KRW": 1.0,
        "USD": float(prices.get("USDKRW", {}).get("price") or FX_DEFAULT_RATES["USD"]),
        "EUR": float(prices.get("EURKRW", {}).get("price") or FX_DEFAULT_RATES["EUR"]),
        "JPY": float(prices.get("JPYKRW", {}).get("price") or FX_DEFAULT_RATES["JPY"]),
    }
    rows = []
    dividend_events = [
        event for event in _consolidated_dividend_events(event_rows, history_rows)
        if start <= (_event_schedule_date(event) or start) <= end
    ]
    for event in dividend_events:
        currency = event["currency"] or ticker_currency(event["ticker"])
        amount = _float_value(event["amount"])
        rate = rates.get(currency, 1.0)
        tax_rate = _tax_rate(currency)
        for holding in holdings_by_ticker.get(event["ticker"], []):
            qty = holding["qty"]
            gross = amount * qty if amount is not None else None
            tax = gross * tax_rate / 100 if gross is not None else None
            net = gross - tax if gross is not None and tax is not None else None
            net_krw = net * rate if net is not None else None
            rows.append(
                {
                    "pay_date": event["pay_date"],
                    "ex_date": event["ex_date"],
                    "pay_date_estimated": bool(event.get("pay_date_estimated")),
                    "ex_date_estimated": bool(event.get("ex_date_estimated")),
                    "member": holding["member"],
                    "account_id": holding["account_id"],
                    "ticker": event["ticker"],
                    "currency": currency,
                    "name": holding["name"],
                    "amount": amount,
                    "qty": qty,
                    "gross": gross,
                    "tax_rate": tax_rate,
                    "net": net,
                    "fx_rate": rate if currency != "KRW" else None,
                    "net_krw": net_krw,
                    "source": event["source"],
                }
            )
    rows.sort(key=lambda row: (row["pay_date"] or "", row["ex_date"] or "", row["ticker"], row["account_id"]))
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "updated_at": max((row["fetched_at"] for row in cache_rows), default=None),
        "rows": rows,
    }

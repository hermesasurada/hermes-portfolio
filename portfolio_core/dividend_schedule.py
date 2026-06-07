from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any

from .paths import KST

DIVIDEND_LOOKBACK_DAYS = 30
DIVIDEND_LOOKAHEAD_DAYS = 365
KR_MARKET_HOLIDAY_OVERRIDES = {
    "2026-05-04",
}


def today() -> date:
    return datetime.now(KST).date()


def parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.strptime(value[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def float_value(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def add_one_year(value: date) -> date:
    try:
        return value.replace(year=value.year + 1)
    except ValueError:
        return value.replace(year=value.year + 1, day=28)


def add_one_month(value: date) -> date:
    year, month = next_month(value)
    day = value.day
    while day > 28:
        try:
            return date(year, month, day)
        except ValueError:
            day -= 1
    return date(year, month, day)


def kr_market_holidays(year: int) -> set[date]:
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
        for parsed in (parse_date(value) for value in KR_MARKET_HOLIDAY_OVERRIDES)
        if parsed and parsed.year == year
    )
    return holidays


def is_kr_business_day(value: date) -> bool:
    return value.weekday() < 5 and value not in kr_market_holidays(value.year)


def previous_kr_business_day(value: date) -> date:
    current = value - timedelta(days=1)
    while not is_kr_business_day(current):
        current -= timedelta(days=1)
    return current


def nth_kr_business_day(year: int, month: int, nth: int) -> date:
    current = date(year, month, 1)
    count = 0
    while current.month == month:
        if is_kr_business_day(current):
            count += 1
            if count == nth:
                return current
        current += timedelta(days=1)
    return date(year, month, 1)


def next_month(value: date) -> tuple[int, int]:
    if value.month == 12:
        return value.year + 1, 1
    return value.year, value.month + 1


def estimated_kr_monthly_etf_pay_date(record_date: date) -> date:
    year, month = next_month(record_date)
    return nth_kr_business_day(year, month, 2)


def event_schedule_date(event) -> date | None:
    return parse_date(event["pay_date"] or event["ex_date"])


def closest_same_period_event(event, history_rows):
    target = parse_date(event.get("record_date") or event.get("ex_date") or event.get("pay_date"))
    if not target:
        return None
    candidates = []
    for row in history_rows:
        if row["ticker"] != event["ticker"] or float_value(row["amount"]) is None:
            continue
        row_date = event_schedule_date(row)
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


def monthly_distribution_tickers(history_rows) -> set[str]:
    months_by_ticker: dict[str, set[tuple[int, int]]] = {}
    cutoff = today() - timedelta(days=550)
    for row in history_rows:
        if row["source"] != "kr-history" or float_value(row["amount"]) is None:
            continue
        row_date = event_schedule_date(row)
        if not row_date or row_date < cutoff:
            continue
        months_by_ticker.setdefault(row["ticker"], set()).add((row_date.year, row_date.month))
    return {ticker for ticker, months in months_by_ticker.items() if len(months) >= 8}


def apply_monthly_kr_pay_date(candidate: dict, monthly_tickers: set[str]) -> None:
    if candidate.get("ticker") not in monthly_tickers:
        return
    source = str(candidate.get("source") or "")
    if not any(marker in source for marker in ("kr-history", "estimated-history", "seibro+history")):
        return
    record_date = parse_date(candidate.get("record_date") or candidate.get("ex_date") or candidate.get("pay_date"))
    if not record_date:
        return
    candidate["pay_date"] = estimated_kr_monthly_etf_pay_date(record_date).isoformat()
    candidate["pay_date_estimated"] = True


def normalize_seibro_record_date(candidate: dict) -> None:
    source = str(candidate.get("source") or "")
    if "seibro" not in source:
        return
    record_date = parse_date(candidate.get("ex_date"))
    if not record_date:
        return
    candidate["record_date"] = record_date.isoformat()
    candidate["ex_date"] = previous_kr_business_day(record_date).isoformat()
    if not candidate.get("pay_date"):
        candidate["pay_date"] = add_one_month(record_date).isoformat()
        candidate["pay_date_estimated"] = True


ESTIMATE_DEDUP_WINDOW_DAYS = 45   # 확정 배당과 ±45일 내 추정은 같은 분기로 보고 제외


def estimated_events(history_rows, start: date, end: date, actual_rows) -> list[dict]:
    # 확정 이벤트의 실제 날짜 목록(종목별). 추정 지급일이 확정분과 ±45일 내면
    # 같은 분기 배당으로 보고 추정을 만들지 않는다(연도별로 지급월이 6월↔7월처럼
    # 경계를 넘나드는 경우까지 잡기 위해 월 단위가 아닌 날짜 근접으로 판정).
    actual_dates_by_ticker: dict[str, list[date]] = {}
    for event in actual_rows:
        for text in (event["pay_date"], event["ex_date"]):
            actual_date = parse_date(text)
            if actual_date:
                actual_dates_by_ticker.setdefault(event["ticker"], []).append(actual_date)

    estimates = []
    seen: set[tuple[str, str]] = set()
    today_value = today()
    latest_amount_by_ticker: dict[str, tuple[date, float, str]] = {}
    for row in history_rows:
        row_date = event_schedule_date(row)
        amount = float_value(row["amount"])
        if not row_date or row_date > end or amount is None:
            continue
        ticker = row["ticker"]
        current = latest_amount_by_ticker.get(ticker)
        if current is None or row_date > current[0]:
            latest_amount_by_ticker[ticker] = (row_date, amount, row["currency"])

    for event in history_rows:
        base_date = event_schedule_date(event)
        if not base_date or base_date > today_value:
            continue
        estimated_pay_date = add_one_year(base_date)
        if estimated_pay_date < start or estimated_pay_date > end:
            continue
        actual_dates = actual_dates_by_ticker.get(event["ticker"], [])
        if any(abs((estimated_pay_date - actual_date).days) <= ESTIMATE_DEDUP_WINDOW_DAYS for actual_date in actual_dates):
            continue
        key = (event["ticker"], estimated_pay_date.isoformat())
        if key in seen:
            continue
        latest = latest_amount_by_ticker.get(event["ticker"])
        if latest is None:
            continue
        _, amount, currency = latest
        seen.add(key)
        estimates.append(
            {
                "ticker": event["ticker"],
                "ex_date": None,
                "pay_date": estimated_pay_date.isoformat(),
                "amount": amount,
                "currency": currency,
                "source": "estimated-history",
            }
        )
    return estimates


def consolidated_dividend_events(event_rows, history_rows) -> list[dict]:
    start = today() - timedelta(days=DIVIDEND_LOOKBACK_DAYS)
    end = today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS)
    grouped: dict[tuple[str, int, int], dict] = {}
    monthly_tickers = monthly_distribution_tickers(history_rows)
    for event in [*event_rows, *estimated_events(history_rows, start, end, event_rows)]:
        candidate = dict(event)
        normalize_seibro_record_date(candidate)
        candidate_amount = float_value(candidate.get("amount"))
        if candidate_amount is None:
            reference = closest_same_period_event(candidate, history_rows)
            if reference:
                candidate["amount"] = reference["amount"]
                candidate["currency"] = candidate["currency"] or reference["currency"]
                candidate["pay_date_estimated"] = True
                candidate["source"] = f"{candidate['source']}+history"
        if candidate.get("pay_date") is None and float_value(candidate.get("amount")) is not None:
            candidate["pay_date"] = candidate.get("ex_date")
            candidate["pay_date_estimated"] = True
        if str(candidate.get("source") or "").startswith("estimated-history"):
            candidate["pay_date_estimated"] = True
        apply_monthly_kr_pay_date(candidate, monthly_tickers)
        schedule_date = event_schedule_date(candidate)
        if not schedule_date:
            continue
        key = (candidate["ticker"], schedule_date.year, schedule_date.month)
        current = grouped.get(key)
        if not current:
            grouped[key] = candidate
            continue
        current_amount = float_value(current.get("amount"))
        next_amount = float_value(candidate.get("amount"))
        if current_amount is None and next_amount is not None:
            current["amount"] = candidate["amount"]
            current["currency"] = current["currency"] or candidate["currency"]
            current["pay_date"] = current.get("pay_date") or candidate.get("pay_date")
            current["pay_date_estimated"] = current.get("pay_date_estimated") or candidate.get("pay_date_estimated")
            current["source"] = f"{current['source']}+history" if "history" not in str(current.get("source")) else current["source"]
        if not current.get("ex_date") and candidate.get("ex_date"):
            current["ex_date"] = candidate["ex_date"]
    return list(grouped.values())

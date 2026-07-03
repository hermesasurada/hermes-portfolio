from __future__ import annotations

from datetime import date, datetime, time, timedelta

from .paths import US_EASTERN


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    day = date(year, month, 1)
    offset = (weekday - day.weekday()) % 7
    return day + timedelta(days=offset + 7 * (nth - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    day = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return day - timedelta(days=(day.weekday() - weekday) % 7)


def _observed_fixed(month: int, day: int, year: int, friday_if_saturday: bool = True) -> date:
    holiday = date(year, month, day)
    if holiday.weekday() == 5 and friday_if_saturday:
        return holiday - timedelta(days=1)
    if holiday.weekday() == 6:
        return holiday + timedelta(days=1)
    return holiday


def _easter_date(year: int) -> date:
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def us_equity_calendar_day(day: date) -> dict:
    year = day.year
    closed = {
        _observed_fixed(1, 1, year, friday_if_saturday=False): "New Year's Day",
        _nth_weekday(year, 1, 0, 3): "Martin Luther King Jr. Day",
        _nth_weekday(year, 2, 0, 3): "Washington's Birthday",
        _easter_date(year) - timedelta(days=2): "Good Friday",
        _last_weekday(year, 5, 0): "Memorial Day",
        _observed_fixed(6, 19, year): "Juneteenth observed",
        _observed_fixed(7, 4, year): "Independence Day observed",
        _nth_weekday(year, 9, 0, 1): "Labor Day",
        _nth_weekday(year, 11, 3, 4): "Thanksgiving Day",
        _observed_fixed(12, 25, year): "Christmas Day observed",
    }
    if day in closed:
        return {"status": "closed", "reason": closed[day], "early_close_time": None}

    thanksgiving = _nth_weekday(year, 11, 3, 4)
    early_close = {
        thanksgiving + timedelta(days=1): "Day after Thanksgiving",
    }
    christmas_eve = date(year, 12, 24)
    if christmas_eve.weekday() < 5:
        early_close[christmas_eve] = "Christmas Eve"
    july_third = date(year, 7, 3)
    if july_third.weekday() < 5 and _observed_fixed(7, 4, year) != july_third:
        early_close[july_third] = "Day before Independence Day"

    if day in early_close:
        return {"status": "early_close", "reason": early_close[day], "early_close_time": "13:00"}
    if day.weekday() >= 5:
        return {"status": "closed", "reason": "Weekend", "early_close_time": None}
    return {"status": "open", "reason": None, "early_close_time": None}


def us_equity_market_status(now: datetime | None = None) -> dict:
    now_et = now.astimezone(US_EASTERN) if now else datetime.now(US_EASTERN)
    calendar = us_equity_calendar_day(now_et.date())
    regular_start = 9 * 60 + 30
    regular_end = 13 * 60 if calendar["status"] == "early_close" else 16 * 60
    minutes = now_et.hour * 60 + now_et.minute
    is_regular = calendar["status"] != "closed" and regular_start <= minutes < regular_end
    label = "휴장" if calendar["status"] == "closed" else "조기폐장" if calendar["status"] == "early_close" else "정규장" if is_regular else "장외"
    return {
        "market": "US",
        "status": calendar["status"],
        "is_closed": calendar["status"] == "closed",
        "is_early_close": calendar["status"] == "early_close",
        "is_regular": is_regular,
        "reason": calendar["reason"],
        "early_close_time": calendar["early_close_time"],
        "now_et": now_et.strftime("%Y-%m-%d %H:%M ET"),
        "date": now_et.date().isoformat(),
        "label": label,
    }

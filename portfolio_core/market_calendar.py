from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .constants import CRYPTO_MARKETS, FX_TICKERS, KOREAN_SUFFIXES, MARKET_INDEXES
from .dates import parse_iso_date
from .paths import KST, US_EASTERN


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


def _japanese_equinox_day(year: int, spring: bool) -> int:
    """2000~2099년 일본 춘분·추분일 근사식(일본 공휴일 산식)."""
    base = 20.8431 if spring else 23.2488
    return int(base + 0.242194 * (year - 1980) - int((year - 1980) / 4))


def japan_equity_calendar_day(day: date) -> dict:
    """도쿄증권거래소 휴장일. 주말·국경일·대체휴일·연말연시를 포함한다."""
    year = day.year
    holidays: dict[date, str] = {
        date(year, 1, 1): "신정",
        date(year, 1, 2): "연말연시",
        date(year, 1, 3): "연말연시",
        _nth_weekday(year, 1, 0, 2): "성인의 날",
        date(year, 2, 11): "건국기념일",
        date(year, 2, 23): "천황탄생일",
        date(year, 3, _japanese_equinox_day(year, True)): "춘분의 날",
        date(year, 4, 29): "쇼와의 날",
        date(year, 5, 3): "헌법기념일",
        date(year, 5, 4): "녹색의 날",
        date(year, 5, 5): "어린이날",
        _nth_weekday(year, 7, 0, 3): "바다의 날",
        date(year, 8, 11): "산의 날",
        _nth_weekday(year, 9, 0, 3): "경로의 날",
        date(year, 9, _japanese_equinox_day(year, False)): "추분의 날",
        _nth_weekday(year, 10, 0, 2): "스포츠의 날",
        date(year, 11, 3): "문화의 날",
        date(year, 11, 23): "근로감사의 날",
        date(year, 12, 31): "연말연시",
    }

    # 일요일 공휴일은 다음 비공휴일로 순연한다(골든위크 연속 대체휴일 포함).
    for holiday, reason in sorted(tuple(holidays.items())):
        if holiday.weekday() != 6:
            continue
        substitute = holiday + timedelta(days=1)
        while substitute in holidays:
            substitute += timedelta(days=1)
        holidays[substitute] = f"{reason} 대체휴일"

    # 앞뒤가 모두 국경일인 평일은 국민의 휴일이다.
    current = date(year, 1, 2)
    while current.year == year and current < date(year, 12, 31):
        if (
            current.weekday() < 5
            and current not in holidays
            and current - timedelta(days=1) in holidays
            and current + timedelta(days=1) in holidays
        ):
            holidays[current] = "국민의 휴일"
        current += timedelta(days=1)

    if day.weekday() >= 5:
        return {"status": "closed", "reason": "주말"}
    if day in holidays:
        return {"status": "closed", "reason": holidays[day]}
    return {"status": "open", "reason": None}


# 거래소별 정규장 시간(현지시각 분 단위). 한국에서 보면 유럽장은 자정 전후에
# 끝나고 미국장은 새벽에 끝나므로, 낮에 보는 등락은 대개 '이미 끝난 세션'의
# 확정값이다 — 그 사실을 등락 열에 '종' 배지로 알린다.
EXCHANGE_SESSIONS: dict[str, tuple[str, int, int]] = {
    ".KS": ("Asia/Seoul", 9 * 60, 15 * 60 + 30),
    ".KQ": ("Asia/Seoul", 9 * 60, 15 * 60 + 30),
    ".T": ("Asia/Tokyo", 9 * 60, 15 * 60 + 30),
    ".HK": ("Asia/Hong_Kong", 9 * 60 + 30, 16 * 60),
    ".TW": ("Asia/Taipei", 9 * 60, 13 * 60 + 30),
    ".SS": ("Asia/Shanghai", 9 * 60 + 30, 15 * 60),
    ".SZ": ("Asia/Shanghai", 9 * 60 + 30, 15 * 60),
    ".L": ("Europe/London", 8 * 60, 16 * 60 + 30),
    ".DE": ("Europe/Berlin", 9 * 60, 17 * 60 + 30),
    ".PA": ("Europe/Paris", 9 * 60, 17 * 60 + 30),
    ".AS": ("Europe/Amsterdam", 9 * 60, 17 * 60 + 30),
    ".BR": ("Europe/Brussels", 9 * 60, 17 * 60 + 30),
    ".MI": ("Europe/Rome", 9 * 60, 17 * 60 + 30),
    ".MC": ("Europe/Madrid", 9 * 60, 17 * 60 + 30),
    ".SW": ("Europe/Zurich", 9 * 60, 17 * 60 + 30),
    ".VI": ("Europe/Vienna", 9 * 60, 17 * 60 + 30),
    ".ST": ("Europe/Stockholm", 9 * 60, 17 * 60 + 30),
    ".CO": ("Europe/Copenhagen", 9 * 60, 17 * 60),
    ".OL": ("Europe/Oslo", 9 * 60, 16 * 60 + 30),
    ".HE": ("Europe/Helsinki", 10 * 60, 18 * 60 + 30),
    ".WA": ("Europe/Warsaw", 9 * 60, 17 * 60),
    ".LS": ("Europe/Lisbon", 8 * 60, 16 * 60 + 30),
    ".IR": ("Europe/Dublin", 8 * 60, 16 * 60 + 30),
}
# 지수는 접미사가 없으므로 constants의 region으로 거래소를 찾는다.
INDEX_REGION_SESSIONS: dict[str, tuple[str, int, int]] = {
    "US": ("America/New_York", 9 * 60 + 30, 16 * 60),
    "KR": ("Asia/Seoul", 9 * 60, 15 * 60 + 30),
    "JP": ("Asia/Tokyo", 9 * 60, 15 * 60 + 30),
    "CN": ("Asia/Shanghai", 9 * 60 + 30, 15 * 60),
    "HK": ("Asia/Hong_Kong", 9 * 60 + 30, 16 * 60),
    "TW": ("Asia/Taipei", 9 * 60, 13 * 60 + 30),
    "GB": ("Europe/London", 8 * 60, 16 * 60 + 30),
    "DE": ("Europe/Berlin", 9 * 60, 17 * 60 + 30),
    "FR": ("Europe/Paris", 9 * 60, 17 * 60 + 30),
    "EU": ("Europe/Paris", 9 * 60, 17 * 60 + 30),
    "IN": ("Asia/Kolkata", 9 * 60 + 15, 15 * 60 + 30),
}
US_SESSION = ("America/New_York", 9 * 60 + 30, 16 * 60)


# 음력 공휴일(설날·추석·부처님오신날)은 표준 라이브러리로 계산할 수 없어
# 연도별 양력 환산값을 둔다. 범위 밖 연도는 음력 휴일 없이 고정 휴일만 판정한다
# — NXT 세션 게이팅은 체결시각(오늘) 검증이 이중으로 막으므로 오판이 무해하다.
KOREAN_LUNAR_HOLIDAYS: dict[int, dict[str, tuple[date, ...]]] = {
    2025: {
        "설날": (date(2025, 1, 28), date(2025, 1, 29), date(2025, 1, 30)),
        "추석": (date(2025, 10, 5), date(2025, 10, 6), date(2025, 10, 7)),
        "부처님오신날": (date(2025, 5, 5),),
    },
    2026: {
        "설날": (date(2026, 2, 16), date(2026, 2, 17), date(2026, 2, 18)),
        "추석": (date(2026, 9, 24), date(2026, 9, 25), date(2026, 9, 26)),
        "부처님오신날": (date(2026, 5, 24),),
    },
    2027: {
        "설날": (date(2027, 2, 6), date(2027, 2, 7), date(2027, 2, 8)),
        "추석": (date(2027, 9, 14), date(2027, 9, 15), date(2027, 9, 16)),
        "부처님오신날": (date(2027, 5, 13),),
    },
    2028: {
        "설날": (date(2028, 1, 26), date(2028, 1, 27), date(2028, 1, 28)),
        "추석": (date(2028, 10, 2), date(2028, 10, 3), date(2028, 10, 4)),
        "부처님오신날": (date(2028, 5, 2),),
    },
}


def korean_exchange_holidays(year: int) -> dict[date, str]:
    """KRX·NXT 휴장일. 고정 공휴일 + 음력 공휴일 + 대체공휴일 + 연말 폐장일."""
    holidays: dict[date, str] = {
        date(year, 1, 1): "신정",
        date(year, 3, 1): "삼일절",
        date(year, 5, 5): "어린이날",
        date(year, 6, 6): "현충일",
        date(year, 8, 15): "광복절",
        # 제헌절은 2008년 공휴일에서 빠졌다가 2026년부터 다시 휴장
        # (실측: 2023~2025-07-17은 정상 거래, 2026-07-17은 국내 시세 0건).
        **({date(year, 7, 17): "제헌절"} if year >= 2026 else {}),
        date(year, 10, 3): "개천절",
        date(year, 10, 9): "한글날",
        date(year, 12, 25): "성탄절",
        date(year, 12, 31): "연말 폐장",
    }
    for name, days in (KOREAN_LUNAR_HOLIDAYS.get(year) or {}).items():
        for day in days:
            holidays[day] = name

    # 대체공휴일 — 설날·추석·어린이날은 주말과 겹치면 다음 평일로, 그 밖의
    # 국경일은 일요일과 겹칠 때만 순연한다(공휴일법 기준 근사).
    substitute_all = {"설날", "추석", "어린이날", "삼일절", "광복절", "개천절", "한글날", "부처님오신날"}
    for holiday, reason in sorted(tuple(holidays.items())):
        if reason not in substitute_all or holiday.weekday() < 5:
            continue
        moved = holiday + timedelta(days=1)
        while moved.weekday() >= 5 or moved in holidays:
            moved += timedelta(days=1)
        holidays[moved] = f"{reason} 대체공휴일"
    return holidays


def korea_equity_calendar_day(day: date) -> dict:
    if day.weekday() >= 5:
        return {"status": "closed", "reason": "주말"}
    holidays = korean_exchange_holidays(day.year)
    if day in holidays:
        return {"status": "closed", "reason": holidays[day]}
    return {"status": "open", "reason": None}


def _midsummer_eve(year: int) -> date:
    """스웨덴·핀란드 하지 전야 — 6/19~25 사이의 금요일."""
    for day in range(19, 26):
        candidate = date(year, 6, day)
        if candidate.weekday() == 4:
            return candidate
    return date(year, 6, 25)


def _uk_substitute(holiday: date, taken: set[date]) -> date:
    """영국·아일랜드식 대체휴일 — 주말이면 다음 평일로 밀린다."""
    substitute = holiday
    while substitute.weekday() >= 5 or substitute in taken:
        substitute += timedelta(days=1)
    return substitute


def european_exchange_holidays(suffix: str, year: int) -> dict[date, str]:
    """유럽 거래소별 휴장일. 공통(신정·부활절·성탄)에 거래소 고유일을 더한다."""
    easter = _easter_date(year)
    good_friday = easter - timedelta(days=2)
    easter_monday = easter + timedelta(days=1)
    maundy_thursday = easter - timedelta(days=3)
    ascension = easter + timedelta(days=39)
    whit_monday = easter + timedelta(days=50)

    holidays: dict[date, str] = {
        date(year, 1, 1): "신정",
        good_friday: "성금요일",
        easter_monday: "부활절 월요일",
        date(year, 12, 25): "성탄절",
        date(year, 12, 26): "성탄 연휴",
    }
    # 영국·아일랜드는 5/1 대신 은행 휴일 체계를 쓴다.
    if suffix not in {".L", ".IR"}:
        holidays[date(year, 5, 1)] = "노동절"

    if suffix == ".L":
        holidays[_nth_weekday(year, 5, 0, 1)] = "5월 은행휴일"
        holidays[_last_weekday(year, 5, 0)] = "봄 은행휴일"
        holidays[_last_weekday(year, 8, 0)] = "여름 은행휴일"
    elif suffix == ".IR":
        holidays[date(year, 3, 17)] = "성 패트릭의 날"
        holidays[_nth_weekday(year, 5, 0, 1)] = "5월 은행휴일"
        holidays[_nth_weekday(year, 6, 0, 1)] = "6월 은행휴일"
        holidays[_nth_weekday(year, 8, 0, 1)] = "8월 은행휴일"
        holidays[_last_weekday(year, 10, 0)] = "10월 은행휴일"
    elif suffix == ".DE":
        holidays[whit_monday] = "성령강림 월요일"
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".SW":
        holidays[date(year, 1, 2)] = "베르히톨트의 날"
        holidays[ascension] = "예수승천일"
        holidays[whit_monday] = "성령강림 월요일"
        holidays[date(year, 8, 1)] = "건국기념일"
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".MI":
        holidays[date(year, 8, 15)] = "성모승천일"
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".MC":
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".VI":
        holidays[whit_monday] = "성령강림 월요일"
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".ST":
        holidays[date(year, 1, 6)] = "주현절"
        holidays[ascension] = "예수승천일"
        holidays[date(year, 6, 6)] = "건국기념일"
        holidays[_midsummer_eve(year)] = "하지 전야"
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".CO":
        holidays[maundy_thursday] = "성목요일"
        holidays[ascension] = "예수승천일"
        holidays[whit_monday] = "성령강림 월요일"
        holidays[date(year, 6, 5)] = "제헌절"
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".OL":
        holidays[maundy_thursday] = "성목요일"
        holidays[date(year, 5, 17)] = "제헌절"
        holidays[ascension] = "예수승천일"
        holidays[whit_monday] = "성령강림 월요일"
        holidays[date(year, 12, 24)] = "성탄 전야"
        holidays[date(year, 12, 31)] = "연말"
    elif suffix == ".HE":
        holidays[date(year, 1, 6)] = "주현절"
        holidays[ascension] = "예수승천일"
        holidays[_midsummer_eve(year)] = "하지 전야"
        holidays[date(year, 12, 24)] = "성탄 전야"
    elif suffix == ".WA":
        holidays[date(year, 1, 6)] = "주현절"
        holidays[date(year, 5, 3)] = "제헌절"
        holidays[easter + timedelta(days=60)] = "성체축일"
        holidays[date(year, 8, 15)] = "성모승천일"
        holidays[date(year, 11, 1)] = "만성절"
        holidays[date(year, 11, 11)] = "독립기념일"
        holidays[date(year, 12, 24)] = "성탄 전야"

    if suffix in {".L", ".IR"}:
        # 주말에 걸린 고정 휴일은 다음 평일로 대체된다.
        adjusted: dict[date, str] = {}
        for holiday, reason in sorted(holidays.items()):
            if holiday.weekday() >= 5:
                moved = _uk_substitute(holiday, set(adjusted))
                adjusted[moved] = f"{reason} 대체휴일"
            else:
                adjusted[holiday] = reason
        return adjusted
    return holidays


def european_equity_calendar_day(suffix: str, day: date) -> dict:
    if day.weekday() >= 5:
        return {"status": "closed", "reason": "주말"}
    holidays = european_exchange_holidays(suffix, day.year)
    if day in holidays:
        return {"status": "closed", "reason": holidays[day]}
    return {"status": "open", "reason": None}


EUROPEAN_SUFFIXES = (
    ".L", ".DE", ".PA", ".AS", ".BR", ".MI", ".MC", ".SW",
    ".VI", ".ST", ".CO", ".OL", ".HE", ".WA", ".LS", ".IR",
)


def _exchange_session(ticker: str) -> tuple[str, int, int] | None:
    """티커 → (거래소 타임존, 개장 분, 폐장 분). 24시간장·미지원은 None."""
    upper = str(ticker or "").upper()
    if not upper or upper in CRYPTO_MARKETS or upper in FX_TICKERS:
        return None   # 크립토·환율은 24시간 거래라 '종료' 개념이 없다
    index_meta = MARKET_INDEXES.get(upper)
    if index_meta:
        return INDEX_REGION_SESSIONS.get(str(index_meta.get("region") or ""))
    for suffix, session in EXCHANGE_SESSIONS.items():
        if upper.endswith(suffix):
            return session
    return US_SESSION if "." not in upper else None


def _exchange_calendar_day(ticker: str, local_day: date) -> dict:
    """거래소 휴장 여부. 일본·미국은 공휴일 달력까지, 나머지는 주말만 판정한다."""
    upper = str(ticker or "").upper()
    if upper.endswith(".T") or upper == "NIKKEI225":
        return japan_equity_calendar_day(local_day)
    if upper.endswith(KOREAN_SUFFIXES) or upper == "KOSPI":
        return korea_equity_calendar_day(local_day)
    session = _exchange_session(upper)
    if session and session[0] == "America/New_York":
        return us_equity_calendar_day(local_day)
    index_meta = MARKET_INDEXES.get(upper)
    if index_meta:   # 유럽 지수(DAX·CAC40·FTSE·EuroStoxx)는 대표 거래소 달력을 쓴다
        suffix = {"GB": ".L", "DE": ".DE", "FR": ".PA", "EU": ".PA"}.get(
            str(index_meta.get("region") or "")
        )
        if suffix:
            return european_equity_calendar_day(suffix, local_day)
    for suffix in EUROPEAN_SUFFIXES:
        if upper.endswith(suffix):
            return european_equity_calendar_day(suffix, local_day)
    if local_day.weekday() >= 5:
        return {"status": "closed", "reason": "주말"}
    return {"status": "open", "reason": None}


def change_session_note(
    ticker: str,
    price_date: str | None,
    now: datetime | None = None,
) -> dict | None:
    """등락 열에 붙일 세션 상태 배지.

    휴장(주말·공휴일)이면 '휴', 거래일이지만 정규장 시간이 아니면 '종'.
    정규장이 돌아가는 중이면 None(배지 없음).
    """
    session = _exchange_session(ticker)
    if session is None:
        return None
    tz_name, open_minute, close_minute = session
    local_now = (now or datetime.now(KST)).astimezone(ZoneInfo(tz_name))
    local_day = local_now.date()
    quote_day = parse_iso_date(price_date)
    calendar = _exchange_calendar_day(ticker, local_day)

    if calendar["status"] == "closed":
        # 직전 거래일 등락이 그대로 남아 있을 때만 알린다(당일 시세면 무의미).
        if quote_day is None or quote_day >= local_day:
            return None
        # holiday_previous_session은 프런트에서 현지통화 손익을 0으로 만드는
        # 신호라 기존 대상(일본)만 유지한다. 다른 시장은 배지만 붙인다.
        upper = str(ticker or "").upper()
        is_japan = upper.endswith(".T") or upper == "NIKKEI225"
        return {
            "kind": "holiday_previous_session" if is_japan else "holiday_closed",
            "label": "휴",
            "price_date": quote_day.isoformat(),
            "reason": calendar["reason"],
        }

    minutes = local_now.hour * 60 + local_now.minute
    if open_minute <= minutes < close_minute:
        return None
    return {
        "kind": "session_closed",
        "label": "종",
        "price_date": quote_day.isoformat() if quote_day else None,
        "reason": "장 종료" if minutes >= close_minute else "개장 전",
    }


# 이전 이름 — 호출부 호환용
holiday_change_session_note = change_session_note


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

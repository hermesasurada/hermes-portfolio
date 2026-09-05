from __future__ import annotations

import sqlite3
from bisect import bisect_right
from datetime import date, timedelta


def technical_indicators_available() -> bool:
    """기술지표는 표준 라이브러리만으로 계산하므로 항상 사용할 수 있다."""
    return True


def last_number(series) -> float | None:
    if series is None or len(series) == 0:
        return None
    value = series.iloc[-1]
    try:
        if value != value:
            return None
        return float(value)
    except Exception:
        return None


def rsi_value(values: list[float], period: int = 14) -> float | None:
    series = rsi_series(values, period)
    return next((value for value in reversed(series) if value is not None), None)


def rsi_series(values: list[float], period: int = 14) -> list[float | None]:
    """Wilder RSI 시계열.

    기존 ``ta`` 패키지의 EWM(alpha=1/period, adjust=False) 계산과 같은
    초기화 규칙을 사용하되 pandas Series 생성 비용은 없앤다.
    """
    if period <= 0 or len(values) < period:
        return [None] * len(values)
    alpha = 1.0 / period
    average_gain = 0.0
    average_loss = 0.0
    result: list[float | None] = [None] * len(values)
    previous = float(values[0])
    for index in range(1, len(values)):
        current = float(values[index])
        change = current - previous
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        average_gain = (1.0 - alpha) * average_gain + alpha * gain
        average_loss = (1.0 - alpha) * average_loss + alpha * loss
        if index >= period - 1:
            result[index] = (
                100.0
                if average_loss == 0
                else 100.0 - (100.0 / (1.0 + average_gain / average_loss))
            )
        previous = current
    return result


def _row_number(row, key: str) -> float | None:
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def atr_percent(rows: list, period: int = 14) -> float | None:
    """Wilder ATR(14)를 종가 대비 %로. high/low가 없으면 종가 절댓값 변화."""
    if period <= 0 or len(rows) < period + 1:
        return None
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    for row in rows:
        close = _row_number(row, "close")
        if close is None or close <= 0:
            continue
        high = _row_number(row, "high")
        low = _row_number(row, "low")
        closes.append(close)
        highs.append(high if high is not None and high > 0 else close)
        lows.append(low if low is not None and low > 0 else close)
    if len(closes) < period + 1:
        return None
    true_ranges: list[float] = []
    for index in range(1, len(closes)):
        true_ranges.append(
            max(
                highs[index] - lows[index],
                abs(highs[index] - closes[index - 1]),
                abs(lows[index] - closes[index - 1]),
            )
        )
    if len(true_ranges) < period:
        return None
    atr = sum(true_ranges[:period]) / period
    for value in true_ranges[period:]:
        atr = (atr * (period - 1) + value) / period
    last = closes[-1]
    if last <= 0 or atr < 0:
        return None
    return (atr / last) * 100


def rolling_atr_percent(rows: list, period: int = 14, lookback: int = 61) -> list[float | None]:
    """Each point equals atr_percent(rows[max(0, i-lookback+1):i+1]).

    Normalize OHLC and calculate true ranges once. Keep the existing finite
    window's seed/recurrence, rather than substituting a full-history Wilder ATR
    (which would change historical entry scores).
    """
    result: list[float | None] = [None] * len(rows)
    if period <= 0 or lookback <= period:
        return result
    closes: list[float] = []
    ranges: list[float] = []
    counts = [0]
    for row in rows:
        close = _row_number(row, "close")
        if close is not None and close > 0:
            high = _row_number(row, "high")
            low = _row_number(row, "low")
            high = high if high is not None and high > 0 else close
            low = low if low is not None and low > 0 else close
            ranges.append(max(high - low, abs(high - closes[-1]), abs(low - closes[-1])) if closes else 0.0)
            closes.append(close)
        counts.append(len(closes))
    for index in range(len(rows)):
        start = counts[max(0, index - lookback + 1)]
        end = counts[index + 1]
        if end - start < period + 1:
            continue
        # The first retained close has no predecessor within this window.
        atr = sum(ranges[start + 1:start + period + 1]) / period
        for value in ranges[start + period + 1:end]:
            atr = (atr * (period - 1) + value) / period
        result[index] = atr / closes[end - 1] * 100
    return result


def bollinger_bounds(
    values: list[float], period: int = 20, deviations: float = 2.0
) -> tuple[float, float, float] | None:
    """최근 창의 (중심, 상단, 하단)."""
    if len(values) < period:
        return None
    window = [float(value) for value in values[-period:]]
    average = sum(window) / period
    variance = sum((value - average) ** 2 for value in window) / period
    width = (variance ** 0.5) * deviations
    if width == 0:
        return None
    return average, average + width, average - width


def bollinger_pband(values: list[float], period: int = 20, deviations: float = 2.0) -> float | None:
    bounds = bollinger_bounds(values, period, deviations)
    if bounds is None:
        return None
    _mid, upper, lower = bounds
    last = float(values[-1])
    return (last - lower) / (upper - lower) * 100


def ma_pct(values: list[float], period: int = 20) -> float | None:
    """현재가의 N일 이평 대비 % (위면 +, 아래면 −)."""
    if period <= 0 or len(values) < period:
        return None
    window = [float(value) for value in values[-period:]]
    average = sum(window) / period
    last = window[-1]
    if last <= 0 or average <= 0:
        return None
    return (last / average - 1) * 100


def bollinger_distance_pct(
    values: list[float], period: int = 20, deviations: float = 2.0
) -> tuple[float, float] | None:
    """현재가 대비 상단까지 % · 하단까지 %. 상단 위면 상단%가 음수."""
    bounds = bollinger_bounds(values, period, deviations)
    if bounds is None:
        return None
    last = float(values[-1])
    if last <= 0:
        return None
    _mid, upper, lower = bounds
    return (upper / last - 1) * 100, (last - lower) / last * 100


def resample_last(rows: list[sqlite3.Row], period: str) -> list[float]:
    grouped: dict[str, float] = {}
    for row in rows:
        date_text = row["date"]
        if period == "week":
            iso_year, iso_week, _ = date.fromisoformat(date_text).isocalendar()
            key = f"{iso_year}-W{iso_week:02d}"
        else:
            key = date_text[:7]
        grouped[key] = float(row["close"])
    return [grouped[key] for key in sorted(grouped)]


def shift_months(day: date, months: int) -> date:
    month_index = day.month - 1 + months
    year = day.year + month_index // 12
    month = month_index % 12 + 1
    month_lengths = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return date(year, month, min(day.day, month_lengths[month - 1]))


def price_on_or_before(rows: list[sqlite3.Row], target: date) -> float | None:
    if not rows:
        return None
    dates = [row["date"] for row in rows]
    index = bisect_right(dates, target.isoformat()) - 1
    return float(rows[index]["close"]) if index >= 0 else None


def price_near_target(rows: list[sqlite3.Row], target: date, max_forward_days: int = 7) -> float | None:
    before = price_on_or_before(rows, target)
    if before is not None:
        return before
    if not rows:
        return None
    first_date = date.fromisoformat(rows[0]["date"])
    if 0 <= (first_date - target).days <= max_forward_days:
        return float(rows[0]["close"])
    return None


def performance_pct(rows: list[sqlite3.Row], target: date) -> float | None:
    if not rows:
        return None
    latest = float(rows[-1]["close"])
    base = price_near_target(rows, target)
    if base in (None, 0):
        return None
    return (latest - base) / base * 100


def recent_performance(rows: list[sqlite3.Row]) -> dict[str, float | None]:
    if not rows:
        return {
            "one_week": None,
            "one_month": None,
            "three_month": None,
            "six_month": None,
            "ytd": None,
            "one_year": None,
            "three_year": None,
            "five_year": None,
            "ten_year": None,
        }
    latest_date = date.fromisoformat(rows[-1]["date"])
    return {
        "one_week": performance_pct(rows, latest_date - timedelta(days=7)),
        "one_month": performance_pct(rows, shift_months(latest_date, -1)),
        "three_month": performance_pct(rows, shift_months(latest_date, -3)),
        "six_month": performance_pct(rows, shift_months(latest_date, -6)),
        "ytd": performance_pct(rows, date(latest_date.year, 1, 1)),
        "one_year": performance_pct(rows, shift_months(latest_date, -12)),
        "three_year": performance_pct(rows, shift_months(latest_date, -36)),
        "five_year": performance_pct(rows, shift_months(latest_date, -60)),
        "ten_year": performance_pct(rows, shift_months(latest_date, -120)),
    }

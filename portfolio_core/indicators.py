from __future__ import annotations

import sqlite3
from datetime import date, datetime


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
    if len(values) <= period:
        return None
    try:
        import pandas as pd
        from ta.momentum import RSIIndicator

        close = pd.Series(values, dtype="float64")
        return last_number(RSIIndicator(close=close, window=period).rsi())
    except Exception as exc:
        print(f"[stats] RSI failed: {exc}")
        return None


def bollinger_pband(values: list[float], period: int = 20, deviations: float = 2.0) -> float | None:
    if len(values) < period:
        return None
    try:
        import pandas as pd
        from ta.volatility import BollingerBands

        close = pd.Series(values, dtype="float64")
        bands = BollingerBands(close=close, window=period, window_dev=deviations)
        value = last_number(bands.bollinger_pband())
        return value * 100 if value is not None else None
    except Exception as exc:
        print(f"[stats] Bollinger PBand failed: {exc}")
        return None


def resample_last(rows: list[sqlite3.Row], period: str) -> list[float]:
    grouped: dict[str, float] = {}
    for row in rows:
        row_date = datetime.strptime(row["date"], "%Y-%m-%d").date()
        key = f"{row_date.isocalendar().year}-W{row_date.isocalendar().week:02d}" if period == "week" else row_date.strftime("%Y-%m")
        grouped[key] = float(row["close"])
    return [grouped[key] for key in sorted(grouped)]


def shift_months(day: date, months: int) -> date:
    month_index = day.month - 1 + months
    year = day.year + month_index // 12
    month = month_index % 12 + 1
    month_lengths = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return date(year, month, min(day.day, month_lengths[month - 1]))


def price_on_or_before(rows: list[sqlite3.Row], target: date) -> float | None:
    for row in reversed(rows):
        row_date = datetime.strptime(row["date"], "%Y-%m-%d").date()
        if row_date <= target:
            return float(row["close"])
    return None


def price_near_target(rows: list[sqlite3.Row], target: date, max_forward_days: int = 7) -> float | None:
    before = price_on_or_before(rows, target)
    if before is not None:
        return before
    if not rows:
        return None
    first_date = datetime.strptime(rows[0]["date"], "%Y-%m-%d").date()
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
            "one_month": None,
            "three_month": None,
            "six_month": None,
            "ytd": None,
            "one_year": None,
            "three_year": None,
            "five_year": None,
        }
    latest_date = datetime.strptime(rows[-1]["date"], "%Y-%m-%d").date()
    return {
        "one_month": performance_pct(rows, shift_months(latest_date, -1)),
        "three_month": performance_pct(rows, shift_months(latest_date, -3)),
        "six_month": performance_pct(rows, shift_months(latest_date, -6)),
        "ytd": performance_pct(rows, date(latest_date.year, 1, 1)),
        "one_year": performance_pct(rows, shift_months(latest_date, -12)),
        "three_year": performance_pct(rows, shift_months(latest_date, -36)),
        "five_year": performance_pct(rows, shift_months(latest_date, -60)),
    }

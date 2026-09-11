"""Experimental, price-only timing reference. Not calibrated probabilities.

Daily inputs include the evaluated bar last. High/low anchors and ATR use only
preceding bars; the current close may be replaced by the selected live quote.
"""
from __future__ import annotations

from math import isfinite

from .indicators import atr_percent


def calculate_trade_timing(rows: list, *, provisional: bool = False) -> dict | None:
    # 50-day SMA five bars ago requires 55 closes. No neutral imputation.
    if len(rows) < 55:
        return None
    rows = [dict(row) for row in rows[-205:]]
    try:
        closes = [float(row["close"]) for row in rows]
        prior = rows[:-1]
        highs = [float(row["high"]) for row in prior[-61:]]
        lows = [float(row["low"]) for row in prior[-61:]]
        if not all(isfinite(x) and x > 0 for x in closes + highs + lows):
            return None
        if any(h < l for h, l in zip(highs, lows)):
            return None
    except (KeyError, TypeError, ValueError):
        return None
    atr_pct = atr_percent(prior[-61:])
    if atr_pct is None or atr_pct <= 0:
        return None
    atr = atr_pct / 100 * closes[-2]
    price = closes[-1]

    def sma(period: int, offset: int = 0) -> float:
        end = len(closes) - offset
        return sum(closes[end - period:end]) / period

    ma20, ma50 = sma(20), sma(50)
    ma200 = sma(200) if len(closes) >= 200 else None
    trend = price > ma50 and ma50 > sma(50, 5) and (ma200 is None or price > ma200)
    # Today's upward cross, or either of the two preceding bars' upward crosses.
    cross = any(
        closes[-1 - offset] > sma(20, offset)
        and closes[-2 - offset] <= sma(20, offset + 1)
        for offset in range(3)
    )
    rebound = cross and price > ma20
    high20, low10, previous_low = max(highs[-20:]), min(lows[-10:]), lows[-1]
    lower = min(low10 - 0.5 * atr, price - 1.5 * atr)
    buy_r = (high20 - price) / (price - lower) if high20 > price else None
    sell_atr = max(0.0, (high20 - price) / atr)
    below20, broke_low = price < ma20, price < previous_low
    state = "wait"
    if below20 and sell_atr >= 3 and broke_low:
        state = "sell"
    elif below20 and sell_atr >= 2:
        state = "caution"
    elif price >= high20:
        state = "breakout"  # Not a zero-score sell signal.
    elif trend and rebound and buy_r is not None:
        state = "buy" if buy_r >= 1.5 else "watch" if buy_r >= 1 else "wait"
    return {
        "state": state,
        "buy_r": round(buy_r, 4) if buy_r is not None else None,
        "sell_atr": round(sell_atr, 4),
        "price": price, "atr": atr, "upper": high20, "lower": lower,
        "ma20": ma20, "ma50": ma50, "ma200": ma200,
        "trend": trend, "rebound": rebound, "broke_previous_low": broke_low,
        "as_of": rows[-1]["date"], "provisional": provisional,
    }

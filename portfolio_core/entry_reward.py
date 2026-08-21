"""진입 손익비 — 볼린저 목표 / ATR 손절 × RSI × 추세.

  업사이드 = max(일 볼린저 상단 / 현재가 − 1, 0)
  손절폭   = max(1.5 × ATR(14)%, 1%)
  RSI      = 일·주 기하평균. 30~45 가점(1.2), 70+ 감점(최소 0.25)
  추세     = 주 RSI>50 그리고 20일선 위 → 1.0
             둘 중 하나만 → 0.6
             둘 다 아니면 → 0.25
  점수     = clamp(업사이드/손절 × RSI × 추세, 0, 20)
"""

from __future__ import annotations

STOP_ATR_MULT = 1.5
ATR_FLOOR_PCT = 1.0
RSI_PULLBACK_LOW = 30.0
RSI_PULLBACK_HIGH = 45.0
RSI_HOT = 70.0
RSI_BONUS = 1.2
MIN_HEAT = 0.25
TREND_STRONG = 1.0
TREND_MIXED = 0.6
TREND_WEAK = 0.25
SCORE_CAP = 20.0


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _rsi_leg(rsi) -> float | None:
    value = _finite(rsi)
    if value is None:
        return None
    if RSI_PULLBACK_LOW <= value <= RSI_PULLBACK_HIGH:
        return RSI_BONUS
    if value > RSI_HOT:
        return max(MIN_HEAT, 1.0 - (value - RSI_HOT) / 30.0)
    return 1.0


def _rsi_factor(rsi_day, rsi_week) -> float:
    legs = [leg for leg in (_rsi_leg(rsi_day), _rsi_leg(rsi_week)) if leg is not None]
    if not legs:
        return 1.0
    product = 1.0
    for leg in legs:
        product *= leg
    return product ** (1.0 / len(legs))


def _trend_factor(rsi_week, ma20_pct) -> float:
    week = _finite(rsi_week)
    ma = _finite(ma20_pct)
    weekly_up = week is not None and week > 50
    above_ma = ma is not None and ma > 0
    if week is None and ma is None:
        return TREND_STRONG
    if week is None:
        return TREND_STRONG if above_ma else TREND_WEAK
    if ma is None:
        return TREND_STRONG if weekly_up else TREND_WEAK
    if weekly_up and above_ma:
        return TREND_STRONG
    if weekly_up or above_ma:
        return TREND_MIXED
    return TREND_WEAK


def entry_risk_reward_score(
    upper_pct,
    atr_pct,
    rsi_day=None,
    rsi_week=None,
    ma20_pct=None,
) -> float | None:
    """볼린저 상단까지 / 1.5×ATR, RSI·20일선 추세로 가감."""
    upper = _finite(upper_pct)
    atr = _finite(atr_pct)
    if upper is None or atr is None or atr < 0:
        return None
    upside = max(upper, 0.0)
    stop = max(atr * STOP_ATR_MULT, ATR_FLOOR_PCT)
    if stop <= 0:
        return None
    score = (upside / stop) * _rsi_factor(rsi_day, rsi_week) * _trend_factor(rsi_week, ma20_pct)
    if score < 0:
        score = 0.0
    return round(min(score, SCORE_CAP), 2)

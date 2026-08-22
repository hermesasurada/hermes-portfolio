"""진입 손익비 — 중기 볼린저 목표 / ATR 손절 × RSI × 추세 × 변동성.

  업사이드 = 0.3×일 볼린저 상단% + 0.7×주 볼린저 상단% (있는 쪽만, 음수는 0)
  손절폭   = max(1.5 × ATR(14)%, 1%)
  RSI      = 값 자체를 50 기준으로 연속 정규화. 낮을수록 가점, 높을수록 감점
             factor = clamp(1 + (50−RSI)/40 × 0.5, 0.25, 1.4)
             일·주는 가중 기하평균 (일 0.4 · 주 0.6)
  추세     = 주 RSI>50 그리고 60일선 위 → 1.0
             둘 중 하나만 → 0.6
             둘 다 아니면 → 0.25
  변동성   = clamp(√(ATR% / 2%), 0.7, 1.4) — 같은 밴드·RSI라도 변동성이 크면
             같은 기간 기대 수익이 크다
  점수     = clamp(업사이드/손절 × RSI × 추세 × 변동성, 0, 20)
"""

from __future__ import annotations

STOP_ATR_MULT = 1.5
ATR_FLOOR_PCT = 1.0
RSI_PIVOT = 50.0
RSI_SPAN = 40.0
RSI_AMPLITUDE = 0.5
RSI_MIN = 0.25
RSI_MAX = 1.4
RSI_DAY_WEIGHT = 0.4
RSI_WEEK_WEIGHT = 0.6
TREND_STRONG = 1.0
TREND_MIXED = 0.6
TREND_WEAK = 0.25
BB_DAY_WEIGHT = 0.3
BB_WEEK_WEIGHT = 0.7
ATR_REF_PCT = 2.0
VOL_MIN = 0.7
VOL_MAX = 1.4
SCORE_CAP = 20.0


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _rsi_scale(rsi) -> float | None:
    value = _finite(rsi)
    if value is None:
        return None
    factor = 1.0 + (RSI_PIVOT - value) / RSI_SPAN * RSI_AMPLITUDE
    return max(RSI_MIN, min(RSI_MAX, factor))


def _rsi_factor(rsi_day, rsi_week) -> float:
    day = _rsi_scale(rsi_day)
    week = _rsi_scale(rsi_week)
    if day is None and week is None:
        return 1.0
    if day is None:
        return week
    if week is None:
        return day
    return day ** RSI_DAY_WEIGHT * week ** RSI_WEEK_WEIGHT


def _trend_factor(rsi_week, ma60_pct) -> float:
    week = _finite(rsi_week)
    ma = _finite(ma60_pct)
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


def _upside_pct(upper_pct, upper_week_pct) -> float | None:
    day = _finite(upper_pct)
    week = _finite(upper_week_pct)
    day_up = max(day, 0.0) if day is not None else None
    week_up = max(week, 0.0) if week is not None else None
    if day_up is None and week_up is None:
        return None
    if day_up is None:
        return week_up
    if week_up is None:
        return day_up
    return BB_DAY_WEIGHT * day_up + BB_WEEK_WEIGHT * week_up


def _vol_factor(atr_pct) -> float:
    atr = _finite(atr_pct)
    if atr is None or atr <= 0:
        return 1.0
    return max(VOL_MIN, min(VOL_MAX, (atr / ATR_REF_PCT) ** 0.5))


def entry_risk_reward_score(
    upper_pct,
    atr_pct,
    rsi_day=None,
    rsi_week=None,
    ma60_pct=None,
    upper_week_pct=None,
) -> float | None:
    """주 볼린저 위주 업사이드 / 1.5×ATR, RSI 연속값·60일선·변동성으로 가감."""
    upside = _upside_pct(upper_pct, upper_week_pct)
    atr = _finite(atr_pct)
    if upside is None or atr is None or atr < 0:
        return None
    stop = max(atr * STOP_ATR_MULT, ATR_FLOOR_PCT)
    if stop <= 0:
        return None
    score = (
        (upside / stop)
        * _rsi_factor(rsi_day, rsi_week)
        * _trend_factor(rsi_week, ma60_pct)
        * _vol_factor(atr)
    )
    if score < 0:
        score = 0.0
    return round(min(score, SCORE_CAP), 2)

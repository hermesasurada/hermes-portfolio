"""진입 손익비 — 지금 자리의 밴드 상단까지 여유 ÷ ATR·하단 손절.

산식:
  업사이드 = max(일 볼린저 상단 / 현재가 − 1, 0)
  손절폭   = max(1.5 × ATR(14)%, 하단까지 %, 1%)
  raw      = 업사이드 / 손절폭
  추세     = 3개월·6개월 성과가 둘 다 ≤0 이면 ×0.25
  과열     = 일 RSI>70 또는 일 BB>80 이면 0.25~1로 할인
  점수     = clamp(raw × 추세 × 과열, 0, 20)

52주 고점은 쓰지 않는다. 최근 20일 변동 밴드 안의 현재 자리다.
"""

from __future__ import annotations

STOP_ATR_MULT = 1.5
ATR_FLOOR_PCT = 1.0
TREND_PENALTY = 0.25
OVERBOUGHT_RSI = 70.0
OVERBOUGHT_BB = 80.0
MIN_HEAT = 0.25
SCORE_CAP = 20.0


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _heat_factor(rsi_day, bb_day) -> float:
    heat = 1.0
    rsi = _finite(rsi_day)
    if rsi is not None and rsi > OVERBOUGHT_RSI:
        heat = min(heat, max(MIN_HEAT, 1.0 - (rsi - OVERBOUGHT_RSI) / 30.0))
    band = _finite(bb_day)
    if band is not None and band > OVERBOUGHT_BB:
        heat = min(heat, max(MIN_HEAT, 1.0 - (band - OVERBOUGHT_BB) / 20.0))
    return heat


def _trend_factor(perf_3m, perf_6m) -> float:
    three = _finite(perf_3m)
    six = _finite(perf_6m)
    if three is None and six is None:
        return 1.0
    if (three is not None and three > 0) or (six is not None and six > 0):
        return 1.0
    return TREND_PENALTY


def entry_risk_reward_score(
    upper_pct,
    lower_pct,
    atr_pct,
    rsi_day=None,
    bb_day=None,
    perf_3m=None,
    perf_6m=None,
) -> float | None:
    """볼린저 상단까지 / max(1.5×ATR, 하단까지). 상단이면 0."""
    upper = _finite(upper_pct)
    lower = _finite(lower_pct)
    atr = _finite(atr_pct)
    if upper is None or atr is None or atr < 0:
        return None
    upside = max(upper, 0.0)
    room_below = max(lower, 0.0) if lower is not None else 0.0
    stop = max(atr * STOP_ATR_MULT, room_below, ATR_FLOOR_PCT)
    if stop <= 0:
        return None
    raw = upside / stop
    score = raw * _trend_factor(perf_3m, perf_6m) * _heat_factor(rsi_day, bb_day)
    if score < 0:
        score = 0.0
    return round(min(score, SCORE_CAP), 2)

"""변동성 손익비 점수 — 총수익(가격+배당) 대비 자기 변동성.

산식 (2026-07 개편):
  수익 축: 총수익 CAGR = 가격 CAGR + 현재 배당수익률(총수익 근사).
    5년(0.6)·3년(0.3)·1년(0.1) 가중, 각 항은 [-50, +100]%로 윈저라이즈
    (레버리지 ETF 극단값이 점수를 지배하지 않게 — 1년만 캡이던 비일관 해소).
    이력 부족 시 3년(0.9)+1년(0.1) → 1년(1.0)으로 폴백하고 short 마크.
  위험 축: 종목 자체 연율화 일변동성(%)로 나눈다(Sharpe류).
    S&P500 대비 변동성 비율(β″)은 한국 종목까지 미국 지수 σ에 묶여
    시장별 의미가 달랐다 — 벤치마크 의존 제거. MMF류 극저변동 폭발
    방지 바닥 5%.
  낙폭 보정: 52주 고점 낙폭을 0.75~1.0 배수로(기존 0.5~1.0은 분모
    변동성과 이중 페널티라 완화). 점수가 음수면 곱 대신 나눗셈 —
    하락 종목에서 낙폭이 클수록 점수가 덜 나빠지던 역방향 해소.
  스케일: ×10 (기존 점수대와 유사한 한 자릿수~십수 범위 유지).
"""

from __future__ import annotations

RETURN_CLAMP_LOW = -50.0
RETURN_CLAMP_HIGH = 100.0
VOLATILITY_FLOOR_PCT = 5.0
SCORE_SCALE = 10.0


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _annualized_percent(total_return_pct: float | None, years: float) -> float | None:
    if total_return_pct is None or total_return_pct <= -100 or years <= 0:
        return None
    return ((1 + total_return_pct / 100) ** (1 / years) - 1) * 100


def _clamped_total_return(price_return_pct: float | None, years: float, dividend_yield_pct: float) -> float | None:
    """가격수익률(누적)을 연율화하고 배당수익률을 더한 총수익 근사, 윈저라이즈."""
    cagr = _annualized_percent(price_return_pct, years) if years > 1 else price_return_pct
    if cagr is None:
        return None
    total = cagr + dividend_yield_pct
    return max(RETURN_CLAMP_LOW, min(RETURN_CLAMP_HIGH, total))


def risk_reward_score(
    perf_5y,
    perf_3y,
    perf_1y,
    dividend_yield,
    vol_annual,
    drawdown_52w,
) -> tuple[float | None, bool]:
    """(점수, 이력부족 여부). 위험 축(연율 변동성·52주 낙폭)이 없으면 None."""
    volatility = _finite(vol_annual)
    drawdown = _finite(drawdown_52w)
    if volatility is None or volatility < 0 or drawdown is None:
        return None, False
    yield_pct = _finite(dividend_yield) or 0.0

    total_5y = _clamped_total_return(_finite(perf_5y), 5, yield_pct)
    total_3y = _clamped_total_return(_finite(perf_3y), 3, yield_pct)
    total_1y = _clamped_total_return(_finite(perf_1y), 1, yield_pct)

    short_history = False
    if total_5y is not None and total_3y is not None and total_1y is not None:
        return_score = 0.6 * total_5y + 0.3 * total_3y + 0.1 * total_1y
    elif total_3y is not None and total_1y is not None:
        return_score = 0.9 * total_3y + 0.1 * total_1y
        short_history = True
    elif total_1y is not None:
        return_score = total_1y
        short_history = True
    else:
        return None, False

    risk = max(volatility, VOLATILITY_FLOOR_PCT)
    drawdown_adjustment = 1 - min(abs(drawdown), 50) / 200  # 0.75 ~ 1.0
    base = return_score / risk * SCORE_SCALE
    score = base * drawdown_adjustment if base >= 0 else base / drawdown_adjustment
    return round(score, 2), short_history

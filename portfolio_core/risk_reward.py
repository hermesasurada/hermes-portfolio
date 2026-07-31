"""변동성 손익비 점수 — 기간 일치 총수익 Sharpe의 가중평균.

산식 (2026-07 2차 개편, GPT 교차검토 합의안):
  기간점수(h) = clamp(총수익 CAGR(h), -50, +100) ÷ max(총수익 변동성(h), 5%)
    - 총수익 = 배당 재투자 일간 수익률(technical_stats.total_return_periods):
      분할·통화 보정 배당을 배당락일의 거래일에 가산 → CAGR·변동성을
      같은 시계열로 계산(배당락 갭이 위험으로 잡히던 정합성 문제 해소).
    - '현재 배당수익률을 과거에 소급 가산'하던 1차 산식의 왜곡 제거.
  최종점수 = 10 × 가용 기간점수의 가중평균 × 52주 고점 괴리 보정
    - 기본 가중 5y 0.6 / 3y 0.3 / 1y 0.1, 없는 기간은 가용 기간에 비례 재분배.
    - 고점 괴리 보정 0.75~1.0(실제 MDD가 아니라 현재가의 52주 고점 대비
      위치 — 순위 검증 후 MDD 교체 여부 재판단). 음수 점수엔 나눗셈.
  품질: 가용 기간이 모두 총수익(TR)이면 TR, 배당 미반영 폴백이 있으면 P.
  기준(basis): 가장 긴 가용 기간(5y/3y/1y) — 프론트가 5Y·TR 외엔 라벨 표시.
"""

from __future__ import annotations

RETURN_CLAMP_LOW = -50.0
RETURN_CLAMP_HIGH = 100.0
VOLATILITY_FLOOR_PCT = 5.0
SCORE_SCALE = 10.0
PERIOD_WEIGHTS = (("5y", 0.6), ("3y", 0.3), ("1y", 0.1))


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def risk_reward_score(
    periods: dict | None,
    drawdown_52w,
) -> tuple[float | None, str | None, str | None]:
    """(점수, 기준 기간 '5y'|'3y'|'1y', 품질 'TR'|'P')."""
    drawdown = _finite(drawdown_52w)
    if not periods or drawdown is None:
        return None, None, None

    available: list[tuple[str, float, float, str]] = []
    for key, weight in PERIOD_WEIGHTS:
        row = periods.get(key) if isinstance(periods, dict) else None
        if not row:
            continue
        cagr = _finite(row.get("cagr"))
        vol = _finite(row.get("vol"))
        if cagr is None or vol is None or vol < 0:
            continue
        available.append((key, weight, cagr, str(row.get("quality") or "TR")))
    if not available:
        return None, None, None

    total_weight = sum(weight for _key, weight, _cagr, _quality in available)
    weighted = 0.0
    for key, weight, cagr, _quality in available:
        vol = _finite(periods[key].get("vol")) or 0.0
        clamped = max(RETURN_CLAMP_LOW, min(RETURN_CLAMP_HIGH, cagr))
        weighted += (weight / total_weight) * (clamped / max(vol, VOLATILITY_FLOOR_PCT))

    base = weighted * SCORE_SCALE
    adjustment = 1 - min(abs(drawdown), 50) / 200  # 52주 고점 괴리 보정 0.75~1.0
    score = base * adjustment if base >= 0 else base / adjustment
    basis = available[0][0]
    quality = "P" if any(q == "P" for _k, _w, _c, q in available) else "TR"
    return round(score, 2), basis, quality

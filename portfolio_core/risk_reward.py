"""변동성 손익비 점수 — 비겹침 창의 KRW 초과수익 Sortino 가중평균.

산식 (2026-08 3차 개편):
  기간점수(h) = clamp(산술연율 − rf, -50, +100) ÷ max(Sortino 하방변동성(h), 자산군 바닥)
    - 총수익 = 배당 재투자 일간 수익률을 KRW로 환산한 시계열
      (technical_stats.total_return_periods).
    - 분자는 CAGR이 아니라 산술 연율. 기하평균이 이미 변동성을 깎은 뒤
      다시 σ로 나누던 이중 페널티를 제거.
    - rf = KRW 단기 무위험 3%(국고 3개월 근사).
    - 분모는 총변동성이 아니라 Sortino(일간 r − rf/252 의 하방 RMS, 연율).
  최종점수 = 10 × 가용 기간점수의 가중평균
    - 창은 비겹침: 5y = 3~5년 전, 3y = 1~3년 전, 1y = 최근 1년.
    - 기본 가중 5y 0.6 / 3y 0.3 / 1y 0.1, 없는 기간은 가용 기간에 비례 재분배.
    - 52주 고점 괴리 보정은 제거(이미 별도 컬럼).
    - 변동성 바닥: 주식·ETF·지수 8%, 크립토 20%, FX 3%.
  품질: 가용 기간이 모두 총수익(TR)이면 TR, 배당 매핑 실패·이력 미비면 P.
  기준(basis): 가장 긴 가용 기간(5y/3y/1y) — 프론트가 5Y·TR 외엔 라벨 표시.
"""

from __future__ import annotations

from .constants import CRYPTO_MARKETS, FX_TICKERS, MARKET_INDEXES
from .tickers import asset_class

RETURN_CLAMP_LOW = -50.0
RETURN_CLAMP_HIGH = 100.0
SCORE_SCALE = 10.0
PERIOD_WEIGHTS = (("5y", 0.6), ("3y", 0.3), ("1y", 0.1))
RISK_FREE_RATE_PCT = 3.0  # KRW 단기 무위험 연율(%). 국고 3개월 근사.
VOL_FLOOR_PCT = {
    "crypto": 20.0,
    "fx": 3.0,
    "bond": 3.0,
    "stock": 8.0,
    "etf": 8.0,
    "index": 8.0,
}
DEFAULT_VOL_FLOOR_PCT = 8.0


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def score_asset_kind(ticker: str, name: str = "") -> str:
    """손익비 변동성 바닥에 쓰는 자산군. 전역 asset_class 와 달리 FX·지수를 분리한다."""
    upper = (ticker or "").strip().upper()
    if upper in CRYPTO_MARKETS:
        return "crypto"
    if upper in FX_TICKERS:
        return "fx"
    if upper in MARKET_INDEXES:
        return "index"
    return asset_class(upper, name)


def vol_floor_pct(asset_kind: str | None) -> float:
    if not asset_kind:
        return DEFAULT_VOL_FLOOR_PCT
    return VOL_FLOOR_PCT.get(str(asset_kind).strip().lower(), DEFAULT_VOL_FLOOR_PCT)


def risk_reward_score(
    periods: dict | None,
    asset_kind: str | None = None,
) -> tuple[float | None, str | None, str | None]:
    """(점수, 기준 기간 '5y'|'3y'|'1y', 품질 'TR'|'P')."""
    if not periods:
        return None, None, None

    floor = vol_floor_pct(asset_kind)
    available: list[tuple[str, float, float, str]] = []
    for key, weight in PERIOD_WEIGHTS:
        row = periods.get(key) if isinstance(periods, dict) else None
        if not row:
            continue
        excess = _finite(row.get("excess"))
        vol = _finite(row.get("vol"))
        if excess is None or vol is None or vol < 0:
            continue
        available.append((key, weight, excess, str(row.get("quality") or "TR")))
    if not available:
        return None, None, None

    total_weight = sum(weight for _key, weight, _excess, _quality in available)
    weighted = 0.0
    for key, weight, excess, _quality in available:
        vol = _finite(periods[key].get("vol")) or 0.0
        clamped = max(RETURN_CLAMP_LOW, min(RETURN_CLAMP_HIGH, excess))
        weighted += (weight / total_weight) * (clamped / max(vol, floor))

    score = weighted * SCORE_SCALE
    basis = available[0][0]
    quality = "P" if any(q == "P" for _k, _w, _e, q in available) else "TR"
    return round(score, 2), basis, quality

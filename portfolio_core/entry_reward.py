"""진입 손익비 — 중기 볼린저 여유 / ATR 손절 × 일 RSI × 추세.

  업사이드 = 0.3×일 볼린저 상단% + 0.7×min(주 볼린저 상단%, 30)
             (있는 쪽만, 음수는 0. 주봉 급락 후 4σ 거리를 그대로 쓰지 않는다)
  손절폭   = max(1.5 × ATR(14)%, 1%)
  RSI      = 일봉 값만 50 기준으로 연속 정규화. 낮을수록 가점
             factor = clamp(1 + (50−RSI)/40 × 0.5, 0.25, 1.4)
  추세     = 0.25 + 0.75 × (주 RSI 성분 + 60일선 성분) / 2
             주 RSI 성분 = clamp((RSI − 45) / 10, 0, 1)   ← 45~55 사이 선형
             60일선 성분 = clamp((이격% + 2) / 4, 0, 1)   ← −2%~+2% 사이 선형
             둘 다 강하면 1.0, 둘 다 약하면 0.25 (옛 계단의 양 끝과 같다).
             계단(1.0/0.6/0.25)이던 것을 연속으로 바꾼 이유: 문턱 바로 위
             종목은 가격이 0.5%만 밀려도 점수가 40% 빠졌다(PH 2.95→1.87).
  점수     = clamp(업사이드/손절 × RSI × 추세, 0, 20)
  결측     = 일 RSI·주 RSI·주 볼린저 상단·60일선 중 하나라도 없으면 None
             (주봉 20개가 서기 전, 즉 상장 약 20주 미만이면 점수 없음)

  밴드 폭이 이미 변동성이라 ATR 가점은 넣지 않는다. ATR은 손절 폭으로만 쓴다.
"""

from __future__ import annotations

import re

STOP_ATR_MULT = 1.5
ATR_FLOOR_PCT = 1.0
RSI_PIVOT = 50.0
RSI_SPAN = 40.0
RSI_AMPLITUDE = 0.5
RSI_MIN = 0.25
RSI_MAX = 1.4
TREND_STRONG = 1.0
TREND_WEAK = 0.25
TREND_RSI_PIVOT = 50.0
TREND_RSI_BAND = 5.0     # 주 RSI 45→55 사이에서 0→1
TREND_MA_BAND_PCT = 2.0  # 60일선 −2%→+2% 사이에서 0→1
BB_DAY_WEIGHT = 0.3
BB_WEEK_WEIGHT = 0.7
WEEK_UPSIDE_CAP = 30.0
SCORE_CAP = 20.0


# 레버리지·인버스 상품 — 종목명으로 판정 (Direxion Bull 2X / GraniteShares 2x Long /
# T-REX 2X / ProShares Ultra / Tradr 1.5X Short / KODEX 레버리지·인버스 …).
# 급락한 레버리지 ETF는 주봉 밴드가 너무 넓어 업사이드가 늘 30% 캡에 붙고, 점수가
# 추세 계수 하나에 좌우된다(TSLL 실측). 이 산식은 그런 상품에 맞지 않으므로 점수를 내지 않는다.
LEVERAGED_NAME_PATTERN = re.compile(
    r"(\b[1-3](?:\.\d)?\s?x\b|레버리지|leverag|인버스|inverse|\bbull\b|\bbear\b|\bultra(?:pro|short)?\b|롱\s?\d|숏\s?\d|\blong\s\d|\bshort\s\d)",
    re.IGNORECASE,
)


def is_leveraged_product(name: str | None) -> bool:
    return bool(name) and LEVERAGED_NAME_PATTERN.search(str(name)) is not None


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


def _rsi_factor(rsi_day) -> float:
    day = _rsi_scale(rsi_day)
    return 1.0 if day is None else day


def _unit_ramp(value: float, center: float, half_width: float) -> float:
    """center−half_width에서 0, center+half_width에서 1로 선형 증가(그 밖은 클램프)."""
    return max(0.0, min(1.0, (value - center + half_width) / (2 * half_width)))


def _trend_factor(rsi_week, ma60_pct) -> float:
    """추세 계수 — 두 성분의 평균을 [TREND_WEAK, TREND_STRONG]로 사상한다.

    성분이 하나뿐이면 그 하나로, 둘 다 없으면(정보 없음) STRONG. 옛 계단은
    조건을 넘는 순간 ×0.6, ×0.25가 한 번에 곱해져 문턱 근처 종목이 널뛰었다.
    """
    week = _finite(rsi_week)
    ma = _finite(ma60_pct)
    parts = []
    if week is not None:
        parts.append(_unit_ramp(week, TREND_RSI_PIVOT, TREND_RSI_BAND))
    if ma is not None:
        parts.append(_unit_ramp(ma, 0.0, TREND_MA_BAND_PCT))
    if not parts:
        return TREND_STRONG
    strength = sum(parts) / len(parts)
    return TREND_WEAK + (TREND_STRONG - TREND_WEAK) * strength


def _upside_pct(upper_pct, upper_week_pct) -> float | None:
    day = _finite(upper_pct)
    week = _finite(upper_week_pct)
    day_up = max(day, 0.0) if day is not None else None
    week_up = max(week, 0.0) if week is not None else None
    if week_up is not None:
        week_up = min(week_up, WEEK_UPSIDE_CAP)
    if day_up is None and week_up is None:
        return None
    if day_up is None:
        return week_up
    if week_up is None:
        return day_up
    return BB_DAY_WEIGHT * day_up + BB_WEEK_WEIGHT * week_up


def entry_risk_reward_score(
    upper_pct,
    atr_pct,
    rsi_day=None,
    rsi_week=None,
    ma60_pct=None,
    upper_week_pct=None,
) -> float | None:
    """주 볼린저(캡) 위주 업사이드 / 1.5×ATR, 일 RSI·60일선 추세로 가감.

    입력이 하나라도 없으면 점수를 내지 않는다. 예전엔 없는 RSI를 1.0, 없는
    추세를 '강함'으로 채워 이력이 짧은 신규 상장이 데이터가 없다는 이유로
    상위권에 올랐다(HONA: 주RSI·주상단·60일선 전부 결측인데 전체 1위).
    회피 게이지에서 '모르면 안전'은 방향이 반대다. 실질 기준은 상장 20주.
    """
    if any(_finite(value) is None for value in (upper_pct, upper_week_pct, rsi_day, rsi_week, ma60_pct)):
        return None
    upside = _upside_pct(upper_pct, upper_week_pct)
    atr = _finite(atr_pct)
    if upside is None or atr is None or atr < 0:
        return None
    stop = max(atr * STOP_ATR_MULT, ATR_FLOOR_PCT)
    if stop <= 0:
        return None
    score = (upside / stop) * _rsi_factor(rsi_day) * _trend_factor(rsi_week, ma60_pct)
    if score < 0:
        score = 0.0
    return round(min(score, SCORE_CAP), 2)

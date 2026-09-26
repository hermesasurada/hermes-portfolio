"""API 응답 크기 줄이기 — 화면 정밀도를 넘는 실수 자릿수를 '응답 경계에서만' 반올림한다.

차트 한 점에 필드 26개가 17자리 실수 그대로 나가 NVDA 전체 기간이 2MB, 성과차트(계좌별)가
2.9MB였다. 계산·저장 값과 내부 함수는 원래 정밀도 그대로 두고(테스트도 그대로), 웹 서버가
응답을 내보내기 직전에만 새 사본을 만들어 줄인다.
"""
from __future__ import annotations

import math

# 성과 금액(원화)은 원 단위, 시간가중 지수는 소수 8자리(표시 %는 소수 2자리)면 충분하다.
PERFORMANCE_AMOUNT_KEYS = frozenset({"value", "trade_cash", "flow", "value_fixed", "trade_cash_fixed", "flow_fixed"})
PERFORMANCE_INDEX_KEYS = frozenset({"twr", "twr_fixed"})


def round_price(value):
    """유효숫자 6자리. 단 정수부는 자르지 않고(BTC 원화가 등) 소수는 최소 2자리(달러 센트) 남긴다."""
    if not isinstance(value, float) or not math.isfinite(value) or value == 0:
        return value
    integer_digits = math.floor(math.log10(abs(value))) + 1  # 1 미만이면 0 이하
    return round(value, max(2, 6 - integer_digits))


def _compact_chart_point(point: dict) -> dict:
    out = {}
    for key, value in point.items():
        if not isinstance(value, float) or not math.isfinite(value):
            out[key] = value
        elif key == "volume":
            # 주식 거래량은 정수(…123.0 → …123), 코인 거래량은 소수라 가격 규칙으로 줄인다.
            out[key] = int(value) if value.is_integer() else round_price(value)
        elif key in ("rsi", "entry_score"):
            out[key] = round(value, 2)
        else:  # 시고저종 · 이동평균 · 볼린저 · 일목 — 모두 가격 단위
            out[key] = round_price(value)
    return out


def compact_chart_payload(payload: dict) -> dict:
    """/api/chart 응답의 점·일목 선행 구름을 줄인 사본. 나머지(거래 마커 등)는 그대로."""
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    if isinstance(payload.get("points"), list):
        out["points"] = [_compact_chart_point(p) if isinstance(p, dict) else p for p in payload["points"]]
    projection = payload.get("ichimoku_projection")
    if isinstance(projection, dict):
        out["ichimoku_projection"] = {
            interval: [_compact_chart_point(p) if isinstance(p, dict) else p for p in rows] if isinstance(rows, list) else rows
            for interval, rows in projection.items()
        }
    return out


def _compact_performance_point(point: dict) -> dict:
    out = {}
    for key, value in point.items():
        if not isinstance(value, float) or not math.isfinite(value):
            out[key] = value
        elif key in PERFORMANCE_AMOUNT_KEYS:
            out[key] = int(round(value))
        elif key in PERFORMANCE_INDEX_KEYS:
            out[key] = round(value, 8)
        else:
            out[key] = round_price(value)
    return out


def compact_performance_payload(payload: dict) -> dict:
    """/api/account-performance 응답의 합산·계좌별·비교지수 점을 줄인 사본."""
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    points = lambda rows: [_compact_performance_point(p) if isinstance(p, dict) else p for p in rows]  # noqa: E731
    if isinstance(payload.get("points"), list):
        out["points"] = points(payload["points"])
    if isinstance(payload.get("account_series"), list):
        out["account_series"] = [
            {**series, "points": points(series["points"])} if isinstance(series, dict) and isinstance(series.get("points"), list) else series
            for series in payload["account_series"]
        ]
    # 비교지수 점의 value는 원화 금액이 아니라 지수 수준이다 — 금액 규칙(원 단위)이 아니라 가격 규칙.
    index_points = lambda rows: [  # noqa: E731
        {k: round_price(v) for k, v in p.items()} if isinstance(p, dict) else p for p in rows
    ]
    if isinstance(payload.get("indexes"), dict):
        out["indexes"] = {
            key: {**series, "points": index_points(series["points"])} if isinstance(series, dict) and isinstance(series.get("points"), list) else series
            for key, series in payload["indexes"].items()
        }
    return out

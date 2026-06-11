"""공용 날짜/값 헬퍼 — 여러 모듈에 똑같이 복제돼 있던 것만 모음.
(사이트별 포맷 파서 _date_from_us_text 등은 중복이 아니라 각 모듈에 그대로 둔다.)"""
from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any

from .paths import KST


def today_kst() -> date:
    return datetime.now(KST).date()


def now_kst_text() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


def positive_float(value: Any) -> float | None:
    """유한 양수 float만 통과 (배당금 등). 그 외 None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def parse_iso_date(value: Any) -> date | None:
    """'YYYY-MM-DD...' 앞 10자를 date로. 실패 시 None."""
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def to_iso_text(value: Any) -> str | None:
    """date/datetime/문자열을 'YYYY-MM-DD' 문자열로 정규화. 실패 시 None."""
    if value is None:
        return None
    if hasattr(value, "date") and not isinstance(value, date):
        value = value.date()
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    text = str(value)
    return text[:10] if len(text) >= 10 else None

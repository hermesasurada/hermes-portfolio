"""공용 날짜 헬퍼 — 여러 모듈에 똑같이 복제돼 있던 ISO 파서/정규화만 모음.
(사이트별 포맷 파서 _date_from_us_text 등은 중복이 아니라 각 모듈에 그대로 둔다.)"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any


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

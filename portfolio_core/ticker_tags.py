"""종목 태그 — 종목마다 사용자가 붙이는 자유 태그(#반도체 #CPU #파운드리). 2026-10-12 사용자 요청.

계좌·관심그룹과 무관하게 종목(티커)에 붙고, 세부내역·배당·관심목록 화면에서 태그로 거른다.
순서는 사용자가 적은 순서를 지킨다(position). 수집 대상에서 종목을 빼도 태그는 남긴다 — 사용자 데이터라
다시 등록하면 그대로 살아난다.
"""

from __future__ import annotations

import re
import sqlite3

from .dates import now_kst_text
from .db import connect, ensure_ticker_tags_table

MAX_TAG_LENGTH = 20
MAX_TAGS_PER_TICKER = 10
_TAG_SPLIT = re.compile(r"[\s,]+")


def clean_tag(value: object) -> str:
    """'#반도체' → '반도체'. 앞쪽 #·공백 제거, 안쪽 공백은 없앤다(태그는 한 단어)."""
    tag = str(value or "").strip().lstrip("#").strip()
    return re.sub(r"\s+", "", tag)


def clean_tags(values: object) -> list[str]:
    """문자열('#반도체 #CPU, 파운드리') 또는 목록 → 정리된 태그 목록(순서 유지, 대소문자 무시 중복 제거)."""
    if isinstance(values, str):
        raw = _TAG_SPLIT.split(values)
    else:
        raw = list(values or [])
    tags: list[str] = []
    seen: set[str] = set()
    for value in raw:
        tag = clean_tag(value)
        if not tag:
            continue
        if len(tag) > MAX_TAG_LENGTH:
            raise ValueError(f"태그는 {MAX_TAG_LENGTH}자 이하여야 합니다: {tag}")
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        tags.append(tag)
    if len(tags) > MAX_TAGS_PER_TICKER:
        raise ValueError(f"태그는 종목당 {MAX_TAGS_PER_TICKER}개까지입니다.")
    return tags


def load_ticker_tags(conn: sqlite3.Connection) -> dict[str, list[str]]:
    ensure_ticker_tags_table(conn)
    tags: dict[str, list[str]] = {}
    for row in conn.execute("SELECT ticker, tag FROM ticker_tags ORDER BY ticker, position, tag"):
        tags.setdefault(row["ticker"], []).append(row["tag"])
    return tags


def tag_counts(tags_by_ticker: dict[str, list[str]]) -> list[dict]:
    """전체 태그와 종목 수 — 많이 쓴 순, 같으면 가나다순."""
    counts: dict[str, int] = {}
    for tags in tags_by_ticker.values():
        for tag in tags:
            counts[tag] = counts.get(tag, 0) + 1
    return [{"tag": tag, "count": count} for tag, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]


def load_tags_payload() -> dict:
    with connect() as conn:
        tags = load_ticker_tags(conn)
    return {"tags": tags, "all": tag_counts(tags)}


def set_ticker_tags(payload: dict) -> dict:
    """종목의 태그를 통째로 바꾼다(빈 목록이면 모두 지움)."""
    ticker = str(payload.get("ticker") or "").strip().upper()
    if not ticker:
        raise ValueError("종목코드를 입력해야 합니다.")
    tags = clean_tags(payload.get("tags"))
    now = now_kst_text()
    with connect() as conn:
        ensure_ticker_tags_table(conn)
        conn.execute("DELETE FROM ticker_tags WHERE ticker = ?", (ticker,))
        conn.executemany(
            "INSERT INTO ticker_tags (ticker, tag, position, created_at) VALUES (?, ?, ?, ?)",
            [(ticker, tag, position, now) for position, tag in enumerate(tags)],
        )
        all_tags = load_ticker_tags(conn)
    return {"ok": True, "ticker": ticker, "tags": tags, "all": tag_counts(all_tags)}

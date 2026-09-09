"""Reviewed, locally authored introductions; never generate or fetch on a page read."""
from __future__ import annotations

import json
from datetime import date
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from .db import connect
from .paths import DB_PATH

PROFILE_PATH = DB_PATH.parent / "company_profiles.json"


def validate_catalog(data: dict) -> dict:
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("소개문 카탈로그 버전 오류")
    profiles = data.get("profiles")
    if not isinstance(profiles, dict):
        raise ValueError("소개문 목록 누락")
    for ticker, profile in profiles.items():
        if not isinstance(ticker, str) or ticker != ticker.strip().upper() or not ticker:
            raise ValueError("소개문 티커 오류")
        if not isinstance(profile, dict) or profile.get("kind") not in {"company", "etf", "asset", "index", "fx"}:
            raise ValueError(f"{ticker}: 소개 유형 오류")
        paragraphs = profile.get("paragraphs")
        if not isinstance(paragraphs, list) or not 1 <= len(paragraphs) <= 4:
            raise ValueError(f"{ticker}: 본문 누락")
        if any(not isinstance(p, str) or not p.strip() for p in paragraphs):
            raise ValueError(f"{ticker}: 빈 본문")
        body = " ".join(paragraphs)
        if not 200 <= len(body) <= 1600 or "니다" in body:
            raise ValueError(f"{ticker}: 본문 길이 또는 문체 오류")
        date.fromisoformat(profile.get("reviewed_at", ""))
        if not isinstance(profile.get("basis"), str) or not profile["basis"].strip():
            raise ValueError(f"{ticker}: 자료 기준 누락")
        sources = profile.get("sources")
        if not isinstance(sources, list) or not 1 <= len(sources) <= 8:
            raise ValueError(f"{ticker}: 근거 누락")
        for source in sources:
            if not isinstance(source, dict) or not isinstance(source.get("url"), str):
                raise ValueError(f"{ticker}: 근거 형식 오류")
            parsed = urlparse(source["url"])
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError(f"{ticker}: 안전하지 않은 근거 URL")
            if not isinstance(source.get("title"), str) or not source["title"].strip():
                raise ValueError(f"{ticker}: 근거 제목 누락")
    return data


@lru_cache(maxsize=2)
def _read_catalog(path: str, modified_ns: int, size: int) -> dict:
    return validate_catalog(json.loads(Path(path).read_text(encoding="utf-8")))


def load_company_profile(ticker: str) -> dict:
    ticker = str(ticker or "").strip().upper()
    with connect() as conn:
        row = conn.execute(
            "SELECT ticker, COALESCE(NULLIF(display_name, ''), name, ticker) AS name "
            "FROM tickers WHERE ticker = ?", (ticker,),
        ).fetchone()
    if not row:
        raise ValueError("등록되지 않은 종목")
    result = {"ticker": ticker, "name": row["name"], "status": "pending"}
    try:
        stat = PROFILE_PATH.stat()
    except FileNotFoundError:
        return result
    catalog = _read_catalog(str(PROFILE_PATH), stat.st_mtime_ns, stat.st_size)
    profile = catalog["profiles"].get(ticker)
    if profile:
        result.update(profile)
        result["status"] = "ready"
    return result

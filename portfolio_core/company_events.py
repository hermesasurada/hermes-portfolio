"""기업별 촉매·일정(2026-11-08, 지식증류 연동): 종목 세부페이지의 '촉매·일정' 팝업.

증류 파이프라인이 게시 때마다 만드는 ~/.hermes/vault-enrich/unified/company-events.latest.json만 읽는다.
볼트 사이드카를 읽거나 가설 상태에서 재계산하지 않는다. 티커는 정확히 일치할 때만(2382.TW ≠ 2382.HK).
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

_loaded: tuple[int, dict] = (0, {})
# 증류가 포트폴리오 DB의 실적 예정일을 되돌려 넣은 행. 팝업에서 '실적' 칩으로 보인다.
PORTFOLIO_ATTRIBUTION = "portfolio_db"
# 파일은 증류 게시 때만 다시 만들어져 bucket이 최대 1주 어긋난다. 날짜 있는 열린 일정은 오늘 기준으로 다시 나눈다.
DATED_BUCKETS = {"upcoming", "overdue_unresolved", "stale"}
STALE_AFTER_DAYS = 45
# 날짜가 7일 이상 지난 일정은 판정 여부와 무관하게 보이지 않는다(2026-11-08 사용자 지시). 날짜 없는 일정은 남긴다.
HIDE_PAST_AFTER_DAYS = 7


def cache_path() -> Path:
    return Path.home() / ".hermes" / "vault-enrich" / "unified" / "company-events.latest.json"


def _cache() -> dict:
    """파일이 바뀔 때만 다시 읽는다. 없거나 깨졌으면 빈 값(버튼이 숨는다)."""
    global _loaded
    try:
        mtime = cache_path().stat().st_mtime_ns
    except OSError:
        return {}
    if mtime != _loaded[0]:
        try:
            data = json.loads(cache_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        _loaded = (mtime, data if isinstance(data, dict) else {})
    return _loaded[1]


def _company(ticker: str) -> dict | None:
    companies = _cache().get("companies")
    entry = companies.get(ticker) if isinstance(companies, dict) and ticker else None
    return entry if isinstance(entry, dict) and isinstance(entry.get("events"), list) else None


def _rebucket(event: dict, today: date) -> dict:
    """증류 기준일이 아니라 오늘 기준의 묶음. 판정·미정 행과 날짜를 못 읽는 행은 원래 bucket을 쓴다."""
    bucket = event.get("bucket")
    if bucket not in DATED_BUCKETS:
        return event
    try:
        when = date.fromisoformat(str(event.get("date") or ""))
    except ValueError:
        return event
    if when >= today:
        now = "upcoming"
    elif today - when <= timedelta(days=STALE_AFTER_DAYS):
        now = "overdue_unresolved"
    else:
        now = "stale"
    return event if now == bucket else {**event, "bucket": now, "source_bucket": bucket}


def _long_past(event: dict, today: date) -> bool:
    try:
        when = date.fromisoformat(str(event.get("date") or ""))
    except ValueError:
        return False
    return today - when >= timedelta(days=HIDE_PAST_AFTER_DAYS)


def _events(entry: dict, today: date | None = None) -> list[dict]:
    today = today or date.today()
    return [_rebucket(event, today) for event in entry["events"]
            if isinstance(event, dict) and not _long_past(event, today)]


def company_events_summary(ticker: str, today: date | None = None) -> dict | None:
    """버튼 표시용 요약. 실적 예정일만 있어도 이벤트가 하나라도 있으면 값을 낸다(2026-11-08 사용자 지시)."""
    entry = _company(str(ticker or "").strip())
    if entry is None:
        return None
    events = _events(entry, today)
    if not events:
        return None
    # 배지는 팝업 요약의 '다가오는' 건수와 같게(실적 예정일 포함)
    return {"count": len(events), "upcoming": sum(event.get("bucket") == "upcoming" for event in events)}


def load_company_events(ticker: str, today: date | None = None) -> dict:
    """as_of는 증류 리포트 기준일(serving.report_as_of). 최상위 as_of는 파일 생성 때의 bucket 계산일이라 쓰지 않는다."""
    data = _cache()
    serving = data.get("serving") if isinstance(data.get("serving"), dict) else {}
    entry = _company(str(ticker or "").strip())
    company = None
    if entry is not None:
        events = _events(entry, today)
        counts = {bucket: 0 for bucket in ("upcoming", "overdue_unresolved", "undated", "stale", "resolved")}
        for event in events:
            if event.get("bucket") in counts:
                counts[event["bucket"]] += 1
        upcoming = sorted(str(event["date"]) for event in events if event.get("bucket") == "upcoming" and event.get("date"))
        company = {**entry, "events": events, "counts": counts, "next_date": upcoming[0] if upcoming else None}
    return {
        "ticker": str(ticker or "").strip(),
        "as_of": str(serving.get("report_as_of") or data.get("as_of") or ""),
        "generated_at": str(serving.get("refreshed_at") or data.get("generated_at") or ""),
        "company": company,
    }

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .db import ensure_earnings_events_table, ensure_ticker_metadata_columns


_RUN_HEADER_RE = re.compile(
    r"^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z]+)\] exit=\d+\s*$"
)
_EARNINGS_LINE_RE = re.compile(r"^\s*\+\s+(\S+)\s+earnings:\s+(\d{4}-\d{2}-\d{2})\s*$")


@dataclass(frozen=True)
class EarningsHistoryCandidate:
    ticker: str
    earnings_date: date
    source: str
    observed_at: str


def _month_prefix(month: str) -> str:
    try:
        parsed = datetime.strptime(month, "%Y-%m")
    except ValueError as exc:
        raise ValueError("month must be YYYY-MM") from exc
    return parsed.strftime("%Y-%m")


def _header_observed_at(match: re.Match[str]) -> str:
    zone_name = match.group(3)
    zone = ZoneInfo("Asia/Seoul") if zone_name == "KST" else timezone.utc
    parsed = datetime.strptime(f"{match.group(1)} {match.group(2)}", "%Y-%m-%d %H:%M:%S")
    return parsed.replace(tzinfo=zone).isoformat(timespec="seconds")


def collector_log_candidates(paths: list[Path], month: str) -> dict[str, EarningsHistoryCandidate]:
    """수집 로그에서 종목별로 마지막으로 관측된 월간 실적일을 복원한다."""
    prefix = _month_prefix(month)
    candidates: dict[str, EarningsHistoryCandidate] = {}
    for path in paths:
        if not path.exists():
            continue
        observed_at = ""
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            header = _RUN_HEADER_RE.match(line)
            if header:
                observed_at = _header_observed_at(header)
                continue
            event = _EARNINGS_LINE_RE.match(line)
            if not event or not event.group(2).startswith(f"{prefix}-"):
                continue
            ticker = event.group(1).strip().upper()
            event_date = date.fromisoformat(event.group(2))
            candidate = EarningsHistoryCandidate(
                ticker=ticker,
                earnings_date=event_date,
                source="collector-log",
                observed_at=observed_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
            previous = candidates.get(ticker)
            if previous is None or candidate.observed_at >= previous.observed_at:
                candidates[ticker] = candidate
    return candidates


def cached_yfinance_candidates(
    conn: sqlite3.Connection,
    month: str,
) -> dict[str, EarningsHistoryCandidate]:
    """펀더멘털 캐시의 Yahoo 직전 실적 타임스탬프를 거래소 현지 날짜로 복원한다."""
    prefix = _month_prefix(month)
    try:
        rows = conn.execute(
            """
            SELECT t.ticker, s.raw_json, s.fetched_at
            FROM tickers t
            JOIN ticker_stats_cache s ON s.ticker = t.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND s.raw_json IS NOT NULL
            """
        ).fetchall()
    except sqlite3.OperationalError:
        return {}

    candidates: dict[str, EarningsHistoryCandidate] = {}
    for row in rows:
        try:
            raw = json.loads(row["raw_json"] or "{}")
            info = raw.get("info") or {}
            timestamp = float(info.get("earningsTimestamp"))
            if timestamp > 10_000_000_000:
                timestamp /= 1000
            zone_name = str(info.get("exchangeTimezoneName") or "UTC")
            try:
                zone = ZoneInfo(zone_name)
            except ZoneInfoNotFoundError:
                zone = timezone.utc
            event_date = datetime.fromtimestamp(timestamp, zone).date()
        except (TypeError, ValueError, OverflowError, json.JSONDecodeError):
            continue
        if not event_date.isoformat().startswith(f"{prefix}-"):
            continue
        ticker = str(row["ticker"] or "").strip().upper()
        if not ticker:
            continue
        candidates[ticker] = EarningsHistoryCandidate(
            ticker=ticker,
            earnings_date=event_date,
            source="yfinance-info-cache",
            observed_at=str(row["fetched_at"] or datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )
    return candidates


def backfill_earnings_month(
    conn: sqlite3.Connection,
    month: str,
    log_paths: list[Path],
    duplicate_tolerance_days: int = 7,
) -> dict[str, int]:
    """한 달의 실적일을 캐시 우선, 수집 로그 보완 순서로 이력 테이블에 복원한다."""
    _month_prefix(month)
    ensure_ticker_metadata_columns(conn)
    ensure_earnings_events_table(conn)

    tracked = {
        str(row["ticker"]).upper()
        for row in conn.execute(
            """
            SELECT ticker
            FROM tickers
            WHERE category IN ('kr', 'overseas')
              AND ticker IS NOT NULL
              AND TRIM(ticker) <> ''
            """
        ).fetchall()
    }
    existing: dict[str, list[date]] = {}
    for row in conn.execute("SELECT ticker, earnings_date FROM earnings_events").fetchall():
        try:
            event_date = date.fromisoformat(str(row["earnings_date"])[:10])
        except ValueError:
            continue
        existing.setdefault(str(row["ticker"]).upper(), []).append(event_date)

    candidates = collector_log_candidates(log_paths, month)
    # Yahoo info의 earningsTimestamp는 마지막 실제 발표 시각이므로 로그의 당시
    # 예상 캘린더보다 우선한다.
    candidates.update(cached_yfinance_candidates(conn, month))

    inserted_by_source = {"collector-log": 0, "yfinance-info-cache": 0}
    skipped_duplicate = 0
    skipped_untracked = 0
    for ticker, candidate in sorted(candidates.items()):
        if ticker not in tracked:
            skipped_untracked += 1
            continue
        if any(
            abs((known_date - candidate.earnings_date).days) <= duplicate_tolerance_days
            for known_date in existing.get(ticker, [])
        ):
            skipped_duplicate += 1
            continue
        conn.execute(
            """
            INSERT OR IGNORE INTO earnings_events
              (ticker, earnings_date, source, observed_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                candidate.ticker,
                candidate.earnings_date.isoformat(),
                candidate.source,
                candidate.observed_at,
            ),
        )
        existing.setdefault(ticker, []).append(candidate.earnings_date)
        inserted_by_source[candidate.source] += 1

    return {
        "candidate_count": len(candidates),
        "inserted": sum(inserted_by_source.values()),
        "inserted_collector_log": inserted_by_source["collector-log"],
        "inserted_yfinance_cache": inserted_by_source["yfinance-info-cache"],
        "skipped_duplicate": skipped_duplicate,
        "skipped_untracked": skipped_untracked,
    }

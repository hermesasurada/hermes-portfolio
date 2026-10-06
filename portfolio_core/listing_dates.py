"""종목 상장일 — 티커 재사용 종목에서 이전 종목의 배당을 걸러 내는 기준.

Polygon 배당 조회는 티커 문자열로만 찾아서, 같은 티커를 먼저 쓰던 종목의 배당까지
돌려준다(SPCX: 2021~2025 SPAC ETF 분배금 6건 → 2026-06-12 상장한 SpaceX에 붙었다,
SPAX도 같다). 상장일 이전 배당은 그 종목의 것일 수 없으므로 버린다.

상장일은 바뀌지 않으므로 종목당 한 번만 조회한다(ticker_listing_dates). 미국 종목만
대상이다(Polygon 무료 티어, 분당 5콜 — 배치 수집에서만 부른다).
"""

from __future__ import annotations

from typing import Iterable

from .dates import now_kst_text
from .db import connect, ensure_listing_dates_table
from .dividend_sources import _polygon_candidate, fetch_polygon_list_date

SETTLED_STATUSES = ("ok", "none")   # 확정 — 다시 묻지 않는다


def load_listing_dates(conn, tickers: Iterable[str]) -> dict[str, str]:
    """{ticker: list_date} — 상장일이 확정된 종목만."""
    ensure_listing_dates_table(conn)
    clean = sorted({str(t).strip().upper() for t in tickers if str(t).strip()})
    if not clean:
        return {}
    placeholders = ",".join("?" for _ in clean)
    rows = conn.execute(
        f"SELECT ticker, list_date FROM ticker_listing_dates WHERE ticker IN ({placeholders}) AND list_date IS NOT NULL",
        clean,
    ).fetchall()
    return {row[0]: row[1] for row in rows}


def ensure_listing_dates(tickers: Iterable[str]) -> dict[str, str]:
    """아직 확정되지 않은 미국 종목의 상장일을 조회해 저장한다. {ticker: status}."""
    clean = sorted({str(t).strip().upper() for t in tickers if str(t).strip()})
    candidates = [t for t in clean if _polygon_candidate(t)]
    if not candidates:
        return {}
    with connect() as conn:
        ensure_listing_dates_table(conn)
        placeholders = ",".join("?" for _ in candidates)
        settled = {
            row[0] for row in conn.execute(
                f"SELECT ticker FROM ticker_listing_dates WHERE ticker IN ({placeholders}) AND status IN ('ok', 'none')",
                candidates,
            ).fetchall()
        }
    results: dict[str, str] = {}
    for ticker in candidates:
        if ticker in settled:
            continue
        list_date, status = fetch_polygon_list_date(ticker)
        if status == "nokey":
            break
        results[ticker] = status
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO ticker_listing_dates (ticker, list_date, source, status, fetched_at)
                VALUES (?, ?, 'polygon', ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    list_date = excluded.list_date, source = excluded.source,
                    status = excluded.status, fetched_at = excluded.fetched_at
                """,
                (ticker, list_date, status, now_kst_text()),
            )
            conn.commit()
    return results


def before_listing(event: dict, list_date: str | None) -> bool:
    """상장일 이전 배당인가 — 배당락일(없으면 기준일·지급일) 기준."""
    if not list_date:
        return False
    day = str(event.get("ex_date") or event.get("record_date") or event.get("pay_date") or "")[:10]
    return bool(day) and day < list_date

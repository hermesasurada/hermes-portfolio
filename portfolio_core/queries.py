from __future__ import annotations

import sqlite3
from typing import Iterable


def clean_account_ids(account_ids: Iterable[str] | None) -> list[int]:
    return [int(value) for value in (account_ids or []) if str(value).strip()]


def load_collection_diagnostics(conn: sqlite3.Connection) -> dict:
    """수집 상태 진단 — 기존 DB 흔적만 노출(새 수집 없음). 조용히 삼켜지던 실패를
    화면에 보이게 하기 위함."""
    dividend_errors = conn.execute(
        "SELECT ticker, status FROM ticker_dividend_cache WHERE status LIKE '%_error%' ORDER BY ticker"
    ).fetchall()
    stale = conn.execute(
        """
        WITH latest AS (SELECT MAX(date) AS d FROM daily_prices)
        SELECT t.ticker, MAX(p.date) AS last_date
        FROM tickers t
        JOIN daily_prices p ON p.ticker = t.ticker
        WHERE t.category IN ('overseas', 'kr', 'crypto')
        GROUP BY t.ticker
        HAVING julianday((SELECT d FROM latest)) - julianday(MAX(p.date)) > 4
        ORDER BY last_date
        """
    ).fetchall()
    run = conn.execute(
        "SELECT updated_at, item_count FROM collector_runs WHERE name = 'price'"
    ).fetchone()
    return {
        "dividend_errors": [{"ticker": row["ticker"], "status": row["status"]} for row in dividend_errors],
        "stale_prices": [{"ticker": row["ticker"], "last_date": row["last_date"]} for row in stale],
        "price_run": ({"updated_at": run["updated_at"], "item_count": run["item_count"]} if run else None),
    }


def load_ticker_directory(conn: sqlite3.Connection) -> list[dict]:
    """DB에 등록된 전체 종목(티커·이름) — 비교 검색 자동완성용. DB 전용."""
    rows = conn.execute(
        """
        SELECT ticker, name
        FROM tickers
        WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''
        ORDER BY ticker
        """
    ).fetchall()
    return [{"ticker": row["ticker"], "name": row["name"] or row["ticker"]} for row in rows]


def account_filter_clause(account_ids: list[int], alias: str = "a") -> tuple[str, list[object]]:
    if not account_ids:
        return "", []
    placeholders = ",".join("?" for _ in account_ids)
    return f"WHERE {alias}.id IN ({placeholders})", list(account_ids)


def load_holding_rows(
    conn: sqlite3.Connection,
    account_ids: list[int] | None = None,
    positive_only: bool = False,
) -> list[sqlite3.Row]:
    params: list[object] = []
    conditions: list[str] = []
    if account_ids:
        placeholders = ",".join("?" for _ in account_ids)
        conditions.append(f"a.id IN ({placeholders})")
        params.extend(account_ids)
    if positive_only:
        conditions.append("COALESCE(h.qty, 0) > 0")
    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    return conn.execute(
        f"""
        SELECT
            h.account_id,
            COALESCE(h.member, a.member) AS member,
            a.account_type,
            a.name AS account_name,
            a.region,
            h.ticker,
            h.qty,
            h.avg_price,
            h.invested,
            h.updated_at,
            COALESCE(h.currency, tk.currency, '') AS currency,
            COALESCE(tk.name, h.name, h.ticker) AS name
        FROM holdings h
        JOIN accounts a ON a.id = h.account_id
        LEFT JOIN tickers tk ON tk.ticker = h.ticker
        {where_sql}
        ORDER BY h.account_id, h.ticker
        """,
        params,
    ).fetchall()

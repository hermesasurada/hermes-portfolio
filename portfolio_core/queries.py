from __future__ import annotations

import sqlite3
from typing import Iterable


def clean_account_ids(account_ids: Iterable[str] | None) -> list[int]:
    return [int(value) for value in (account_ids or []) if str(value).strip()]


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

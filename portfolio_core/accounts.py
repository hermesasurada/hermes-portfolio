from __future__ import annotations

import sqlite3


def load_account(conn: sqlite3.Connection, account_id: int) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id, member, account_type, currency AS account_currency, name
        FROM accounts
        WHERE id = ?
        """,
        (account_id,),
    ).fetchone()


def load_holding(conn: sqlite3.Connection, account_id: int, ticker: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id, qty, avg_price, invested, name, currency
        FROM holdings
        WHERE account_id = ? AND ticker = ?
        """,
        (account_id, ticker),
    ).fetchone()


def load_ticker_info(conn: sqlite3.Connection, ticker: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT name, currency, category
        FROM tickers
        WHERE ticker = ?
        """,
        (ticker,),
    ).fetchone()

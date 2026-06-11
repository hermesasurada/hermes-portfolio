from __future__ import annotations

import sqlite3

from .constants import MARKET_INDEXES
from .paths import DB_PATH


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_ticker_metadata_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(tickers)").fetchall()}
    if "next_earnings_date" not in columns:
        conn.execute("ALTER TABLE tickers ADD COLUMN next_earnings_date TEXT")
    if "earnings_updated_at" not in columns:
        conn.execute("ALTER TABLE tickers ADD COLUMN earnings_updated_at TEXT")


def ensure_stats_cache_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ticker_stats_cache (
            ticker TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            fetched_ts REAL NOT NULL,
            fetched_at TEXT NOT NULL,
            source TEXT,
            market_cap REAL,
            dividend_yield REAL,
            trailing_pe REAL,
            forward_pe REAL,
            next_earnings_date TEXT,
            raw_json TEXT
        )
        """
    )
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(ticker_stats_cache)").fetchall()}
    if "next_earnings_date" not in columns:
        conn.execute("ALTER TABLE ticker_stats_cache ADD COLUMN next_earnings_date TEXT")
    if "price_to_book" not in columns:
        conn.execute("ALTER TABLE ticker_stats_cache ADD COLUMN price_to_book REAL")


def ensure_technical_stats_cache_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ticker_technical_stats_cache (
            ticker TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            latest_date TEXT,
            price_count INTEGER NOT NULL,
            computed_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )
        """
    )


def ensure_daily_technical_indicators_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS daily_technical_indicators (
            ticker TEXT NOT NULL,
            date TEXT NOT NULL,
            rsi_14 REAL,
            computed_at TEXT NOT NULL,
            PRIMARY KEY (ticker, date)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_daily_technical_indicators_ticker_date
        ON daily_technical_indicators(ticker, date)
        """
    )


def ensure_price_indexes(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_daily_prices_ticker_date_desc
        ON daily_prices(ticker, date DESC)
        """
    )


def ensure_collector_runs_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS collector_runs (
            name TEXT PRIMARY KEY,
            updated_at TEXT NOT NULL,
            item_count INTEGER NOT NULL DEFAULT 0,
            meta_json TEXT
        )
        """
    )


def ensure_transaction_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(transactions)").fetchall()}
    if "apply_to_holdings" not in columns:
        conn.execute("ALTER TABLE transactions ADD COLUMN apply_to_holdings INTEGER NOT NULL DEFAULT 1")


def ensure_dividend_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dividend_events (
            ticker TEXT NOT NULL,
            ex_date TEXT NOT NULL,
            pay_date TEXT,
            amount REAL,
            currency TEXT,
            source TEXT,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (ticker, ex_date)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ticker_dividend_cache (
            ticker TEXT PRIMARY KEY,
            fetched_at TEXT NOT NULL,
            status TEXT
        )
        """
    )
    # Polygon 소스용 선언일/기준일 컬럼 보강 (기존 DB 마이그레이션)
    dividend_columns = {row["name"] for row in conn.execute("PRAGMA table_info(dividend_events)").fetchall()}
    for column in ("declaration_date", "record_date"):
        if column not in dividend_columns:
            conn.execute(f"ALTER TABLE dividend_events ADD COLUMN {column} TEXT")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dividend_events_pay_date
        ON dividend_events(pay_date, ex_date)
        """
    )


def ensure_stock_split_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS stock_splits (
            ticker TEXT NOT NULL,
            split_date TEXT NOT NULL,
            ratio REAL NOT NULL,
            source TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (ticker, split_date)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ticker_split_cache (
            ticker TEXT PRIMARY KEY,
            fetched_at TEXT NOT NULL,
            status TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stock_splits_ticker_date
        ON stock_splits(ticker, split_date)
        """
    )


def ensure_market_index_tickers(conn: sqlite3.Connection) -> None:
    for ticker, meta in MARKET_INDEXES.items():
        conn.execute(
            """
            INSERT INTO tickers (ticker, name, region, currency, added_date, category)
            VALUES (?, ?, ?, ?, DATE('now'), 'index')
            ON CONFLICT(ticker) DO UPDATE SET
                name = excluded.name,
                region = excluded.region,
                currency = excluded.currency,
                category = 'index'
            """,
            (ticker, meta["name"], meta["region"], meta["currency"]),
        )


def initialize_schema() -> None:
    with connect() as conn:
        ensure_ticker_metadata_columns(conn)
        ensure_stats_cache_table(conn)
        ensure_technical_stats_cache_table(conn)
        ensure_daily_technical_indicators_table(conn)
        ensure_transaction_columns(conn)
        ensure_dividend_tables(conn)
        ensure_stock_split_tables(conn)
        ensure_price_indexes(conn)
        ensure_collector_runs_table(conn)
        ensure_market_index_tickers(conn)
        conn.commit()

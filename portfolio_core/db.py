from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager

from .constants import FX_NAMES, MARKET_INDEXES
from .paths import DB_PATH

SCHEMA_VERSION = 1


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """`with connect() as conn:` 전용. sqlite3 커넥션의 `with`는 트랜잭션만
    커밋/롤백할 뿐 **커넥션을 닫지 않아** 장기 구동 서버에서 FD가 누수된다
    (Errno 24: Too many open files). 여기서 finally로 확실히 close 한다.
    내부 `with conn:`은 기존과 동일한 성공 시 커밋 / 예외 시 롤백 시맨틱 유지."""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def ensure_ticker_metadata_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(tickers)").fetchall()}
    if "next_earnings_date" not in columns:
        conn.execute("ALTER TABLE tickers ADD COLUMN next_earnings_date TEXT")
    if "earnings_updated_at" not in columns:
        conn.execute("ALTER TABLE tickers ADD COLUMN earnings_updated_at TEXT")
    if "display_name" not in columns:   # 노출명칭(법인격 수식어 제거). 비면 name 폴백.
        conn.execute("ALTER TABLE tickers ADD COLUMN display_name TEXT")


def backfill_ticker_display_names(conn: sqlite3.Connection) -> None:
    from .tickers import display_name

    rows = conn.execute(
        """
        SELECT ticker, name
        FROM tickers
        WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''
          AND (display_name IS NULL OR TRIM(display_name) = '')
        """
    ).fetchall()
    if not rows:
        return
    conn.executemany(
        """
        UPDATE tickers
        SET display_name = ?
        WHERE ticker = ?
          AND (display_name IS NULL OR TRIM(display_name) = '')
        """,
        [
            (display_name(row["name"], row["ticker"]), row["ticker"])
            for row in rows
        ],
    )


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
            aum REAL,
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
    if "aum" not in columns:
        conn.execute("ALTER TABLE ticker_stats_cache ADD COLUMN aum REAL")
    if "dividend_growth_5y" not in columns:
        conn.execute("ALTER TABLE ticker_stats_cache ADD COLUMN dividend_growth_5y REAL")


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


def ensure_live_quote_cache_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ticker_live_quotes (
            ticker TEXT PRIMARY KEY,
            fetched_ts REAL NOT NULL,
            payload_json TEXT NOT NULL
        )
        """
    )


def ensure_quote_source_state_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS quote_source_state (
            source TEXT PRIMARY KEY,
            failure_count INTEGER NOT NULL DEFAULT 0,
            blocked_until REAL,
            last_error TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )


def ensure_interest_watchlist_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS interest_watchlist_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS interest_watchlist_items (
            group_id INTEGER NOT NULL,
            ticker TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            PRIMARY KEY (group_id, ticker)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS interest_watchlist_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_interest_watchlist_items_group_order
        ON interest_watchlist_items(group_id, sort_order, ticker)
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
            INSERT INTO tickers (ticker, name, region, currency, added_date, category, display_name)
            VALUES (?, ?, ?, ?, DATE('now'), 'index', ?)
            ON CONFLICT(ticker) DO UPDATE SET
                name = excluded.name,
                region = excluded.region,
                currency = excluded.currency,
                category = 'index',
                display_name = excluded.display_name
            """,
            (ticker, meta["name"], meta["region"], meta["currency"], meta["name"]),
        )


def ensure_fx_tickers(conn: sqlite3.Connection) -> None:
    for ticker, name in FX_NAMES.items():
        conn.execute(
            """
            INSERT INTO tickers (ticker, name, region, currency, added_date, category)
            VALUES (?, ?, NULL, NULL, DATE('now'), 'fx')
            ON CONFLICT(ticker) DO UPDATE SET
                name = excluded.name,
                category = 'fx'
            """,
            (ticker, name),
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
        ensure_live_quote_cache_table(conn)
        ensure_quote_source_state_table(conn)
        ensure_interest_watchlist_tables(conn)
        ensure_market_index_tickers(conn)
        ensure_fx_tickers(conn)
        backfill_ticker_display_names(conn)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()

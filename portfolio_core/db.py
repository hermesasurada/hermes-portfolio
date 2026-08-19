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
    if "sector" not in columns:   # GICS 섹터(yfinance info.sector — 미국 개별주 위주)
        conn.execute("ALTER TABLE tickers ADD COLUMN sector TEXT")


def ensure_earnings_events_table(conn: sqlite3.Connection) -> None:
    """실적발표일 이력. `tickers.next_earnings_date`는 최신값으로 덮어쓰므로 별도 보존한다."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS earnings_events (
            ticker TEXT NOT NULL,
            earnings_date TEXT NOT NULL,
            source TEXT,
            observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (ticker, earnings_date)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_earnings_events_date
        ON earnings_events(earnings_date, ticker)
        """
    )
    # 최초 마이그레이션과 신규 등록 종목을 위해 현재 단일값도 이력에 편입한다.
    conn.execute(
        """
        INSERT OR IGNORE INTO earnings_events
          (ticker, earnings_date, source, observed_at)
        SELECT ticker,
               date(next_earnings_date),
               'ticker-cache',
               COALESCE(NULLIF(earnings_updated_at, ''), CURRENT_TIMESTAMP)
        FROM tickers
        WHERE ticker IS NOT NULL
          AND TRIM(ticker) <> ''
          AND date(next_earnings_date) IS NOT NULL
        """
    )


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


def ensure_daily_prices_table(conn: sqlite3.Connection) -> None:
    """일봉 테이블 + OHLC 확장 컬럼.

    close만 있던 시절의 DB에는 open/high/low/volume/adj_close가 없다. 이 컬럼들은
    한동안 코드 밖(수동 ALTER)에서 추가돼 있어 저장소만으로는 새 환경을 세울 수
    없었다(`no such column: open`). 스키마 정의를 코드로 되돌린다.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS daily_prices (
            date TEXT NOT NULL,
            ticker TEXT NOT NULL,
            close REAL,
            source TEXT,
            PRIMARY KEY (date, ticker)
        )
        """
    )
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(daily_prices)").fetchall()}
    for column, column_type in (
        ("open", "REAL"),
        ("high", "REAL"),
        ("low", "REAL"),
        ("volume", "REAL"),
        ("adj_close", "REAL"),
    ):
        if column not in columns:
            conn.execute(f"ALTER TABLE daily_prices ADD COLUMN {column} {column_type}")


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


def ensure_extended_quote_cache_table(conn: sqlite3.Connection) -> None:
    """세션이 끝난 뒤에도 마지막 연장가(프리·애프터/장외)를 보여주기 위한 저장소.

    라이브 조회는 세션 중에만 되지만, 사용자는 장이 닫힌 뒤에도 그 세션의
    최종 연장가를 계속 보길 원한다. session_date가 그 종목의 정규장 가격
    날짜와 같을 때만 되살려 묵은 값이 새어나가지 않게 한다.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ticker_extended_quotes (
            ticker TEXT PRIMARY KEY,
            session_date TEXT NOT NULL,
            price REAL NOT NULL,
            base_price REAL,
            change REAL,
            change_pct REAL,
            source TEXT,
            market_state TEXT,
            updated_at TEXT NOT NULL
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
        ensure_earnings_events_table(conn)
        ensure_stats_cache_table(conn)
        ensure_technical_stats_cache_table(conn)
        ensure_daily_technical_indicators_table(conn)
        ensure_transaction_columns(conn)
        ensure_dividend_tables(conn)
        ensure_stock_split_tables(conn)
        ensure_daily_prices_table(conn)   # 인덱스보다 먼저 — 테이블·OHLC 컬럼 보장
        ensure_price_indexes(conn)
        ensure_collector_runs_table(conn)
        ensure_live_quote_cache_table(conn)
        ensure_extended_quote_cache_table(conn)
        ensure_quote_source_state_table(conn)
        ensure_interest_watchlist_tables(conn)
        ensure_market_index_tickers(conn)
        ensure_fx_tickers(conn)
        backfill_ticker_display_names(conn)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()

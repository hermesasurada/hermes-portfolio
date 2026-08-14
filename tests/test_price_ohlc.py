from __future__ import annotations

import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import portfolio_core.price_store as price_store


def memory_price_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE daily_prices (
            date TEXT NOT NULL,
            ticker TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume REAL,
            adj_close REAL,
            source TEXT,
            PRIMARY KEY (date, ticker)
        )
        """
    )
    return conn


def test_close_only_snapshot_preserves_existing_ohlc():
    conn = memory_price_db()

    @contextmanager
    def fake_connect():
        yield conn

    original = (
        price_store.connect,
        price_store.repair_split_adjusted_daily_prices,
        price_store.sanitize_price_spikes,
    )
    try:
        price_store.connect = fake_connect
        price_store.repair_split_adjusted_daily_prices = lambda *_args, **_kwargs: {}
        price_store.sanitize_price_spikes = lambda *_args, **_kwargs: {}
        price_store.save_daily_prices(
            "TEST",
            [{"date": "2026-08-06", "open": 100, "high": 110, "low": 95, "close": 105, "volume": 10}],
            "ohlc",
        )
        price_store.save_daily_prices("TEST", [("2026-08-06", 107)], "snapshot")
        row = conn.execute("SELECT * FROM daily_prices WHERE ticker = 'TEST'").fetchone()
        assert (row["open"], row["high"], row["low"], row["close"], row["volume"]) == (100, 110, 95, 107, 10)
        assert row["source"] == "snapshot"
    finally:
        price_store.connect, price_store.repair_split_adjusted_daily_prices, price_store.sanitize_price_spikes = original
        conn.close()


def test_split_repair_adjusts_complete_candle():
    conn = memory_price_db()
    conn.execute(
        """
        CREATE TABLE stock_splits (
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
        "INSERT INTO stock_splits VALUES ('TEST', '2026-08-02', 2, 'test', '2026-08-02')"
    )
    conn.executemany(
        "INSERT INTO daily_prices (date, ticker, open, high, low, close) VALUES (?, 'TEST', ?, ?, ?, ?)",
        [
            ("2026-08-01", 98, 102, 96, 100),
            ("2026-08-02", 49, 52, 48, 50),
        ],
    )

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = price_store.connect
    try:
        price_store.connect = fake_connect
        result = price_store.repair_split_adjusted_daily_prices(["TEST"])
        row = conn.execute("SELECT open, high, low, close FROM daily_prices WHERE date = '2026-08-01'").fetchone()
        assert result == {"TEST": 1}
        assert tuple(row) == (49, 51, 48, 50)
    finally:
        price_store.connect = original_connect
        conn.close()


def test_candle_bounds_stay_coherent():
    """종가가 보존된 고가·저가를 벗어나면 꼬리를 넓혀 캔들 정합성을 지킨다."""
    conn = memory_price_db()

    @contextmanager
    def fake_connect():
        yield conn

    original = (
        price_store.connect,
        price_store.repair_split_adjusted_daily_prices,
        price_store.sanitize_price_spikes,
    )
    try:
        price_store.connect = fake_connect
        price_store.repair_split_adjusted_daily_prices = lambda *_args, **_kwargs: {}
        price_store.sanitize_price_spikes = lambda *_args, **_kwargs: {}

        # ① 나중에 들어온 종가가 기존 저가보다 낮은 경우(실측 QBTS 패턴)
        price_store.save_daily_prices(
            "QBTS",
            [{"date": "2026-08-12", "open": 20.79, "high": 21.0, "low": 20.06, "close": 20.8}],
            "yf-batch",
        )
        price_store.save_daily_prices("QBTS", [("2026-08-12", 16.21)], "snapshot")
        row = conn.execute("SELECT * FROM daily_prices WHERE ticker = 'QBTS'").fetchone()
        assert row["close"] == 16.21
        assert row["low"] == 16.21   # 저가가 새 종가까지 확장
        assert row["high"] == 21.0   # 고가는 그대로

        # ② 한 행 안에서 종가가 고가를 넘는 경우 — 정규화 단계에서 교정
        price_store.save_daily_prices(
            "BAD",
            [{"date": "2026-08-12", "open": 100, "high": 105, "low": 99, "close": 110}],
            "ohlc",
        )
        row = conn.execute("SELECT * FROM daily_prices WHERE ticker = 'BAD'").fetchone()
        assert (row["high"], row["low"], row["close"]) == (110, 99, 110)

        # ③ 종가만 있는 행은 가짜 고가·저가를 만들지 않는다
        price_store.save_daily_prices("CLOSEONLY", [("2026-08-12", 50.0)], "snapshot")
        row = conn.execute("SELECT * FROM daily_prices WHERE ticker = 'CLOSEONLY'").fetchone()
        assert row["high"] is None and row["low"] is None and row["close"] == 50.0
    finally:
        price_store.connect, price_store.repair_split_adjusted_daily_prices, price_store.sanitize_price_spikes = original
        conn.close()


def test_daily_prices_schema_is_created_from_code():
    """새 DB에서도 OHLC 컬럼이 코드로 생성된다(수동 ALTER 의존 제거)."""
    import portfolio_core.db as db

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    try:
        db.ensure_daily_prices_table(conn)
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(daily_prices)").fetchall()}
        assert {"date", "ticker", "open", "high", "low", "close", "volume", "adj_close", "source"} <= columns
        # close만 있던 옛 DB에 대해서도 멱등하게 컬럼을 채운다
        legacy = sqlite3.connect(":memory:")
        legacy.row_factory = sqlite3.Row
        legacy.execute(
            "CREATE TABLE daily_prices (date TEXT NOT NULL, ticker TEXT NOT NULL, close REAL, PRIMARY KEY (date, ticker))"
        )
        db.ensure_daily_prices_table(legacy)
        db.ensure_daily_prices_table(legacy)   # 두 번 호출해도 안전
        legacy_columns = {row["name"] for row in legacy.execute("PRAGMA table_info(daily_prices)").fetchall()}
        assert {"open", "high", "low", "volume", "adj_close"} <= legacy_columns
        legacy.close()
    finally:
        conn.close()


if __name__ == "__main__":
    test_close_only_snapshot_preserves_existing_ohlc()
    test_split_repair_adjusts_complete_candle()
    test_candle_bounds_stay_coherent()
    test_daily_prices_schema_is_created_from_code()
    print("price OHLC tests passed")

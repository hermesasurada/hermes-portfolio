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


if __name__ == "__main__":
    test_close_only_snapshot_preserves_existing_ohlc()
    test_split_repair_adjusts_complete_candle()
    print("price OHLC tests passed")

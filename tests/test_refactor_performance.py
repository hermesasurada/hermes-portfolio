"""Network-free regression checks for read paths and equivalent chart math."""
from __future__ import annotations

import sqlite3
import sys
from contextlib import contextmanager
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_core.db import ensure_dividend_tables, ensure_earnings_events_table, ensure_stats_cache_table
from portfolio_core.prices import latest_prices
import portfolio_core.price_store as price_store
import portfolio_core.schedule as schedule


def test_latest_prices_seeks_all_tickers_and_preserves_previous_semantics():
    with sqlite3.connect(":memory:") as conn:
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE daily_prices(ticker TEXT, date TEXT, close REAL, source TEXT,
                                      PRIMARY KEY(ticker, date));
            CREATE INDEX idx_daily_prices_ticker_date_desc ON daily_prices(ticker, date DESC);
        """)
        assert latest_prices(conn) == {}
        conn.executemany("INSERT INTO daily_prices VALUES(?, ?, ?, 'test')", [
            ("ORPHAN", "2026-01-01", 90), ("ORPHAN", "2026-01-02", 100),
            ("ORPHAN", "2026-01-03", 100), ("ORPHAN", "2026-01-04", None),
            ("TINY", "2026-01-01", 0.000001), ("TINY", "2026-01-02", 0.000002),
            ("EMPTY", "2026-01-01", None), ("SINGLE", "2026-01-01", 1),
        ])
        all_prices = latest_prices(conn)
        assert set(all_prices) == {"ORPHAN", "TINY", "SINGLE"}
        row = all_prices["ORPHAN"]
        assert (row["price"], row["date"]) == (100, "2026-01-03")
        assert (row["previous_price"], row["previous_date"]) == (90, "2026-01-01")
        assert (row["prior_price"], row["prior_date"]) == (100, "2026-01-02")
        assert all_prices["TINY"]["previous_price"] is None
        assert all_prices["TINY"]["prior_price"] == 0.000001
        assert all_prices["SINGLE"]["prior_price"] is None
        assert latest_prices(conn, [" orphan ", "ORPHAN", "missing"]) == {"ORPHAN": row}
        assert latest_prices(conn, []) == all_prices
        # No dependency on the metadata table; also cover more than 1000 keys.
        conn.executemany("INSERT INTO daily_prices VALUES(?, '2026-01-01', 1, 'test')",
                         [(f"T{i:04}",) for i in range(1500)])
        assert len(latest_prices(conn)) == 1503


def test_schedule_is_read_only_and_collector_preserves_earnings_history():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE tickers(ticker TEXT PRIMARY KEY, name TEXT, category TEXT, currency TEXT,
                             display_name TEXT, sector TEXT, next_earnings_date TEXT, earnings_updated_at TEXT);
        CREATE TABLE holdings(ticker TEXT, qty REAL);
        INSERT INTO tickers VALUES('MSFT', 'Microsoft', 'overseas', 'USD', NULL, NULL, '2026-06-10', NULL);
        INSERT INTO holdings VALUES('MSFT', 1);
    """)
    ensure_earnings_events_table(conn)
    ensure_dividend_tables(conn)
    ensure_stats_cache_table(conn)
    conn.commit()

    @contextmanager
    def fake_connect():
        yield conn

    originals = (price_store.connect, schedule.connect, schedule.today_kst)
    try:
        price_store.connect = schedule.connect = fake_connect
        schedule.today_kst = lambda: date(2026, 9, 5)
        price_store.update_earnings_dates([("MSFT", "2026-09-10")])
        conn.execute("PRAGMA query_only = ON")
        before = conn.total_changes
        payload = schedule.load_schedule()
        assert [row["earnings_date"] for row in payload["earnings"]] == ["2026-06-10", "2026-09-10"]
        assert conn.total_changes == before and not conn.in_transaction
    finally:
        price_store.connect, schedule.connect, schedule.today_kst = originals
        conn.close()


if __name__ == "__main__":
    tests = [fn for name, fn in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print("PASS", test.__name__)
    print(f"{len(tests)}/{len(tests)} passed")

"""Transaction/holding/cash-flow/snapshot atomicity, using a temporary DB only."""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_core import cash_flows, db, performance_snapshots as snapshots, transactions


class AtomicWritesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "portfolio.db"
        db_path = patch.object(db, "DB_PATH", self.path)
        db_path.start()
        self.addCleanup(db_path.stop)
        with db.connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript("""
                CREATE TABLE accounts(id INTEGER PRIMARY KEY, member TEXT, name TEXT,
                    account_type TEXT, currency TEXT, history_start TEXT);
                CREATE TABLE holdings(id INTEGER PRIMARY KEY, account_id INTEGER, member TEXT,
                    ticker TEXT, name TEXT, qty REAL, avg_price REAL, invested REAL,
                    currency TEXT, notes TEXT, updated_at TEXT, UNIQUE(account_id, ticker));
                CREATE TABLE tickers(ticker TEXT PRIMARY KEY, name TEXT, region TEXT,
                    currency TEXT, added_date TEXT, category TEXT, display_name TEXT);
                CREATE TABLE transactions(id INTEGER PRIMARY KEY AUTOINCREMENT, trade_date TEXT,
                    created_at TEXT, member TEXT, account_id INTEGER, ticker TEXT, side TEXT,
                    qty REAL, price REAL, currency TEXT, note TEXT, apply_to_holdings INTEGER,
                    hidden INTEGER DEFAULT 0, entry_score REAL);
                CREATE TABLE daily_prices(ticker TEXT, date TEXT, open REAL, high REAL,
                    low REAL, close REAL, PRIMARY KEY(ticker, date));
                INSERT INTO accounts VALUES (1, 'A', 'One', 'overseas', 'USD', '2026-03-02');
                INSERT INTO accounts VALUES (2, 'B', 'Two', 'overseas', 'USD', '2026-03-02');
                INSERT INTO tickers VALUES ('MSFT', 'Microsoft', 'US', 'USD', '2026-03-02', 'overseas', 'Microsoft');
                INSERT INTO holdings VALUES (1, 1, 'A', 'MSFT', 'Microsoft', 10, 100, 1000, 'USD', '', 'old');
                INSERT INTO holdings VALUES (2, 2, 'B', 'MSFT', 'Microsoft', 3, 100, 300, 'USD', '', 'old');
                INSERT INTO transactions VALUES (1, '2026-03-02', 'old', 'A', 1, 'MSFT', 'BUY', 10, 100, 'USD', '', 1, 0, 1);
                INSERT INTO transactions VALUES (2, '2026-03-02', 'old', 'B', 2, 'MSFT', 'BUY', 3, 100, 'USD', '', 1, 0, 1);
            """)
            db.ensure_cash_flow_table(conn)
            db.ensure_value_snapshot_table(conn)
            conn.execute("INSERT INTO account_cash_flows VALUES (1, 1, '2026-03-02', 1000, 'USD', '', 'old')")
            for day, close, fx in [("2026-03-02", 100, 1300), ("2026-03-03", 110, 1400), ("2026-03-04", 120, 1500)]:
                conn.execute("INSERT INTO daily_prices VALUES ('MSFT', ?, ?, ?, ?, ?)", (day, close, close, close, close))
                conn.execute("INSERT INTO daily_prices VALUES ('USDKRW', ?, ?, ?, ?, ?)", (day, fx, fx, fx, fx))
        snapshots.rebuild_account_snapshots()

    def state(self):
        with db.connect() as conn:
            return {
                table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY 1, 2")]
                for table in ("holdings", "tickers", "transactions", "account_cash_flows",
                              "account_value_snapshots", "sqlite_sequence")
            }

    def add_trade(self, **changes):
        payload = {"account_id": 1, "ticker": "MSFT", "side": "BUY", "qty": 2,
                   "price": 110, "trade_date": "2026-03-03"}
        payload.update(changes)
        return transactions.add_transaction(payload, portfolio_loader=lambda: {})

    def snapshot_failure(self, account_id=1):
        # Fail after DELETE and the first successful INSERT, not before writing.
        with db.connect() as conn:
            conn.execute(f"""
                CREATE TRIGGER fail_snapshot BEFORE INSERT ON account_value_snapshots
                WHEN NEW.account_id = {int(account_id)} AND NEW.date = '2026-03-03'
                BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END
            """)

    def assert_consistent(self, account_id=1):
        with db.connect() as conn:
            expected = snapshots.build_account_series(conn, account_id)
            actual = [dict(row) for row in conn.execute("""
                SELECT date, holdings_value_krw, trade_cash_krw, flow_krw
                FROM account_value_snapshots WHERE account_id = ? ORDER BY date
            """, (account_id,))]
        self.assertEqual(actual, expected)
        return actual[-1]

    def test_all_mutations_roll_back_on_partial_snapshot_failure(self):
        self.snapshot_failure()
        before = self.state()
        actions = {
            "buy": lambda: self.add_trade(),
            "sell": lambda: self.add_trade(side="SELL"),
            "new holding and ticker": lambda: self.add_trade(ticker="NEW", name="New Company", currency="USD"),
            "history only": lambda: self.add_trade(apply_to_holdings=False),
            "update": lambda: transactions.update_transaction({"id": 1, "qty": 8}),
            "delete": lambda: transactions.delete_transaction({"id": 1}),
            "cash in": lambda: cash_flows.add_cash_flow({"account_id": 1, "flow_date": "2026-03-03", "amount": 50}),
            "cash out": lambda: cash_flows.add_cash_flow({"account_id": 1, "flow_date": "2026-03-03", "amount": -50}),
            "cash delete": lambda: cash_flows.delete_cash_flow({"id": 1}),
        }
        # Mutation paths must never open a separate snapshot connection.
        with patch.object(snapshots, "connect", side_effect=AssertionError("separate snapshot connection")):
            for name, action in actions.items():
                with self.subTest(action=name):
                    with self.assertRaisesRegex(sqlite3.IntegrityError, "injected snapshot failure"):
                        action()
                    self.assertEqual(self.state(), before)

    def test_buy_and_sell_commit_holdings_and_snapshots_together(self):
        before_other = [r for r in self.state()["account_value_snapshots"] if r[0] == 2]
        self.assertTrue(self.add_trade()["ok"])
        point = self.assert_consistent()
        self.assertEqual(point["holdings_value_krw"], 12 * 120 * 1500)
        self.assertEqual(point["trade_cash_krw"], -1000 * 1300 - 220 * 1400)
        self.assertTrue(self.add_trade(side="SELL", qty=1)["ok"])
        self.assertEqual(self.assert_consistent()["holdings_value_krw"], 11 * 120 * 1500)
        self.assertEqual([r for r in self.state()["account_value_snapshots"] if r[0] == 2], before_other)

    def test_edit_delete_and_history_only_preserve_holdings_contract(self):
        holdings = self.state()["holdings"]
        self.add_trade(apply_to_holdings=False)
        self.assertEqual(self.state()["holdings"], holdings)
        self.assert_consistent()
        transactions.update_transaction({"id": 1, "qty": 8, "price": 90, "hidden": 1})
        self.assertEqual(self.state()["holdings"], holdings)
        self.assertEqual(self.assert_consistent()["trade_cash_krw"], -720 * 1300 - 220 * 1400)
        transactions.delete_transaction({"id": 1})
        self.assertEqual(self.state()["holdings"], holdings)
        self.assertEqual(self.assert_consistent()["trade_cash_krw"], -220 * 1400)

    def test_cash_flow_changes_commit_with_snapshots(self):
        result = cash_flows.add_cash_flow({"account_id": 1, "flow_date": "2026-03-03", "amount": -50})
        self.assertEqual(self.assert_consistent()["flow_krw"], 1000 * 1300 - 50 * 1400)
        cash_flows.delete_cash_flow({"id": result["id"]})
        self.assertEqual(self.assert_consistent()["flow_krw"], 1000 * 1300)

    def test_standalone_rebuild_rolls_back_every_account_on_failure(self):
        self.snapshot_failure(account_id=2)
        before = self.state()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected snapshot failure"):
            snapshots.rebuild_account_snapshots()
        self.assertEqual(self.state(), before)

    def test_snapshot_helper_never_commits_callers_transaction(self):
        before = self.state()
        with db.connect() as conn:
            with self.assertRaisesRegex(ValueError, "활성 DB 트랜잭션"):
                snapshots.rebuild_account_snapshots_in_transaction(conn, [1])
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("UPDATE transactions SET qty = 8 WHERE id = 1")
            self.assertEqual(snapshots.rebuild_account_snapshots_in_transaction(conn, [1]), {1: 3})
            self.assertTrue(conn.in_transaction)
            self.assertEqual(self.state(), before)  # separate reader still sees the old pair
            conn.rollback()
        self.assertEqual(self.state(), before)

    def test_concurrent_buys_read_latest_committed_holding(self):
        first_paused = threading.Event()
        release_first = threading.Event()
        second_started = threading.Event()
        second_read = threading.Event()
        failures = []
        real_build = snapshots.build_account_series
        real_connect = transactions.connect
        real_holding = transactions.load_holding

        def build(conn, account_id):
            if threading.current_thread().name == "first":
                first_paused.set()
                if not release_first.wait(5):
                    raise TimeoutError("first writer was not released")
            return real_build(conn, account_id)

        @contextmanager
        def connect():
            with real_connect() as conn:
                if threading.current_thread().name == "second":
                    second_started.set()
                yield conn

        def holding(conn, account_id, ticker):
            if threading.current_thread().name == "second":
                second_read.set()
            return real_holding(conn, account_id, ticker)

        def buy():
            try:
                self.add_trade(qty=1)
            except Exception as exc:
                failures.append(exc)

        before = self.state()
        with patch.object(snapshots, "build_account_series", build), \
             patch.object(transactions, "connect", connect), \
             patch.object(transactions, "load_holding", holding):
            first = threading.Thread(target=buy, name="first")
            second = threading.Thread(target=buy, name="second")
            first.start()
            try:
                self.assertTrue(first_paused.wait(5))
                self.assertEqual(self.state(), before)  # no partial source write visible
                second.start()
                self.assertTrue(second_started.wait(5))
                self.assertFalse(second_read.wait(0.1))  # lock precedes reading the holding
            finally:
                release_first.set()
                first.join(5)
                if second.ident is not None:
                    second.join(5)
            self.assertFalse(first.is_alive() or second.is_alive())
        self.assertFalse(failures, failures)
        self.assertTrue(second_read.is_set())
        self.assertEqual(self.assert_consistent()["holdings_value_krw"], 12 * 120 * 1500)
        with db.connect() as conn:
            self.assertEqual(conn.execute("SELECT qty FROM holdings WHERE id = 1").fetchone()[0], 12)


if __name__ == "__main__":
    unittest.main(verbosity=2)

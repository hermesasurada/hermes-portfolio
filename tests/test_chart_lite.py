"""/api/chart?lite=1(2026-11-08): 시세 팝오버용 — 봉 배열 등 큰 키만 빼고 시세·quote_stats 모양은 그대로."""
import sqlite3
import sys
import unittest
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import portfolio_web_server as server  # noqa: E402
from portfolio_core import charts as charts_module  # noqa: E402
from portfolio_core import db as db_module  # noqa: E402
from portfolio_core import prices as prices_module  # noqa: E402


class ChartLiteTests(unittest.TestCase):
    def call(self, query):
        payload = {"ticker": "MU", "name": "Micron", "current_price": 1.0, "points": [1, 2],
                   "ichimoku_projection": {"a": 1}, "transactions": []}
        handler = server.Handler.__new__(server.Handler)
        with mock.patch.object(server, "load_price_chart", return_value=payload), \
             mock.patch.object(server, "compact_chart_payload", side_effect=lambda p: p), \
             mock.patch.object(server, "etf_holdings_available", return_value=False), \
             mock.patch.object(server, "company_events_summary", return_value=None), \
             mock.patch.object(server, "load_quote_stats", return_value={"rsi": None}):
            return handler.api_chart(query)

    def test_lite_drops_heavy_keys_only(self):
        got = self.call({"ticker": ["MU"], "lite": ["1"]})
        for key in server.CHART_LITE_DROP_KEYS:
            self.assertNotIn(key, got)
        self.assertEqual(got["current_price"], 1.0)
        self.assertEqual(got["quote_stats"], {"rsi": None})

    def test_default_keeps_points(self):
        self.assertIn("points", self.call({"ticker": ["MU"]}))


class LitePayloadMatchesFullTests(unittest.TestCase):
    """lite는 봉·지표 계산을 건너뛰지만 남는 필드 값은 전체 경로와 같아야 한다(소비처 여섯 곳)."""

    def setUp(self):
        schema = (Path(charts_module.__file__).parent / "schema.sql").read_text(encoding="utf-8")
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(schema)
        db_module.ensure_daily_prices_table(self.conn)
        db_module.ensure_price_indexes(self.conn)
        self.conn.execute("INSERT INTO tickers (ticker, name, region, currency) VALUES ('AAA', 'Alpha', 'US', 'USD')")
        start = date(2026, 1, 5)
        self.conn.executemany(
            "INSERT INTO daily_prices (ticker, date, open, high, low, close, volume) VALUES ('AAA', ?, 10, 11, 9, ?, 1)",
            [((start + timedelta(days=i)).isoformat(), 10 + i * 0.1) for i in range(60)],
        )
        self.conn.execute("INSERT INTO transactions (trade_date, ticker, side, qty, price) VALUES ('2026-01-10', 'AAA', 'BUY', 1, 10)")

    def tearDown(self):
        self.conn.close()

    def load(self, live_price, lite):
        conn = self.conn

        @contextmanager
        def fake_connect():
            yield conn

        def fake_live(prices, ticker_rows, include_extended, status):
            if live_price is not None:
                prices["AAA"] = {**prices.get("AAA", {}), "price": live_price, "date": "2099-01-01", "source": "yf-live"}
            return {"use_live": live_price is not None}

        status = {"is_regular": True, "is_closed": False, "use_live": live_price is not None}
        with mock.patch.object(charts_module, "connect", fake_connect), \
             mock.patch.object(charts_module, "us_market_status", return_value=status), \
             mock.patch.object(prices_module, "apply_us_live_prices", side_effect=fake_live), \
             mock.patch.object(prices_module, "apply_kr_live_prices", return_value={}):
            return charts_module.load_price_chart("AAA", range_key="6m", lite=lite)

    def assert_lite_matches(self, live_price):
        full = self.load(live_price, lite=False)
        lite = self.load(live_price, lite=True)
        for key in server.CHART_LITE_DROP_KEYS:
            self.assertNotIn(key, lite)
            full.pop(key)
        self.assertEqual(lite, full)
        return lite

    def test_without_live_price(self):
        self.assertEqual(self.assert_lite_matches(None)["history_end"], "2026-03-05")

    def test_with_live_point(self):
        lite = self.assert_lite_matches(99.0)
        self.assertGreater(lite["history_end"], "2026-03-05")

    def test_live_price_equal_to_last_close_adds_no_point(self):
        last_close = self.conn.execute("SELECT close FROM daily_prices ORDER BY date DESC LIMIT 1").fetchone()[0]
        self.assertEqual(self.assert_lite_matches(last_close)["history_end"], "2026-03-05")


if __name__ == "__main__":
    unittest.main()

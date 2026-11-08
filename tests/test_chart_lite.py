"""/api/chart?lite=1(2026-11-08): 시세 팝오버용 — 봉 배열 등 큰 키만 빼고 시세·quote_stats 모양은 그대로."""
import unittest
from unittest import mock

import portfolio_web_server as server


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


if __name__ == "__main__":
    unittest.main()

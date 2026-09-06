"""Daily SMA overlays, window trimming and live-session regression checks."""
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from portfolio_core.charts import (
    _chart_overlay_series, _append_market_chart_point, price_chart_points_for_range,
)
from portfolio_core.paths import US_EASTERN


def history(count=250, end=None):
    end = end or datetime.now(US_EASTERN).date()
    return [dict(date=(end - timedelta(days=count - 1 - i)).isoformat(),
                 open=i + 1, high=i + 2, low=i + .5, close=i + 1)
            for i in range(count)]


class MovingAverageTests(unittest.TestCase):
    def test_complete_windows_only_and_exact_values(self):
        rows = history()
        overlays = _chart_overlay_series(rows)
        for period in (20, 50, 200):
            key = f"sma_{period}"
            self.assertNotIn(key, overlays[rows[period - 2]['date']])
            self.assertAlmostEqual(overlays[rows[period - 1]['date']][key], (period + 1) / 2)
            self.assertAlmostEqual(overlays[rows[-1]['date']][key], (501 - period) / 2)
        self.assertAlmostEqual(overlays[rows[-1]['date']]['sma_20'], overlays[rows[-1]['date']]['bb_mid'])

    def test_range_does_not_reset_average_or_leak_future_prices(self):
        rows = history()
        overlay = _chart_overlay_series(rows)
        points = [dict(row, **overlay[row['date']]) for row in rows]
        trimmed, _, _ = price_chart_points_for_range(points, '1m')
        self.assertLess(len(trimmed), 50)
        self.assertIn('sma_200', trimmed[0])
        prefix = _chart_overlay_series(rows[:220])
        self.assertEqual(prefix[rows[219]['date']], overlay[rows[219]['date']])

    def test_live_replaces_last_sample_and_preserves_regular_candle(self):
        rows = history()
        overlay = _chart_overlay_series(rows)
        points = [dict(row, **overlay[row['date']]) for row in rows]
        _append_market_chart_point({'price': 270}, {'use_live': True, 'include_extended': True}, points, rows, entry_scoring=False)
        self.assertEqual(len(points), 250)
        self.assertEqual(points[-1]['candle_close'], 250)
        for period in (20, 50, 200):
            self.assertAlmostEqual(points[-1][f'sma_{period}'], overlay[rows[-1]['date']][f'sma_{period}'] + 20 / period)

    def test_new_session_appends_one_daily_sample(self):
        rows = history(end=datetime.now(US_EASTERN).date() - timedelta(days=1))
        points = [dict(row) for row in rows]
        _append_market_chart_point({'price': 251}, {'use_live': True}, points, rows, entry_scoring=False)
        self.assertEqual(len(points), 251)
        self.assertAlmostEqual(points[-1]['sma_200'], 151.5)

    def test_disabled_live_does_not_change_points(self):
        rows = history()
        points = [dict(row) for row in rows]
        _append_market_chart_point({'price': 500}, {'use_live': False}, points, rows, entry_scoring=False)
        self.assertEqual(points, rows)


if __name__ == '__main__':
    unittest.main()

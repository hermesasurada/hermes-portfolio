"""Interval Ichimoku: exact windows, displacement and no future leakage."""
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from portfolio_core.charts import (
    _chart_interval_ichimoku_series, _chart_overlay_series, price_chart_points_for_range,
)


def bars(interval, count=85):
    start = date(2018, 1, 1)
    result = []
    for i in range(count):
        day = (date(2018 + i // 12, i % 12 + 1, 1) if interval == 'month'
               else start + timedelta(weeks=i))
        result.append(dict(date=day.isoformat(), close=100 + i, high=102 + i, low=98 + i))
    return result


class IchimokuTests(unittest.TestCase):
    def test_future_projection_is_26_bars_without_future_prices(self):
        for interval in ('day', 'week', 'month'):
            rows = bars('month' if interval == 'month' else 'week')
            if interval == 'day':
                rows = [dict(row, date=(date(2020, 1, 1) + timedelta(days=i)).isoformat()) for i, row in enumerate(rows)]
            projection = []
            _chart_interval_ichimoku_series(rows, interval, projection)
            self.assertEqual(len(projection), 26)
            # Last observed index 84. First future span uses raw index 59; last uses 84.
            self.assertEqual(projection[0]['ichi_span_b'], 133.5)
            self.assertEqual(projection[-1]['ichi_span_b'], 158.5)
            self.assertEqual(projection[-1]['ichi_span_a'], 175.75)
            self.assertNotIn('close', projection[-1])

    def test_short_projection_keeps_missing_windows_absent(self):
        projection = []
        _chart_interval_ichimoku_series(bars('week', 26), 'week', projection)
        self.assertEqual(len(projection), 26)
        self.assertEqual(projection[0], {})
        self.assertIn('ichi_span_a', projection[-1])
        self.assertNotIn('ichi_span_b', projection[-1])

    def test_exact_windows_and_displacement(self):
        for interval in ('week', 'month'):
            rows = bars(interval)
            actual = _chart_interval_ichimoku_series(rows, interval)
            at = lambda i: actual[rows[i]['date']]
            key = lambda suffix: f'ichi_{interval}_{suffix}'
            self.assertNotIn(key('tenkan'), at(7))
            self.assertEqual(at(8)[key('tenkan')], 104)
            self.assertNotIn(key('kijun'), at(24))
            self.assertEqual(at(25)[key('kijun')], 112.5)
            self.assertNotIn(key('span_a'), at(50))
            self.assertEqual(at(51)[key('span_a')], 116.75)
            self.assertNotIn(key('span_b'), at(76))
            self.assertEqual(at(77)[key('span_b')], 125.5)
            # Daily implementation shares the same convention on one point/bar.
            daily = _chart_overlay_series(rows)
            for row in rows:
                for suffix in ('tenkan', 'kijun', 'span_a', 'span_b'):
                    self.assertEqual(actual[row['date']].get(key(suffix)),
                                     daily[row['date']].get(f'ichi_{suffix}'))

    def test_running_bar_high_low_and_no_future_leakage(self):
        for interval in ('week', 'month'):
            rows = bars(interval)
            last_day = date.fromisoformat(rows[-1]['date'])
            extended = rows + [dict(date=(last_day + timedelta(days=1)).isoformat(),
                                   close=300, high=310, low=90)]
            before = _chart_interval_ichimoku_series(rows, interval)
            after = _chart_interval_ichimoku_series(extended, interval)
            self.assertEqual(before[rows[-1]['date']], after[rows[-1]['date']])
            self.assertEqual(after[extended[-1]['date']][f'ichi_{interval}_tenkan'], 200)
            # New daily sample updates current bar, not the 26-bar cloud shift.
            for suffix in ('span_a', 'span_b'):
                self.assertEqual(after[extended[-1]['date']][f'ichi_{interval}_{suffix}'],
                                 before[rows[-1]['date']][f'ichi_{interval}_{suffix}'])

    def test_range_trim_preserves_warmup(self):
        rows = bars('week')
        overlay = _chart_interval_ichimoku_series(rows, 'week')
        points = [dict(row, **overlay[row['date']]) for row in rows]
        trimmed, _, _ = price_chart_points_for_range(points, '1m')
        self.assertLess(len(trimmed), 9)
        self.assertIn('ichi_week_span_b', trimmed[0])

    def test_year_boundary_and_close_only_live_point(self):
        rows = bars('week')
        rows[-1].pop('high')
        rows[-1].pop('low')
        result = _chart_interval_ichimoku_series(rows, 'week')
        self.assertIn('ichi_week_span_b', result[rows[-1]['date']])
        # Monday 2018-12-31 and Tuesday 2019-01-01 belong to the same week.
        rows = bars('week', 53)
        rows.append(dict(date='2019-01-01', close=300))
        result = _chart_interval_ichimoku_series(rows, 'week')
        self.assertEqual(result['2019-01-01']['ichi_week_span_a'],
                         result['2018-12-31']['ichi_week_span_a'])


if __name__ == '__main__':
    unittest.main()

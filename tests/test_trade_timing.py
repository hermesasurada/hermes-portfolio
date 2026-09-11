"""Unvalidated reference rules: deterministic boundaries, no price/session leakage."""
import copy
import sqlite3
import sys
import unittest
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from portfolio_core.trade_timing import calculate_trade_timing
from portfolio_core.technical_stats import calculate_technical_stats, calculate_price_adjusted_indicators


def history(count=250):
    return [dict(date=(date(2025, 1, 1) + timedelta(days=i)).isoformat(),
                 close=80+i*.1, high=81+i*.1, low=79+i*.1) for i in range(count)]


def fixed_atr(rows):
    with patch('portfolio_core.trade_timing.atr_percent', return_value=200/rows[-2]['close']):
        return calculate_trade_timing(rows)


def buy_history():
    rows = history()
    rows[-2].update(close=101, high=102, low=100)
    rows[-15]['high'] = 125
    return rows


class TimingTests(unittest.TestCase):
    def test_buy_exact_price_levels_and_prior_anchors(self):
        rows = buy_history()
        rows[-1].update(high=10000, low=.01)
        before = copy.deepcopy(rows)
        r = fixed_atr(rows)
        self.assertEqual(r['state'], 'buy')
        self.assertTrue(r['trend'] and r['rebound'])
        self.assertEqual(r['upper'], 125)
        self.assertEqual(r['lower'], 99)
        self.assertAlmostEqual(r['buy_r'], (125-104.9)/(104.9-99), places=4)
        self.assertEqual(rows, before)

    def test_buy_ratio_boundaries_are_not_rounded_before_decision(self):
        for ratio, state in [(.99, 'wait'), (1, 'watch'), (1.49, 'watch'), (1.5, 'buy'), (2, 'buy')]:
            rows = buy_history()
            p = rows[-1]['close']
            rows[-15]['high'] = p + (p-99)*(ratio + 1e-10)
            self.assertEqual(fixed_atr(rows)['state'], state)

    def test_short_history_and_invalid_ohlc_atr_are_absent(self):
        self.assertIsNone(calculate_trade_timing(history(54)))
        self.assertIsNotNone(calculate_trade_timing(history(55)))
        for key, value in [('high', None), ('low', 0), ('close', float('nan')), ('high', .1)]:
            rows = history(); rows[-2][key] = value
            self.assertIsNone(calculate_trade_timing(rows))
        with patch('portfolio_core.trade_timing.atr_percent', return_value=0):
            self.assertIsNone(calculate_trade_timing(history()))

    def test_optional_200_day_filter(self):
        rows = buy_history()
        for row in rows[:100]:
            row.update(close=200, high=201, low=199)
        self.assertFalse(fixed_atr(rows)['trend'])
        shorter = fixed_atr(rows[100:])
        self.assertIsNone(shorter['ma200'])
        self.assertEqual(shorter['state'], 'buy')

    def test_high_ratio_without_rebound_is_wait(self):
        rows = history(); rows[-15]['high'] = 150
        self.assertEqual(fixed_atr(rows)['state'], 'wait')

    def test_breakout_is_not_zero_or_sell(self):
        rows = buy_history(); rows[-1]['close'] = 130
        r = fixed_atr(rows)
        self.assertEqual(r['state'], 'breakout')
        self.assertIsNone(r['buy_r'])
        self.assertEqual(r['sell_atr'], 0)

    def test_sell_requires_both_price_breaks(self):
        rows = history(); rows[-1]['close'] = 95
        self.assertEqual(fixed_atr(rows)['state'], 'sell')
        rows[-2]['low'] = 90  # No break below prior low.
        self.assertEqual(fixed_atr(rows)['state'], 'caution')
        rows = history(); rows[-15]['high'] = 130  # Off a high, but still above SMA20.
        self.assertEqual(fixed_atr(rows)['state'], 'wait')

    def test_caution_two_atr(self):
        rows = history(); rows[-1]['close'] = max(r['high'] for r in rows[-21:-1])-4.1
        self.assertEqual(fixed_atr(rows)['state'], 'caution')

    def test_live_same_date_uses_same_prior_levels(self):
        rows = buy_history(); before = copy.deepcopy(rows)
        regular = calculate_technical_stats(rows)['trade_timing']
        live = calculate_price_adjusted_indicators(rows, 95, rows[-1]['date'])['trade_timing']
        self.assertEqual(live['upper'], regular['upper'])
        self.assertEqual(live['atr'], regular['atr'])
        self.assertEqual(live['price'], 95)
        self.assertTrue(live['provisional'])
        self.assertEqual(rows, before)

    def test_next_session_anchors_include_last_completed_bar(self):
        rows = history(); rows[-1]['high'] = 130
        next_date = (date.fromisoformat(rows[-1]['date'])+timedelta(days=1)).isoformat()
        live = calculate_price_adjusted_indicators(rows, 105, next_date)['trade_timing']
        self.assertEqual(live['upper'], 130)
        self.assertEqual(live['as_of'], next_date)

    def test_stats_modes_and_excluded_assets(self):
        import portfolio_core.stats as api
        from portfolio_core.entry_reward import entry_risk_reward_score
        rows = buy_history()
        cache = calculate_technical_stats(rows)
        conn = sqlite3.connect(':memory:'); conn.row_factory = sqlite3.Row
        conn.executescript('''CREATE TABLE tickers(ticker TEXT,name TEXT,display_name TEXT,currency TEXT,category TEXT);
            CREATE TABLE daily_prices(ticker TEXT,date TEXT,close REAL,high REAL,low REAL);''')
        conn.executemany('INSERT INTO tickers VALUES (?,?,?,?,?)', [
            ('TEST','Test Inc',None,'USD','overseas'), ('LEV','2x Leveraged ETF',None,'USD','overseas'),
            ('IDX','Index',None,'USD','index'), ('FX','FX',None,'USD','fx')])
        conn.executemany('INSERT INTO daily_prices VALUES (?,?,?,?,?)', [
            ('TEST', r['date'], r['close'], r['high'], r['low']) for r in rows])
        @contextmanager
        def connection():
            yield conn
        try:
            with patch.object(api, 'connect', connection), \
                 patch.object(api, 'load_technical_stats_cache', side_effect=lambda c, ts: {t: copy.deepcopy(cache) for t in ts}), \
                 patch.object(api, 'fetch_fundamentals', return_value={}), \
                 patch.object(api, 'us_market_status', return_value={'is_regular':False,'is_closed':False}), \
                 patch.object(api, 'latest_prices', return_value={}), \
                 patch.object(api, 'build_market_snapshot', return_value={'market_status':{'include_extended':True}, 'prices':{
                     'TEST':{'price':95,'extended_price':95,'date':rows[-1]['date']}}}):
                regular = api.load_stats(['TEST','LEV','IDX','FX'])['stats']
                for t in ['LEV','IDX','FX']:
                    self.assertIsNone(regular[t]['trade_timing'])
                expected = entry_risk_reward_score(cache['bb_upper_pct'],cache['atr_pct'],cache['rsi']['day'],cache['rsi']['week'],cache['ma50_pct'],cache['bb_upper_week_pct'],cache['ma200_pct'])
                self.assertEqual(regular['TEST']['entry_risk_reward'], expected)
                live = api.load_stats(['TEST'], us_extended=True)['stats']['TEST']['trade_timing']
                self.assertEqual(live['price'],95)
                self.assertEqual(live['upper'],regular['TEST']['trade_timing']['upper'])
                self.assertTrue(live['provisional'])
        finally:
            conn.close()


if __name__ == '__main__':
    unittest.main()

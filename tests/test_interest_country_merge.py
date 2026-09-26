import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portfolio_core.db import ensure_interest_watchlist_tables
from portfolio_core.interest_watchlists import merge_country_interest_groups, initial_group_name, watchlist_asset_types


class CountryMergeTests(unittest.TestCase):
    def test_merge_preserves_membership_order_aliases_and_is_idempotent(self):
        with sqlite3.connect(':memory:') as conn:
            conn.row_factory = sqlite3.Row
            ensure_interest_watchlist_tables(conn)
            groups = [(1, '미국 ETF', 10), (2, '미국 개별주', 20), (3, '찐관심', 30), (4, '일본 종목', 40)]
            conn.executemany('INSERT INTO interest_watchlist_groups VALUES (?, ?, ?, "date")', groups)
            conn.executemany('INSERT INTO interest_watchlist_items VALUES (?, ?, ?, "date")',
                             [(1, 'GLD', 10), (1, 'DUP', 20), (2, 'MSFT', 10), (2, 'DUP', 20), (3, 'GLD', 10), (4, 'TEST.T', 10)])
            result = merge_country_interest_groups(conn)
            self.assertEqual(result['aliases'], {'2': 1})
            self.assertEqual(result['asset_types']['GLD'], 'etf')
            self.assertEqual(watchlist_asset_types(result)['MSFT'], 'stock')
            self.assertEqual(watchlist_asset_types(result)['DUP'], 'etf')
            self.assertEqual(len(result['original_items']), 5)
            self.assertEqual([r['ticker'] for r in conn.execute('SELECT ticker FROM interest_watchlist_items WHERE group_id=1 ORDER BY sort_order')], ['GLD', 'DUP', 'MSFT'])
            self.assertEqual(conn.execute('SELECT count(*) FROM interest_watchlist_items WHERE group_id=3').fetchone()[0], 1)
            self.assertEqual([r['name'] for r in conn.execute('SELECT name FROM interest_watchlist_groups ORDER BY sort_order')], ['미국', '찐관심', '일본'])
            before = conn.total_changes
            self.assertEqual(merge_country_interest_groups(conn), result)
            self.assertEqual(conn.total_changes, before)

    def test_new_country_defaults_are_combined(self):
        self.assertEqual(initial_group_name('AAPL', 'Apple', 'us', 'USD'), '미국')
        self.assertEqual(initial_group_name('SPY', 'ETF', 'us', 'USD'), '미국')
        self.assertEqual(initial_group_name('005930.KS', '삼성전자', 'kr', 'KRW'), '한국')
        self.assertEqual(initial_group_name('1306.T', 'ETF', 'jp', 'JPY'), '일본')


if __name__ == '__main__':
    unittest.main()

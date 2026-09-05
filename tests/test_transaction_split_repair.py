"""Offline regression tests for the reviewed historical split-unit repair."""
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from scripts import repair_transaction_split_units as repair


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.conn=sqlite3.connect(":memory:")
        self.conn.row_factory=sqlite3.Row
        self.addCleanup(self.conn.close)
        series = patch.object(repair,'build_account_series',return_value=[])
        series.start()
        self.addCleanup(series.stop)
        self.conn.executescript("""
            CREATE TABLE transactions(id INTEGER PRIMARY KEY,account_id INTEGER,ticker TEXT,
                trade_date TEXT,side TEXT,qty REAL,price REAL,currency TEXT);
            CREATE TABLE holdings(account_id INTEGER,ticker TEXT,qty REAL);
            CREATE TABLE daily_prices(ticker TEXT,date TEXT,close REAL);
            CREATE TABLE stock_splits(ticker TEXT,split_date TEXT,ratio REAL);
            CREATE TABLE account_value_snapshots(account_id INTEGER,date TEXT,holdings_value_krw REAL,
                trade_cash_krw REAL,flow_krw REAL);
            INSERT INTO daily_prices VALUES('LCID','2021-11-17',500),('LCID','2026-09-04',5);
            INSERT INTO daily_prices VALUES('TQQQ','2021-11-17',40),('TQQQ','2026-09-04',50);
            INSERT INTO stock_splits VALUES('LCID','2025-09-02',0.1);
            INSERT INTO stock_splits VALUES('TQQQ','2022-01-13',2),('TQQQ','2025-11-20',2);
            INSERT INTO transactions VALUES(1,1,'LCID','2021-11-17','BUY',10,50,'USD');
            INSERT INTO transactions VALUES(2,1,'LCID','2021-11-17','SELL',10,51,'USD');
            INSERT INTO transactions VALUES(3,4,'TQQQ','2021-11-17','BUY',4,40,'USD');
            INSERT INTO transactions VALUES(4,4,'TQQQ','2021-11-17','SELL',4,41,'USD');
        """)

    def rows(self):
        return [tuple(r) for r in self.conn.execute('SELECT * FROM transactions ORDER BY id')]

    def test_amount_preserved_and_rerun_is_noop(self):
        before=self.rows()
        plan=repair.plan_repairs(self.conn)
        self.assertEqual([r['before']['id'] for r in plan['changes']],[1,2])
        self.assertEqual(plan['aligned_ids'],[3,4])
        with patch.object(repair,'rebuild_account_snapshots_in_transaction',return_value={1:1}) as rebuild:
            with self.conn:
                self.conn.execute('BEGIN IMMEDIATE')
                repair.apply_repairs(self.conn,plan)
            rebuild.assert_called_once_with(self.conn,[1])
        after=self.rows()
        for old,new in zip(before,after):
            self.assertAlmostEqual(old[5]*old[6],new[5]*new[6])
        self.assertEqual(after[2:],before[2:])
        self.assertEqual(after[0][5:7],(1,500))
        self.assertEqual(repair.plan_repairs(self.conn)['changes'],[])

    def test_cumulative_splits_exclude_future_events(self):
        self.conn.execute("UPDATE transactions SET price=price*4 WHERE ticker='TQQQ'")
        self.conn.execute("INSERT INTO stock_splits VALUES('TQQQ','2027-01-01',10)")
        self.conn.commit()
        rows=[r for r in repair.plan_repairs(self.conn)['changes'] if r['before']['ticker']=='TQQQ']
        self.assertEqual(len(rows),2)
        self.assertTrue(all(float(r['factor'])==4 for r in rows))
        self.assertEqual(rows[0]['qty'],16)
        self.assertEqual(rows[0]['price'],40)

    def test_ambiguous_units_abort_without_writing(self):
        self.conn.execute('UPDATE transactions SET price=130 WHERE id=1')
        self.conn.commit()
        before=self.rows()
        with self.assertRaisesRegex(ValueError,'Unresolved'),self.conn:
            self.conn.execute('BEGIN IMMEDIATE')
            repair.apply_repairs(self.conn,repair.plan_repairs(self.conn))
        self.assertEqual(self.rows(),before)

    def test_partial_conversion_or_open_position_is_rejected(self):
        self.conn.execute('UPDATE transactions SET price=500 WHERE id=2')
        self.conn.commit()
        before=self.rows()
        with self.assertRaisesRegex(ValueError,'Unbalanced/open'),self.conn:
            self.conn.execute('BEGIN IMMEDIATE')
            repair.apply_repairs(self.conn,repair.plan_repairs(self.conn))
        self.assertEqual(self.rows(),before)

    def test_snapshot_failure_rolls_back_all_edits(self):
        before=self.rows()
        with patch.object(repair,'rebuild_account_snapshots_in_transaction',side_effect=RuntimeError('snapshot failed')):
            with self.assertRaisesRegex(RuntimeError,'snapshot failed'),self.conn:
                self.conn.execute('BEGIN IMMEDIATE')
                repair.apply_repairs(self.conn,repair.plan_repairs(self.conn))
        self.assertEqual(self.rows(),before)

    def test_changed_row_aborts_reviewed_plan(self):
        plan=repair.plan_repairs(self.conn)
        self.conn.execute('UPDATE transactions SET price=52 WHERE id=2')
        self.conn.commit()
        before=self.rows()
        with self.assertRaisesRegex(ValueError,'changed since review'),self.conn:
            self.conn.execute('BEGIN IMMEDIATE')
            repair.apply_repairs(self.conn,plan)
        self.assertEqual(self.rows(),before)

    def test_snapshot_cash_invariant_failure_rolls_back(self):
        before=self.rows()
        expected=[{'date':'2026-09-04','holdings_value_krw':0,'trade_cash_krw':10,'flow_krw':0}]
        def bad_rebuild(conn,accounts):
            conn.execute("INSERT INTO account_value_snapshots VALUES(1,'2026-09-04',0,11,0)")
            return {1:1}
        with patch.object(repair,'build_account_series',return_value=expected),patch.object(repair,'rebuild_account_snapshots_in_transaction',side_effect=bad_rebuild):
            with self.assertRaisesRegex(ValueError,'Snapshot cash changed'),self.conn:
                self.conn.execute('BEGIN IMMEDIATE')
                repair.apply_repairs(self.conn,repair.plan_repairs(self.conn))
        self.assertEqual(self.rows(),before)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM account_value_snapshots').fetchone()[0],0)


if __name__=='__main__':
    unittest.main(verbosity=2)

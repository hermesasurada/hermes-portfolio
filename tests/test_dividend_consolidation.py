"""배당 탭·일정의 같은 달 병합(2026-11-11 사용자 지시: 특별·정기 분리).

예전엔 (종목, 연, 월)마다 한 건만 남겨 같은 달의 두 번째 지급(정기+특별, 월 2회 분배, 연말 추가 분배)을
버렸고, 거꾸로 같은 배당의 교차통화 사본이 다른 달로 갈라지면 두 번 잡았다."""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_core.dividend_schedule import consolidated_dividend_events  # noqa: E402


def row(ticker, ex_date, pay_date, amount, source, currency="USD", record_date=None):
    return {"ticker": ticker, "ex_date": ex_date, "pay_date": pay_date, "amount": amount, "currency": currency,
            "source": source, "fetched_at": None, "record_date": record_date, "declaration_date": None}


def amounts(events, ticker):
    return sorted(round(float(e["amount"]), 4) for e in events if e["ticker"] == ticker)


class ConsolidationTests(unittest.TestCase):
    def test_special_and_regular_in_same_month_stay_separate(self):
        events = consolidated_dividend_events([
            row("COST", "2026-08-01", "2026-08-15", 0.5, "polygon"),
            row("COST", "2026-08-03", "2026-08-17", 15.0, "polygon"),
            row("COST", "2026-08-01", "2026-08-15", 0.5, "yf-history"),   # 다른 출처의 같은 정기배당
        ], [])
        self.assertEqual(amounts(events, "COST"), [0.5, 15.0])

    def test_one_source_with_both_and_another_with_regular_only(self):
        events = consolidated_dividend_events([
            row("COST", "2026-08-01", "2026-08-15", 0.5, "polygon"),
            row("COST", "2026-08-03", "2026-08-17", 15.0, "polygon"),
            row("COST", "2026-08-02", None, 0.52, "nasdaq"),             # 금액이 조금 달라도 가까운 정기배당에 붙는다
        ], [])
        cost = amounts(events, "COST")
        self.assertEqual(len(cost), 2)
        self.assertIn(15.0, cost)

    def test_two_monthly_payments_in_one_month(self):
        events = consolidated_dividend_events([
            row("SGOV", "2025-12-01", "2025-12-04", 0.3129, "polygon"),
            row("SGOV", "2025-12-19", "2025-12-24", 0.3230, "polygon"),
        ], [])
        self.assertEqual(amounts(events, "SGOV"), [0.3129, 0.323])

    def test_cross_source_duplicates_still_merge(self):
        events = consolidated_dividend_events([
            row("KO", "2026-09-15", "2026-10-01", 0.51, "polygon"),
            row("KO", "2026-09-15", "2026-10-01", 0.51, "yf-history"),
            row("KO", "2026-09-15", "2026-10-01", 0.512, "stockanalysis"),
        ], [])
        self.assertEqual(len([e for e in events if e["ticker"] == "KO"]), 1)

    def test_cross_currency_copy_in_another_month_is_not_double_counted(self):
        events = consolidated_dividend_events([
            row("RACE", "2026-04-20", None, 4.254, "yf-history"),
            row("RACE", "2026-04-21", "2026-05-05", 3.615, "polygon", currency="EUR", record_date="2026-04-21"),
        ], [])
        race = [e for e in events if e["ticker"] == "RACE"]
        self.assertEqual(len(race), 1)
        self.assertEqual(race[0]["pay_date"], "2026-05-05")   # 지급일이 있는 행을 남긴다

    def test_same_source_copy_with_same_pay_date_merges(self):
        events = consolidated_dividend_events([
            row("1489.T", "2024-10-04", "2024-11-15", 38.0, "yf-history", currency="JPY"),
            row("1489.T", "2024-10-07", "2024-11-15", 38.0, "yf-history", currency="JPY"),
        ], [])
        self.assertEqual(amounts(events, "1489.T"), [38.0])

    def test_tickers_never_merge_with_each_other(self):
        events = consolidated_dividend_events([
            row("AAA", "2026-03-02", "2026-03-10", 1.0, "polygon"),
            row("BBB", "2026-03-02", "2026-03-10", 1.0, "yf-history"),
        ], [])
        self.assertEqual(sorted(e["ticker"] for e in events), ["AAA", "BBB"])

    def test_accepts_sqlite_rows_without_record_date(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE d (ticker, ex_date, pay_date, amount, currency, source, fetched_at)")
        conn.executemany("INSERT INTO d VALUES (?, ?, ?, ?, 'USD', 'polygon', NULL)", [
            ("BITO", "2025-12-01", "2025-12-05", 0.7759),
            ("BITO", "2025-12-24", "2025-12-31", 0.7432),
        ])
        events = consolidated_dividend_events(conn.execute("SELECT * FROM d").fetchall(), [])
        self.assertEqual(amounts(events, "BITO"), [0.7432, 0.7759])
        self.assertTrue(all("_sources" not in e for e in events))


if __name__ == "__main__":
    unittest.main()

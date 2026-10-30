"""2026-10-30 무결성 점검 후속 수정 — 수집·가공 단계의 재발 방지 테스트."""
import io
import sqlite3
import sys
import unittest
import zipfile
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portfolio_core import dividend_sources as ds
from portfolio_core import opendart_dividends as od
from portfolio_core import technical_stats as technical
from portfolio_core.corporate_actions import dedupe_split_rows, is_spinoff_factor, split_adjusted_amount
from portfolio_core.dividend_history import _attributed_history_events, _dividend_frequency


def row(ex_date, amount, source="yf-history"):
    return {"ex_date": ex_date, "record_date": None, "pay_date": None, "declaration_date": None,
            "amount": amount, "source": source}


class OpendartSubsidiaryTests(unittest.TestCase):
    def test_subsidiary_filings_are_not_own_dividends(self):
        self.assertTrue(od.is_own_dividend_filing("현금ㆍ현물배당결정"))
        self.assertTrue(od.is_own_dividend_filing("[기재정정]현금ㆍ현물배당결정"))
        self.assertFalse(od.is_own_dividend_filing("현금ㆍ현물배당결정(자회사의 주요경영사항)"))
        self.assertFalse(od.is_own_dividend_filing("현금ㆍ현물배당결정(종속회사의 주요경영사항)"))
        self.assertFalse(od.is_own_dividend_filing("현금ㆍ현물배당을위한주주명부폐쇄(기준일)결정"))

    def test_ex_date_skips_korean_holidays(self):
        self.assertEqual(od._prev_business_day(date(2025, 8, 18)), date(2025, 8, 14))   # 8/15 광복절, 주말
        self.assertEqual(od._prev_business_day(date(2026, 8, 18)), date(2026, 8, 14))   # 8/17 대체휴일
        self.assertEqual(od._prev_business_day(date(2026, 3, 27)), date(2026, 3, 26))


class SplitHandlingTests(unittest.TestCase):
    def test_duplicate_yahoo_splits_collapse_to_one(self):
        self.assertEqual(dedupe_split_rows([("2026-03-05", 0.1), ("2026-03-10", 0.1)]), [("2026-03-05", 0.1)])
        self.assertEqual(dedupe_split_rows([("2023-08-09", 0.2), ("2023-08-15", 0.2), ("2024-04-03", 0.2)]),
                         [("2023-08-09", 0.2), ("2024-04-03", 0.2)])
        self.assertEqual(len(dedupe_split_rows([("2024-06-10", 10.0), ("2024-06-12", 2.0)])), 2)

    def test_spinoff_factors_are_recognised(self):
        for ratio in (1.253, 1.196, 1.241, 1.323, 1.128, 1.061, 0.9535, 1.067, 1.054, 0.841799, 0.90028, 3.03681):
            self.assertTrue(is_spinoff_factor(ratio), ratio)
        for ratio in (2.0, 3.0, 10.0, 25.0, 100.0, 1.5, 1.25, 1.2, 1.15, 1.1, 0.1, 0.2, 0.25, 1 / 3, 4 / 3, 0.04):
            self.assertFalse(is_spinoff_factor(ratio), ratio)

    def test_display_adjustment_ignores_spinoff_but_keeps_real_splits(self):
        splits = [{"split_date": "2024-04-02", "ratio": 1.253, "source": "yfinance"},
                  {"split_date": "2025-01-10", "ratio": 2.0, "source": "yfinance"}]
        total, _ = split_adjusted_amount(0.32, date(2023, 6, 1), "polygon", splits)
        shown, _ = split_adjusted_amount(0.32, date(2023, 6, 1), "polygon", splits, display=True)
        self.assertAlmostEqual(total, 0.32 / 1.253 / 2)
        self.assertAlmostEqual(shown, 0.16)


class DividendHistoryLogicTests(unittest.TestCase):
    def test_flat_annual_dividends_stay_in_their_own_years(self):
        rows = [row(f"{y}-11-30", 0.08, "polygon") for y in (2018, 2019, 2020, 2021)] + \
               [row("2022-11-30", 0.12, "polygon"), row("2023-11-30", 0.12, "polygon"), row("2024-11-27", 0.16, "polygon")]
        events, _ = _attributed_history_events(rows, "CCJ", False, 10)   # 인상월 11월 → 결산월 10월
        self.assertEqual(sorted(e["year"] for e in events), list(range(2018, 2025)))

    def test_frequency_needs_two_years_to_outrank_interval(self):
        events = [{"date": date.fromisoformat(d), "year": date.fromisoformat(d).year}
                  for d in ("2023-03-30", "2023-09-28", "2024-03-28", "2024-09-27", "2025-03-28", "2025-09-29", "2026-03-30")]
        # 재라벨 탓에 한 해만 3회로 잡혀도 반기배당
        self.assertEqual(_dividend_frequency(events, {2023: 3, 2024: 2, 2025: 2}, 2026, "8058.T"), 2)
        # 두 해 이상 3회 이상이면 분기배당(실제로 회차가 늘어난 경우)
        self.assertEqual(_dividend_frequency(events, {2023: 3, 2024: 4, 2025: 4}, 2026, "X"), 4)


class SourceGuardTests(unittest.TestCase):
    def test_nasdaq_noncash_distribution_is_dropped(self):
        payload = {"data": {"dividends": {"rows": [
            {"exOrEffDate": "08/14/2026", "amount": "$0.70", "type": "Cash", "paymentDate": "09/04/2026"},
            {"exOrEffDate": "06/29/2026", "amount": "$110.505", "type": "Cash", "paymentDate": "06/29/2026"},
            {"exOrEffDate": "05/15/2026", "amount": "$1.19", "type": "Cash", "paymentDate": "06/05/2026"},
            {"exOrEffDate": "02/27/2026", "amount": "$1.19", "type": "Cash", "paymentDate": "03/13/2026"},
        ]}}}
        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        import json
        with mock.patch.object(ds.urllib.request, "urlopen", return_value=Resp(json.dumps(payload).encode())):
            amounts = sorted(e["amount"] for e in ds._fetch_nasdaq_dividends("HON"))
        self.assertEqual(amounts, [0.7, 1.19, 1.19])

    def test_calendar_duplicate_of_confirmed_dividend_is_dropped(self):
        events = {
            "2026-11-10": {"ex_date": "2026-11-10", "amount": 1.16, "source": "polygon"},
            "2026-11-11": {"ex_date": "2026-11-11", "amount": 1.16, "source": "yf-calendar", "pay_date": "2026-09-01"},
            "2027-02-10": {"ex_date": "2027-02-10", "amount": 1.16, "source": "yf-calendar"},
        }
        kept = ds._drop_shadowed_calendar_events(events)
        self.assertEqual([e["ex_date"] for e in kept], ["2026-11-10", "2027-02-10"])


class StatsCacheYieldTests(unittest.TestCase):
    def test_history_corrected_yield_survives_raw_revalidation(self):
        import json, time
        from portfolio_core import fundamentals as fm
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        from portfolio_core.db import ensure_stats_cache_table
        ensure_stats_cache_table(conn)
        raw = json.dumps({"info": {"dividendYield": 28.64}})
        conn.execute(
            "INSERT INTO ticker_stats_cache (ticker, version, fetched_ts, fetched_at, source, dividend_yield, raw_json) VALUES (?,?,?,?,?,?,?)",
            ("BITO", fm.STATS_CACHE_VERSION, time.time(), "now", "yfinance", 1.28, raw),
        )
        conn.execute(
            "INSERT INTO ticker_stats_cache (ticker, version, fetched_ts, fetched_at, source, dividend_yield, raw_json) VALUES (?,?,?,?,?,?,?)",
            ("TSL", fm.STATS_CACHE_VERSION, time.time(), "now", "yfinance", 43.08, json.dumps({"info": {"dividendYield": 0}})),
        )
        conn.execute(
            "INSERT INTO ticker_stats_cache (ticker, version, fetched_ts, fetched_at, source, dividend_yield, raw_json) VALUES (?,?,?,?,?,?,?)",
            ("AAPL", fm.STATS_CACHE_VERSION, time.time(), "now", "yfinance", 0.31, json.dumps({"info": {"dividendYield": 0.31}})),
        )
        items = fm.load_stats_cache_items(conn, ["BITO", "TSL", "AAPL"], time.time(), fresh_only=False)
        self.assertAlmostEqual(items["BITO"]["dividend_yield"], 1.28)
        self.assertAlmostEqual(items["TSL"]["dividend_yield"], 43.08)
        self.assertAlmostEqual(items["AAPL"]["dividend_yield"], 0.31)


class TechnicalStatsListingTests(unittest.TestCase):
    def test_prelisting_prices_are_excluded_from_derived_metrics(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE daily_prices (ticker TEXT, date TEXT, close REAL, high REAL, low REAL);
            CREATE TABLE dividend_events (ticker TEXT, ex_date TEXT, record_date TEXT, pay_date TEXT,
                declaration_date TEXT, amount REAL, currency TEXT, source TEXT);
            CREATE TABLE stock_splits (ticker TEXT, split_date TEXT, ratio REAL, source TEXT);
            CREATE TABLE ticker_stats_cache (ticker TEXT, dividend_yield REAL);
            CREATE TABLE tickers (ticker TEXT, currency TEXT, display_name TEXT, name TEXT);
            CREATE TABLE ticker_listing_dates (ticker TEXT PRIMARY KEY, list_date TEXT, source TEXT, status TEXT, fetched_at TEXT);
        """)
        today = date.today()
        for i in range(1300):
            day = (today - timedelta(days=1300 - i)).isoformat()
            spac = 10.0 if i < 900 else 10.0 + (i - 900) * 0.1      # 합병 전 10달러 횡보, 상장 후 상승
            conn.execute("INSERT INTO daily_prices VALUES ('OKLO',?,?,?,?)", (day, spac, spac, spac))
            conn.execute("INSERT INTO daily_prices VALUES ('SP500',?,?,?,?)", (day, 100 + i * 0.01, 100, 100))
        list_date = (today - timedelta(days=400)).isoformat()
        conn.execute("INSERT INTO ticker_listing_dates VALUES ('OKLO', ?, 'polygon', 'ok', 'now')", (list_date,))

        @contextmanager
        def test_connect():
            yield conn

        with mock.patch.object(technical, "connect", test_connect):
            technical.refresh_technical_stats_cache(["OKLO"])
            cached = technical.load_technical_stats_cache(conn, ["OKLO"])["OKLO"]
        self.assertIsNone(cached["performance"]["three_year"])      # 상장 전 가격으로 만든 3년 수익률은 없어야 한다
        self.assertIsNotNone(cached["performance"]["one_year"])
        self.assertIsNone(cached["risk_reward"]["5y"])
        row_ = conn.execute("SELECT price_count FROM ticker_technical_stats_cache WHERE ticker='OKLO'").fetchone()
        self.assertEqual(row_[0], 400)


if __name__ == "__main__":
    unittest.main()

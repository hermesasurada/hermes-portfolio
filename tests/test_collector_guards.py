"""수집기 방어(2026-11-11): 실패를 '값 없음'으로 저장하거나 엉뚱한 종목에 붙이지 않는다.
일본 연초 대체휴일 오판, 실적일 HTTP 오류, OpenDART 비정상 상태, 연속배당 빈 응답, ETF 등락 장애."""
import sys
import tempfile
import unittest
import urllib.error
from datetime import date
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import portfolio_core.db as db_module

_TMP = tempfile.TemporaryDirectory(prefix="portfolio-test-")
db_module.DB_PATH = Path(_TMP.name) / "stock_history.db"
db_module.initialize_schema()

import collect_prices  # noqa: E402
from portfolio_core import dividend_sources, dividend_streaks, etf_holdings, us_live_quotes  # noqa: E402
from portfolio_core import opendart_dividends as od  # noqa: E402
from portfolio_core.db import connect, ensure_stats_cache_table  # noqa: E402
from portfolio_core.market_calendar import japan_equity_calendar_day  # noqa: E402


class JapanCalendarTests(unittest.TestCase):
    def status(self, text):
        return japan_equity_calendar_day(date.fromisoformat(text))["status"]

    def test_exchange_year_end_days_have_no_substitute(self):
        # 1/1(2023)·1/3(2027)·1/2(2028)이 일요일인 해 — 도쿄거래소는 1/4에 연다.
        for text in ("2023-01-04", "2027-01-04", "2028-01-04"):
            self.assertEqual(self.status(text), "open", text)
        for text in ("2027-01-01", "2026-12-31", "2023-01-02", "2023-01-03", "2025-01-02", "2025-01-03"):
            self.assertEqual(self.status(text), "closed", text)

    def test_national_substitute_holidays_still_close(self):
        # 골든위크 대체휴일, 일요일 건국기념일 대체, 9월 국민의 휴일
        for text in ("2025-05-06", "2026-05-06", "2024-02-12", "2026-09-22"):
            self.assertEqual(self.status(text), "closed", text)
        self.assertEqual(self.status("2026-05-07"), "open")


class EarningsDateCollectionTests(unittest.TestCase):
    def test_http_error_does_not_reuse_previous_date(self):
        def fetch(ticker):
            if ticker == "BBB":
                raise urllib.error.HTTPError("https://x", 500, "Server Error", {}, None)
            return "2026-11-20"

        with mock.patch.object(collect_prices, "load_watch", return_value={"overseas": ["AAA", "BBB", "CCC"]}), \
             mock.patch.object(collect_prices, "load_ticker_profiles", return_value={}), \
             mock.patch.object(collect_prices, "fetch_yahoo_earnings_date", side_effect=fetch):
            fetched, errors = collect_prices.collect_earnings_dates(["overseas"], None, 24, force=True)
        self.assertEqual(fetched, [("AAA", "2026-11-20"), ("CCC", "2026-11-20")])
        self.assertEqual(errors, ["BBB"])

    def test_http_error_on_first_ticker(self):
        error = urllib.error.HTTPError("https://x", 429, "Too Many Requests", {}, None)
        with mock.patch.object(collect_prices, "load_watch", return_value={"overseas": ["AAA"]}), \
             mock.patch.object(collect_prices, "load_ticker_profiles", return_value={}), \
             mock.patch.object(collect_prices, "fetch_yahoo_earnings_date", side_effect=error):
            self.assertEqual(collect_prices.collect_earnings_dates(["overseas"], None, 24, force=True), ([], ["AAA"]))


class OpendartStatusTests(unittest.TestCase):
    def fetch(self, body: bytes):
        with mock.patch.object(od, "_api_key", return_value="key"), \
             mock.patch.object(od, "_corp_lookup", return_value=("00126380", "common")), \
             mock.patch.object(od, "_get", return_value=body):
            return od.fetch_opendart_dividends("005930.KS")

    def test_no_data_is_empty(self):
        self.assertEqual(self.fetch('{"status":"013","message":"조회된 데이타가 없습니다."}'.encode()), [])

    def test_quota_or_key_error_raises(self):
        for status in ("020", "010", "800"):
            with self.assertRaises(RuntimeError):
                self.fetch(f'{{"status":"{status}","message":"x"}}'.encode())

    def test_error_reaches_source_status(self):
        # 상태 문자열에 opendart_error가 남아야 dividend_refresh가 한국 배당을 통째 교체하지 않는다.
        with mock.patch.object(dividend_sources, "is_opendart_candidate", return_value=True), \
             mock.patch.object(dividend_sources, "fetch_opendart_dividends", side_effect=RuntimeError("OpenDART status 020")), \
             mock.patch.object(dividend_sources, "_fetch_kind_etf_dividends", return_value=[]), \
             mock.patch.object(dividend_sources, "_fetch_yahoo_dividends", return_value=[]), \
             mock.patch.object(dividend_sources, "_stockanalysis_exchange", return_value=None):
            _, status = dividend_sources._fetch_dividends("005930.KS", "삼성전자")
        self.assertIn("opendart_error", status)

    def test_near_dates(self):
        known = [date(2026, 3, 27)]
        self.assertTrue(dividend_sources._near_dates(known, "2026-03-31"))
        self.assertFalse(dividend_sources._near_dates(known, "2026-04-01"))
        self.assertFalse(dividend_sources._near_dates(known, "not-a-date"))
        self.assertFalse(dividend_sources._near_dates([], "2026-03-27"))


class DividendStreakTests(unittest.TestCase):
    def setUp(self):
        with connect() as conn:
            ensure_stats_cache_table(conn)
            conn.execute("DELETE FROM tickers")
            conn.execute("DELETE FROM ticker_stats_cache")
            conn.execute("INSERT INTO tickers (ticker, name, category, currency) VALUES ('KO', 'Coca-Cola', 'overseas', 'USD')")
            conn.execute(
                """INSERT INTO ticker_stats_cache (ticker, version, fetched_ts, fetched_at, source,
                       dividend_streak_years, dividend_streak_floor, dividend_growth_streak_years, streaks_fetched_at)
                   VALUES ('KO', 1, 0, '', 'x', 62, 1, 62, '2020-01-01T00:00:00+09:00')"""
            )

    def streak_row(self):
        with connect() as conn:
            return dict(conn.execute(
                "SELECT dividend_streak_years, dividend_growth_streak_years, streaks_fetched_at FROM ticker_stats_cache WHERE ticker = 'KO'"
            ).fetchone())

    def test_empty_history_keeps_previous_streak(self):
        with mock.patch.object(dividend_streaks, "_yearly_dividends", return_value={}):
            self.assertEqual(dividend_streaks.refresh_dividend_streaks(pause_seconds=0), 0)
        self.assertEqual(self.streak_row(), {
            "dividend_streak_years": 62, "dividend_growth_streak_years": 62,
            "streaks_fetched_at": "2020-01-01T00:00:00+09:00",
        })

    def test_real_history_updates(self):
        yearly = {year: [0.5] for year in range(2020, date.today().year + 1)}
        with mock.patch.object(dividend_streaks, "_yearly_dividends", return_value=yearly), \
             mock.patch.object(dividend_streaks, "fetch_sa_growth_years", return_value="missing"):
            self.assertEqual(dividend_streaks.refresh_dividend_streaks(pause_seconds=0), 1)
        self.assertNotEqual(self.streak_row()["streaks_fetched_at"], "2020-01-01T00:00:00+09:00")


class EtfDayChangeTests(unittest.TestCase):
    def test_stops_after_first_failed_chunk(self):
        symbols = [f"ZZ{i:03d}" for i in range(120)]
        with mock.patch.object(us_live_quotes, "yahoo_quote_batch", side_effect=OSError("down")) as batch:
            self.assertEqual(etf_holdings._yahoo_day_changes(symbols), {})
        self.assertEqual(batch.call_count, 1)


if __name__ == "__main__":
    unittest.main()

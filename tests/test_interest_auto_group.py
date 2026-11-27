"""새 종목 → 관심목록 자동 배정(2026-11-27 사용자 지시: 애매하면 기본('기타')으로 둔다)."""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portfolio_core import db, watchlist
from portfolio_core.db import connect
from portfolio_core.interest_auto_group import auto_assign_interest_groups, suggest_interest_group

GROUPS = ["주요 지수", "환율", "찐관심", "미국", "한국", "일본", "유럽 종목", "대만/중국", "디지털자산", "투자종료", "레버리지/롱숏 ETF"]


class AutoGroupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "test.db"
        with sqlite3.connect(db.DB_PATH) as conn:
            db.ensure_base_tables(conn)
            db.ensure_interest_watchlist_tables(conn)
            conn.execute("INSERT INTO interest_watchlist_settings (key, value) VALUES ('initial_seeded', '1')")
            conn.executemany("INSERT INTO interest_watchlist_groups (name, sort_order, created_at) VALUES (?, ?, '')",
                             [(name, index * 10) for index, name in enumerate(GROUPS)])
            conn.executemany(
                "INSERT INTO tickers (ticker, name, currency, category) VALUES (?, ?, ?, ?)",
                [("NVDA", "NVIDIA Corporation", "USD", "overseas"), ("CRWV", "CoreWeave, Inc.", "USD", "overseas"),
                 ("TSLA", "Tesla, Inc.", "USD", "overseas")],
            )

    def tearDown(self):
        db.DB_PATH = self.old_path
        self.tmp.cleanup()

    def suggest(self, **item):
        with connect() as conn:
            return suggest_interest_group(conn, item)

    def test_exchange_and_currency_rules(self):
        cases = {
            ("006400.KS", "KRW", "kr"): "한국",
            ("7203.T", "JPY", "overseas"): "일본",
            ("2344.TW", "TWD", "overseas"): "대만/중국",
            ("0700.HK", "HKD", "overseas"): "대만/중국",
            ("1F80.DE", "EUR", "overseas"): "유럽 종목",
            ("BA.L", "GBP", "overseas"): "유럽 종목",
            ("KRW-BTC", "KRW", "crypto"): "디지털자산",
        }
        for (ticker, currency, category), group in cases.items():
            self.assertEqual(self.suggest(ticker=ticker, name=ticker, currency=currency, category=category), (group, None), ticker)

    def test_us_listing_by_country_and_type(self):
        us = dict(currency="USD", category="overseas")
        self.assertEqual(self.suggest(ticker="IT", name="Gartner, Inc.", country="United States", **us), ("미국", None))
        self.assertEqual(self.suggest(ticker="NVO", name="Novo Nordisk A/S", country="Denmark", **us), ("미국", None))
        self.assertEqual(self.suggest(ticker="BIDU", name="Baidu, Inc.", country="China", **us), ("대만/중국", None))
        self.assertEqual(self.suggest(ticker="ASX", name="ASE Technology", country="Taiwan", **us), ("대만/중국", None))
        self.assertEqual(self.suggest(ticker="QLD", name="ProShares Ultra QQQ", quote_type="ETF", **us), ("미국", None))
        # 나라를 모르면 애매 → 배정 안 함, 지수·환율·다른 나라 거래소도 안 함
        self.assertEqual(self.suggest(ticker="CCL", name="Carnival", **us), (None, None))
        self.assertEqual(self.suggest(ticker="SHOP.TO", name="Shopify", currency="CAD", category="overseas"), (None, None))
        self.assertEqual(self.suggest(ticker="^GSPC", name="S&P 500", currency="USD", category="index"), (None, None))

    def test_single_stock_leveraged_etf_gets_group_and_name(self):
        us = dict(currency="USD", category="overseas", quote_type="ETF")
        self.assertEqual(self.suggest(ticker="NVDL", name="GraniteShares 2x Long NVDA Daily ETF", **us),
                         ("레버리지/롱숏 ETF", "Granite NVDA Long 2x"))
        self.assertEqual(self.suggest(ticker="NVDD", name="Direxion Daily NVDA Bear 1X ETF", **us),
                         ("레버리지/롱숏 ETF", "Direxion NVDA Short 1x"))
        self.assertEqual(self.suggest(ticker="CORD", name="T-REX 2X Inverse CoreWeave Daily Target ETF", **us),
                         ("레버리지/롱숏 ETF", "T-REX CRWV Short 2x"))
        self.assertEqual(self.suggest(ticker="TSL", name="GraniteShares 1.25x Long TSLA Daily ETF", **us),
                         ("레버리지/롱숏 ETF", "Granite TSLA Long 1.25x"))
        # 레버리지처럼 보이지만 기초 종목을 못 읽으면(지수형 등) 애매 → 배정 안 함
        self.assertEqual(self.suggest(ticker="SOXL", name="Direxion Daily Semiconductor Bull 3X Shares", **us), (None, None))
        self.assertEqual(self.suggest(ticker="AAPU", name="Direxion Daily AAPL Bull 2X ETF", **us), (None, None))

    def test_assign_inserts_once_and_skips_already_grouped(self):
        with connect() as conn:
            conn.execute("INSERT INTO tickers (ticker, name, currency, category, display_name) VALUES "
                         "('NVDL', 'GraniteShares 2x Long NVDA Daily ETF', 'USD', 'overseas', 'GraniteShares 2x Long NVDA Daily ETF')")
            closed = conn.execute("SELECT id FROM interest_watchlist_groups WHERE name = '투자종료'").fetchone()[0]
            conn.execute("INSERT INTO interest_watchlist_items (group_id, ticker, sort_order, created_at) VALUES (?, '005930.KS', 10, '')", (closed,))
            conn.commit()
        assigned = auto_assign_interest_groups([
            {"ticker": "NVDL", "name": "GraniteShares 2x Long NVDA Daily ETF", "currency": "USD", "category": "overseas", "quote_type": "ETF"},
            {"ticker": "005930.KS", "name": "삼성전자", "currency": "KRW", "category": "kr"},
            {"ticker": "CCL", "name": "Carnival", "currency": "USD", "category": "overseas"},
        ])
        self.assertEqual(assigned, {"NVDL": "레버리지/롱숏 ETF"})
        self.assertEqual(auto_assign_interest_groups([{"ticker": "NVDL", "name": "x", "currency": "USD"}]), {})
        with connect() as conn:
            self.assertEqual(conn.execute("SELECT display_name FROM tickers WHERE ticker = 'NVDL'").fetchone()[0], "Granite NVDA Long 2x")
            groups = [row[0] for row in conn.execute(
                "SELECT g.name FROM interest_watchlist_items i JOIN interest_watchlist_groups g ON g.id = i.group_id WHERE i.ticker = '005930.KS'")]
        self.assertEqual(groups, ["투자종료"])

    def test_user_edited_name_kept_and_missing_group_not_created(self):
        with connect() as conn:
            conn.execute("INSERT INTO tickers (ticker, name, currency, category, display_name) VALUES "
                         "('NVDD', 'Direxion Daily NVDA Bear 1X ETF', 'USD', 'overseas', '내 엔비디아 숏')")
            conn.execute("DELETE FROM interest_watchlist_groups WHERE name = '일본'")
            conn.commit()
        assigned = auto_assign_interest_groups([
            {"ticker": "NVDD", "name": "Direxion Daily NVDA Bear 1X ETF", "currency": "USD", "category": "overseas"},
            {"ticker": "7203.T", "name": "Toyota", "currency": "JPY", "category": "overseas"},
        ])
        self.assertEqual(assigned, {"NVDD": "레버리지/롱숏 ETF"})
        with connect() as conn:
            self.assertEqual(conn.execute("SELECT display_name FROM tickers WHERE ticker = 'NVDD'").fetchone()[0], "내 엔비디아 숏")
            self.assertIsNone(conn.execute("SELECT 1 FROM interest_watchlist_groups WHERE name = '일본'").fetchone())

    def test_add_watchlist_reports_groups(self):
        lookups = {
            "IT": {"ticker": "IT", "name": "Gartner, Inc.", "currency": "USD", "category": "overseas", "region": "US", "country": "United States", "quote_type": "EQUITY"},
            "CCL": {"ticker": "CCL", "name": "Carnival", "currency": "USD", "category": "overseas", "region": "US"},
        }
        with mock.patch.object(watchlist, "lookup_ticker", side_effect=lambda t: lookups[t]), \
             mock.patch.object(watchlist.threading, "Thread"):
            result = watchlist.add_watchlist_async([{"ticker": "IT"}, {"ticker": "CCL"}])
        self.assertEqual(result["interest_groups"], {"IT": "미국"})
        self.assertIn("IT → 미국", result["message"])
        self.assertIn("CCL은(는) 분류가 애매해 '기타'에 둡니다", result["message"])


if __name__ == "__main__":
    unittest.main()

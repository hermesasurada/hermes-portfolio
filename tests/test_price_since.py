"""리포트 생성 이후 등락률 묶음 조회(price_since) — 임시 DB만 쓴다."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_core import db, price_since as ps


class PriceSinceTests(unittest.TestCase):
    def test_base_cutoff_follows_market_close_times(self):
        evening = ps.parse_since("2026-10-18T20:11:52+09:00")      # 일요일 저녁(KST)
        self.assertEqual(ps.base_cutoff_date("005930.KS", evening), "2026-10-18")   # 아시아: 당일 16시 확정
        self.assertEqual(ps.base_cutoff_date("NVDA", evening), "2026-10-17")        # 미국: 다음 날 06시 확정
        self.assertEqual(ps.base_cutoff_date("SAP.DE", evening), "2026-10-17")      # 유럽: 다음 날 01시 확정
        morning = ps.parse_since("2026-10-21T09:30:00+09:00")       # 화요일 아침
        self.assertEqual(ps.base_cutoff_date("005930.KS", morning), "2026-10-20")   # 오늘 종가는 아직 없음
        self.assertEqual(ps.base_cutoff_date("NVDA", morning), "2026-10-20")        # 월요일 미국 종가는 확정
        self.assertEqual(ps.parse_since("2026-10-18").isoformat(), "2026-10-18T23:59:00+09:00")
        with self.assertRaises(ValueError):
            ps.parse_since("")

    def test_load_uses_last_known_close_and_snapshot_price(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "p.db"
            with patch.object(db, "DB_PATH", path):
                with db.connect() as conn:
                    conn.executescript("""
                        CREATE TABLE tickers(ticker TEXT PRIMARY KEY, name TEXT, display_name TEXT, currency TEXT, category TEXT);
                        CREATE TABLE daily_prices(ticker TEXT, date TEXT, close REAL, source TEXT);
                        CREATE INDEX idx_daily_prices_ticker_date_desc ON daily_prices(ticker, date DESC);
                        INSERT INTO tickers VALUES('NVDA','NVIDIA','','USD','overseas'),('005930.KS','삼성전자','','KRW','domestic');
                        INSERT INTO daily_prices VALUES
                          ('NVDA','2026-10-15',200,'y'),('NVDA','2026-10-16',214,'y'),('NVDA','2026-10-20',220,'y'),
                          ('005930.KS','2026-10-16',217000,'y'),('005930.KS','2026-10-20',213000,'y');
                    """)
                snapshot = {"prices": {"NVDA": {"price": 235.4, "regular_price": 235.4, "date": "2026-10-23"},
                                       "005930.KS": {"price": 213000, "date": "2026-10-20"}},
                            "rates": {}, "previous_rates": {}}
                with patch.object(ps, "build_market_snapshot", lambda *a, **k: snapshot), \
                        patch.object(ps, "us_market_status", lambda: {}):
                    out = ps.load_price_since(["nvda", "005930.KS", "NOPE"], "2026-10-18T20:11:52+09:00")
        nv, ss, nope = out["items"]["NVDA"], out["items"]["005930.KS"], out["items"]["NOPE"]
        self.assertEqual((nv["base_date"], nv["base_price"], nv["current_price"]), ("2026-10-16", 214.0, 235.4))
        self.assertAlmostEqual(nv["change_pct"], (235.4 / 214 - 1) * 100)
        self.assertEqual(ss["base_date"], "2026-10-16")
        self.assertAlmostEqual(ss["change_pct"], (213000 / 217000 - 1) * 100)
        self.assertIsNone(nope["change_pct"])
        self.assertEqual(out["since"], "2026-10-18T20:11:52+09:00")


if __name__ == "__main__":
    unittest.main()

"""찐관심 별(2026-10-30) — 별 토글로만 넣고 빼는 고정 그룹: 자동 생성·멱등·삭제/이름변경 차단."""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portfolio_core import db
from portfolio_core.interest_watchlists import (
    FAVORITE_GROUP_NAME,
    delete_interest_group,
    rename_interest_group,
    set_favorite_item,
)


class FavoriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "test.db"
        with sqlite3.connect(db.DB_PATH) as conn:
            db.ensure_base_tables(conn)
            db.ensure_interest_watchlist_tables(conn)
            conn.execute("INSERT INTO interest_watchlist_settings (key, value) VALUES ('initial_seeded', '1')")
            conn.executemany(
                "INSERT INTO tickers (ticker, name, currency, category) VALUES (?, ?, ?, ?)",
                [("AAPL", "Apple", "USD", "us"), ("^GSPC", "S&P 500", "USD", "index")],
            )

    def tearDown(self):
        db.DB_PATH = self.old_path
        self.tmp.cleanup()

    def favorite(self, payload):
        return next(group for group in payload["groups"] if group.get("favorite"))

    def test_star_creates_group_and_toggles_idempotently(self):
        payload = set_favorite_item({"ticker": "aapl", "favorite": True})
        group = self.favorite(payload)
        self.assertEqual(group["name"], FAVORITE_GROUP_NAME)
        self.assertEqual([item["ticker"] for item in group["items"]], ["AAPL"])
        # 같은 상태 재요청은 오류 없이 그대로
        self.assertEqual(len(self.favorite(set_favorite_item({"ticker": "AAPL", "favorite": True}))["items"]), 1)
        self.assertEqual(self.favorite(set_favorite_item({"ticker": "AAPL", "favorite": False}))["items"], [])
        self.assertEqual(self.favorite(set_favorite_item({"ticker": "AAPL", "favorite": False}))["items"], [])

    def test_rejects_unknown_index_and_bad_payload(self):
        for payload in ({"ticker": "NOPE", "favorite": True},
                        {"ticker": "^GSPC", "favorite": True},
                        {"ticker": "AAPL", "favorite": "yes"}):
            with self.assertRaises(ValueError):
                set_favorite_item(payload)

    def test_favorite_group_cannot_be_deleted_or_renamed(self):
        group_id = self.favorite(set_favorite_item({"ticker": "AAPL", "favorite": True}))["id"]
        with self.assertRaises(ValueError):
            delete_interest_group({"group_id": group_id})
        with self.assertRaises(ValueError):
            rename_interest_group({"group_id": group_id, "name": "다른 이름"})


if __name__ == "__main__":
    unittest.main()

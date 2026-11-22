"""wm 회사 배당 공시 → 임시 배당 이벤트(2026-11-23). sa와 같은 기준 — 자체 수집 값만 남고, sa와 겹치면 먼저 들어온 쪽."""
import sqlite3
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

import portfolio_core.db as db_module

_TMP = tempfile.TemporaryDirectory()
db_module.DB_PATH = Path(_TMP.name) / "stock_history.db"

from portfolio_core import sa_dividends, wm_dividends  # noqa: E402
from portfolio_core.db import connect, ensure_base_tables, ensure_dividend_tables  # noqa: E402

NOC = ("FALLS CHURCH, Va., Nov. 18, 2026 (GLOBE NEWSWIRE) -- The board of directors of Northrop Grumman Corporation "
       "(NYSE: NOC) declared a quarterly dividend of $2.47 per share on Northrop Grumman common stock, payable "
       "December 16, 2026, to shareholders of record as of the close of business November 30, 2026.")
D = date(2026, 11, 18)


class ParseTests(unittest.TestCase):
    def test_typical_release(self):
        ev = wm_dividends.parse_release("Northrop Grumman Board Declares Quarterly Dividend", NOC, D)
        self.assertEqual(ev, {"amount": 2.47, "pay_date": "2026-12-16", "ex_date": "2026-11-30",
                              "record_date": "2026-11-30", "declaration_date": "2026-11-18"})

    def test_cents_and_two_sentence_form(self):
        body = ("its Board of Directors has declared a regular quarterly cash dividend on its common stock of 17.5 cents "
                "per share. The dividend will be payable December 18, 2026 to shareholders of record on December 4, 2026.")
        ev = wm_dividends.parse_release("Mueller Industries, Inc. Declares Cash Dividend", body, D)
        self.assertEqual((ev["amount"], ev["ex_date"], ev["pay_date"]), (0.175, "2026-12-04", "2026-12-18"))
        title = "Chemed Corporation Declares Quarterly Dividend of 70 Cents"
        body2 = "declared a quarterly dividend of 70 cents per share, payable December 4, 2026 to stockholders of record November 16, 2026."
        self.assertEqual(wm_dividends.parse_release(title, body2, D)["amount"], 0.7)

    def test_increase_takes_new_amount(self):
        realty = ("today declared an increase in its common stock monthly cash dividend to $0.2740 per share from $0.2715 "
                  "per share. The dividend is payable on December 15, 2026, to stockholders of record as of November 30, 2026.")
        self.assertEqual(wm_dividends.parse_release("Monthly Dividend Increase", realty, D)["amount"], 0.274)
        amkor = ("approved an increase in the company's quarterly cash dividend from $0.08352 to $0.08436 per share on the "
                 "company's common stock. The dividend is payable on December 29, 2026 to stockholders of record at the "
                 "close of business on December 9, 2026.")
        self.assertEqual(wm_dividends.parse_release("Amkor Announces Increases in Quarterly Dividend", amkor, D)["amount"], 0.08436)

    def test_title_amount_must_match_but_buyback_dollars_ignored(self):
        self.assertIsNone(wm_dividends.parse_release("X Declares Quarterly Dividend of $2.50", NOC, D))
        mmm = ("The board also declared a dividend on the company's common stock of $0.78 per share for the fourth quarter "
               "of 2026. The dividend is payable Dec. 11, 2026, to shareholders of record at the close of business on Nov. 13, 2026.")
        ev = wm_dividends.parse_release("3M Board Approves New $6 Billion Share Repurchase Authorization, Declares Quarterly Dividend", mmm, D)
        self.assertEqual((ev["amount"], ev["ex_date"]), (0.78, "2026-11-13"))

    def test_explicit_ex_date_wins(self):
        body = NOC.replace("2026.", "2026, with an ex-dividend date of November 27, 2026.")
        self.assertEqual(wm_dividends.parse_release("NOC Declares Dividend", body, D)["ex_date"], "2026-11-27")

    def test_rejects_cad_missing_record_and_link_only_bodies(self):
        self.assertIsNone(wm_dividends.parse_release("Dividend", NOC.replace("$2.47", "C$2.47"), D))
        self.assertIsNone(wm_dividends.parse_release("Dividend", NOC.split(", to shareholders")[0], D))
        self.assertIsNone(wm_dividends.parse_release(
            "GM releases results; declares quarterly dividend", "The earnings press release is available here.", D))


class ImportTests(unittest.TestCase):
    def setUp(self):
        db_module.DB_PATH.unlink(missing_ok=True)
        with connect() as conn:
            ensure_base_tables(conn)
            ensure_dividend_tables(conn)
            for t in ("NOC", "HD"):
                conn.execute("INSERT INTO tickers (ticker, name) VALUES (?, ?)", (t, t))
        self.wm_path = Path(_TMP.name) / "wm.db"
        self.wm_path.unlink(missing_ok=True)
        wm = sqlite3.connect(self.wm_path)
        wm.execute("CREATE TABLE articles (id INTEGER PRIMARY KEY, title TEXT, published_date TEXT, "
                   "discovered_date TEXT, deleted INTEGER NOT NULL DEFAULT 0)")
        wm.execute("CREATE TABLE dividend_texts (article_id INTEGER PRIMARY KEY, ticker TEXT, body TEXT, stored_at TEXT)")
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        wm.executemany("INSERT INTO articles VALUES (?, ?, ?, ?, ?)", [
            (1, "Northrop Grumman Board Declares Quarterly Dividend", "2026-11-18", now, 0),
            (2, "Trashed copy", "2026-11-18", now, 1),
            (3, "MMM Declares Dividend", "2026-11-18", now, 0),          # 수집 종목이 아니다
        ])
        wm.executemany("INSERT INTO dividend_texts VALUES (?, ?, ?, ?)",
                       [(1, "NOC", NOC, now), (2, "HD", NOC, now), (3, "MMM", NOC, now)])
        wm.commit()
        wm.close()
        wm_dividends.WM_DB_PATH = self.wm_path

    def rows(self, ticker):
        with connect() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT ex_date, amount, source FROM dividend_events WHERE ticker = ? ORDER BY ex_date", (ticker,))]

    def test_wm_row_then_own_collection_replaces_it(self):
        stats = wm_dividends.import_recent(days=3)
        self.assertEqual((stats["articles"], stats["inserted"], stats["skipped"]), (2, 1, 1))   # 휴지통 글은 안 읽는다
        self.assertEqual(self.rows("NOC"), [{"ex_date": "2026-11-30", "amount": 2.47, "source": "wm"}])
        self.assertEqual(self.rows("HD"), [])
        with connect() as conn:
            self.assertEqual(sa_dividends.drop_superseded(conn, "NOC", ["2026-12-01"]), 1)
            conn.execute("INSERT INTO dividend_events (ticker, ex_date, pay_date, amount, currency, source, fetched_at) "
                         "VALUES ('NOC', '2026-12-01', '2026-12-16', 2.47, 'USD', 'polygon', 'now')")
        again = wm_dividends.import_recent(days=3)
        self.assertEqual((again["inserted"], again["covered"]), (0, 1))
        self.assertEqual([r["source"] for r in self.rows("NOC")], ["polygon"])

    def test_existing_sa_row_counts_as_covered(self):
        with connect() as conn:
            conn.execute("INSERT INTO dividend_events (ticker, ex_date, pay_date, amount, currency, source, fetched_at) "
                         "VALUES ('NOC', '2026-11-30', '2026-12-16', 2.47, 'USD', 'sa', 'now')")
        self.assertEqual(wm_dividends.import_recent(days=3)["covered"], 1)
        self.assertEqual([r["source"] for r in self.rows("NOC")], ["sa"])

    def test_rerun_keeps_single_row(self):
        wm_dividends.import_recent(days=3)
        self.assertEqual(wm_dividends.import_recent(days=3)["updated"], 1)
        self.assertEqual(len(self.rows("NOC")), 1)


if __name__ == "__main__":
    unittest.main()

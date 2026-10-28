"""SA 배당선언 → 임시 배당 이벤트(2026-10-28). 순서와 상관없이 자체 수집 값만 남는지."""
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

import portfolio_core.db as db_module

_TMP = tempfile.TemporaryDirectory()
db_module.DB_PATH = Path(_TMP.name) / "stock_history.db"

from portfolio_core import sa_dividends  # noqa: E402
from portfolio_core.db import connect, ensure_base_tables, ensure_dividend_tables  # noqa: E402

ETN_BODY = (
    "# Eaton declares $1.10 dividend\n\nOct 27, 2026, 2:49 PM ET[Eaton Corporation plc (ETN) Stock](x)\n"
    "*   Eaton ([ETN](x)) declares [$1.10/share quarterly dividend](https://x), in line with previous.\n"
    "*   [Forward yield](x) 1.14%\n"
    "*   Payable Nov. 27; for shareholders of record Nov. 10; ex-div Nov. 10.\n"
)


def article_body(amount: str, pay: str, record: str, ex: str) -> str:
    return (f"Oct 27, 2026, 2:49 PM ET\n*   X declares [${amount}/share quarterly dividend](x).\n"
            f"*   Payable {pay}; for shareholders of record {record}; ex-div {ex}.\n")


class ParseTests(unittest.TestCase):
    def test_parses_amount_and_dates(self):
        ev = sa_dividends.parse_declaration("ETN: Eaton declares $1.10 dividend", ETN_BODY, date(2026, 10, 28))
        self.assertEqual(ev, {"amount": 1.1, "pay_date": "2026-11-27", "ex_date": "2026-11-10",
                              "record_date": "2026-11-10", "declaration_date": "2026-10-27"})

    def test_year_rolls_over_for_january_payment(self):
        body = "Dec 10, 2026, 4:05 PM ET\n declares [$0.19/share quarterly dividend](x)\nPayable Jan. 4; for shareholders of record Dec. 15; ex-div Dec. 15."
        ev = sa_dividends.parse_declaration("M: Macy's declares $0.19 dividend", body, date(2026, 12, 11))
        self.assertEqual((ev["ex_date"], ev["pay_date"]), ("2026-12-15", "2027-01-04"))

    def test_rejects_title_body_mismatch_foreign_currency_and_missing_dates(self):
        self.assertIsNone(sa_dividends.parse_declaration("ETN: Eaton declares $1.20 dividend", ETN_BODY, date(2026, 10, 28)))
        eur = "declares [EUR 0.03/share quarterly dividend](x)\nPayable Nov. 5; for shareholders of record Oct. 27; ex-div Oct. 27."
        self.assertIsNone(sa_dividends.parse_declaration("Nokia Oyj declares EUR 0.03 dividend", eur, date(2026, 10, 23)))
        no_ex = "declares [$0.50/share quarterly dividend](x)\nPayable Dec. 1; for shareholders of record Nov. 6."
        self.assertIsNone(sa_dividends.parse_declaration("WFC: Wells Fargo declares $0.50 dividend", no_ex, date(2026, 10, 28)))


class RaiseTitleTests(unittest.TestCase):
    """배당인상 기사(2026-10-28) — 제목 'raises dividend by N% to $X', 본문은 배당선언과 같은 형식."""
    V_BODY = ("Oct 27, 2026, 10:23 PM ET[Visa Inc. (V) Stock](x)\n"
              "*   Visa ([V](x)) declares $0.78/share quarterly dividend, 16.4% increase from prior dividend of $0.67.\n"
              "*   Payable Dec. 1; for shareholders of record Nov. 10; ex-div Nov. 10.\n")

    def test_raise_titles_parse(self):
        for title in ("Visa raises dividend by 16.4% to $0.78", "V: Visa lifts quarterly dividend by 16% to  $0.78/share",
                      "Visa raises dividend to $0.78, announces $30B buyback"):
            ev = sa_dividends.parse_declaration(title, self.V_BODY, date(2026, 10, 28))
            self.assertEqual((ev["amount"], ev["ex_date"], ev["pay_date"], ev["declaration_date"]),
                             (0.78, "2026-11-10", "2026-12-01", "2026-10-27"), title)

    def test_raise_title_amount_must_match_body(self):
        self.assertIsNone(sa_dividends.parse_declaration("Visa raises dividend by 20% to $0.80", self.V_BODY, date(2026, 10, 28)))
        # 본문에 날짜가 없는 짧은 기사(LMT·IBKR 사례)는 넣지 않는다
        self.assertIsNone(sa_dividends.parse_declaration("LMT: Lockheed Martin raises dividend by 4.3% to $3.60",
                                                         "Lockheed Martin raises its dividend 4.3% to $3.60.", date(2026, 10, 11)))


class ArticleDayTests(unittest.TestCase):
    def test_kst_receipt_time_maps_to_us_eastern_date(self):
        self.assertEqual(sa_dividends._article_day_et("2026-10-28 02:40 KST"), date(2026, 10, 27))
        self.assertEqual(sa_dividends._article_day_et("2026-10-28 21:40 KST"), date(2026, 10, 28))


class ImportTests(unittest.TestCase):
    def setUp(self):
        db_module.DB_PATH.unlink(missing_ok=True)
        with connect() as conn:
            ensure_base_tables(conn)
            ensure_dividend_tables(conn)
            for t in ("ETN", "WST", "005930.KS"):
                conn.execute("INSERT INTO tickers (ticker, name) VALUES (?, ?)", (t, t))
        self.sa_path = Path(_TMP.name) / "sa_news.db"
        self.sa_path.unlink(missing_ok=True)
        sa = sqlite3.connect(self.sa_path)
        sa.execute("CREATE TABLE articles (id INTEGER PRIMARY KEY, ticker TEXT, original_title TEXT, "
                   "email_time_et TEXT, source_text TEXT)")
        today = datetime.now().strftime("%Y-%m-%d") + " 03:50 KST"
        sa.executemany("INSERT INTO articles VALUES (?, ?, ?, ?, ?)", [
            (1, "ETN", "ETN: Eaton declares $1.10 dividend", today, ETN_BODY),
            (2, "WST", "WST: West Pharmaceutical declares $0.26 dividend", today,
             article_body("0.26", "Nov. 18", "Nov. 11", "Nov. 9")),
            (3, "NVDA", "NVDA: NVIDIA declares $0.01 dividend", today,     # 수집 종목이 아니다
             article_body("0.01", "Dec. 26", "Dec. 4", "Dec. 4")),
        ])
        sa.commit()
        sa.close()
        sa_dividends.SA_DB_PATH = self.sa_path

    def rows(self, ticker):
        with connect() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT ex_date, pay_date, amount, source FROM dividend_events WHERE ticker = ? ORDER BY ex_date", (ticker,))]

    def test_sa_first_then_authoritative_replaces_even_with_shifted_ex_date(self):
        stats = sa_dividends.import_recent(days=3)
        self.assertEqual(stats["inserted"], 2)
        self.assertEqual(self.rows("WST"), [{"ex_date": "2026-11-09", "pay_date": "2026-11-18", "amount": 0.26, "source": "sa"}])
        # 자체 수집(Polygon)이 하루 다른 배당락일로 같은 배당을 가져온다
        with connect() as conn:
            removed = sa_dividends.drop_superseded(conn, "WST", ["2026-11-10"])
            conn.execute("INSERT INTO dividend_events (ticker, ex_date, pay_date, amount, currency, source, fetched_at) "
                         "VALUES ('WST', '2026-11-10', '2026-11-18', 0.26, 'USD', 'polygon', 'now')")
        self.assertEqual(removed, 1)
        self.assertEqual([r["source"] for r in self.rows("WST")], ["polygon"])
        # 다음 SA 가져오기는 자체 수집 행이 있으니 다시 넣지 않는다
        again = sa_dividends.import_recent(days=3)
        self.assertEqual(again["inserted"], 0)
        self.assertEqual(again["covered"], 1)       # WST는 자체 수집 행이 있다
        self.assertEqual(again["updated"], 1)       # ETN은 아직 sa 행뿐 — 같은 값으로 다시 쓴다
        self.assertEqual([r["source"] for r in self.rows("WST")], ["polygon"])

    def test_authoritative_first_means_sa_does_nothing(self):
        with connect() as conn:
            conn.execute("INSERT INTO dividend_events (ticker, ex_date, pay_date, amount, currency, source, fetched_at) "
                         "VALUES ('ETN', '2026-11-10', '2026-11-27', 1.1, 'USD', 'polygon', 'now')")
        sa_dividends.import_recent(days=3)
        self.assertEqual([r["source"] for r in self.rows("ETN")], ["polygon"])
        self.assertEqual([r["source"] for r in self.rows("WST")], ["sa"])

    def test_rerun_keeps_single_sa_row(self):
        sa_dividends.import_recent(days=3)
        sa_dividends.import_recent(days=3)
        self.assertEqual(len(self.rows("ETN")), 1)
        self.assertEqual(self.rows("NVDA"), [])

    def test_declare_and_raise_articles_for_same_dividend_keep_one_row(self):
        sa = sqlite3.connect(self.sa_path)
        today = datetime.now().strftime("%Y-%m-%d") + " 04:10 KST"
        sa.execute("INSERT INTO articles VALUES (4, 'WST', 'WST: West Pharmaceutical raises dividend by 4% to $0.26', ?, ?)",
                   (today, article_body("0.26", "Nov. 18", "Nov. 11", "Nov. 9")))
        sa.commit()
        sa.close()
        sa_dividends.import_recent(days=3)
        self.assertEqual(self.rows("WST"), [{"ex_date": "2026-11-09", "pay_date": "2026-11-18", "amount": 0.26, "source": "sa"}])

    def test_dry_run_writes_nothing(self):
        stats = sa_dividends.import_recent(days=3, dry_run=True)
        self.assertEqual(len(stats["events"]), 2)
        self.assertEqual(self.rows("ETN"), [])

    def test_old_articles_outside_window_ignored(self):
        sa = sqlite3.connect(self.sa_path)
        old = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d") + " 03:00 KST"
        sa.execute("UPDATE articles SET email_time_et = ?", (old,))
        sa.commit()
        sa.close()
        self.assertEqual(sa_dividends.import_recent(days=7)["articles"], 0)


if __name__ == "__main__":
    unittest.main()

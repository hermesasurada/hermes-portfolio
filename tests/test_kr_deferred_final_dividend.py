"""한국 결산배당 기준일 이연(삼성화재 2024~)과 우선주 OpenDART 수집(2026-10-30)."""
import io
import sys
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portfolio_core import opendart_dividends as od
from portfolio_core.dividend_history import _attributed_history_events


def row(ex_date, amount, declaration=None, record=None):
    return {"ex_date": ex_date, "record_date": record, "pay_date": None,
            "declaration_date": declaration, "amount": amount, "source": "test"}


def years(events):
    return {event["date"].isoformat(): event["year"] for event in events}


class DeferredFinalAttributionTests(unittest.TestCase):
    def test_samsung_fire_march_finals_without_declaration_go_to_prior_year(self):
        rows = [row("2021-12-29", 12000), row("2022-12-28", 13800), row("2024-03-26", 16000),
                row("2025-03-25", 19000), row("2026-03-26", 19500, "2026-02-13", "2026-03-27")]
        events, _ = _attributed_history_events(rows, "000810.KS", True, None)
        self.assertEqual(sorted(years(events).values()), [2021, 2022, 2023, 2024, 2025])
        self.assertTrue(all(event["is_final"] for event in events))

    def test_quarterly_payer_with_december_record_keeps_march_interim(self):
        rows = [row(f"{y}-{m}", 361) for y in (2023, 2024) for m in ("03-30", "06-29", "09-26", "12-27")]
        events, _ = _attributed_history_events(rows, "005930.KS", True, None)
        self.assertEqual(years(events)["2024-03-30"], 2024)
        self.assertFalse(next(e for e in events if e["date"].isoformat() == "2024-03-30")["is_final"])

    def test_february_final_then_march_interim_only_moves_the_first(self):
        rows = [row("2024-06-27", 500), row("2024-09-27", 500), row("2025-02-27", 900), row("2025-03-28", 500)]
        events, _ = _attributed_history_events(rows, "443060.KS", True, None)
        self.assertEqual((years(events)["2025-02-27"], years(events)["2025-03-28"]), (2024, 2025))

    def test_history_starting_with_deferred_final_follows_next_year(self):
        events, _ = _attributed_history_events(
            [row("2025-02-27", 5100), row("2025-06-27", 3200), row("2026-02-26", 9100)], "009540.KS", True, None)
        self.assertEqual(years(events), {"2025-02-27": 2024, "2025-06-27": 2025, "2026-02-26": 2025})
        lone, _ = _attributed_history_events([row("2024-03-28", 500)], "999990.KS", True, None)
        self.assertEqual(years(lone)["2024-03-28"], 2024)   # 근거가 없으면 그대로

    def test_korean_fund_january_distribution_stays_in_its_year(self):
        rows = [row("2024-10-30", 100), row("2025-01-24", 100), row("2025-04-29", 100)]
        events, _ = _attributed_history_events(rows, "379800.KS", True, None, korean_fund=True)
        self.assertEqual(years(events)["2025-01-24"], 2025)

    def test_april_record_declared_in_february_is_prior_year_final(self):
        events, _ = _attributed_history_events(
            [row("2025-08-13", 1500), row("2026-03-31", 6500, "2026-02-10", "2026-04-01")], "034730.KS", True, None)
        self.assertEqual(years(events)["2026-04-01"], 2025)


def decision_zip(common, preferred):
    text = (f"<p>3. 1주당 배당금(원)</p><p>보통주식</p><p>{common}</p><p>종류주식</p><p>{preferred}</p>"
            "<p>2. 배당종류 현금배당</p><p>배당기준일 2026-03-27</p><p>배당금지급 예정일자 2026-04-20</p>")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("doc.xml", text)
    return buffer.getvalue()


class OpendartPreferredTests(unittest.TestCase):
    def test_first_preferred_uses_common_company_and_class_amount(self):
        with mock.patch.object(od, "_corp_map", return_value={"000810": "00139214"}):
            self.assertEqual(od._corp_lookup("000810"), ("00139214", "common"))
            self.assertEqual(od._corp_lookup("000815"), ("00139214", "preferred"))
            self.assertEqual(od._corp_lookup("000817"), (None, "common"))   # 2우B는 대상 아님
            self.assertEqual(od._corp_lookup("123455"), (None, "common"))
        with mock.patch.object(od, "_api_key", return_value="k"), \
                mock.patch.object(od, "_get", return_value=decision_zip("19,500", "19,505")):
            self.assertEqual(od._parse_decision("r", "preferred")["amount"], 19505.0)
            self.assertEqual(od._parse_decision("r")["amount"], 19500.0)


if __name__ == "__main__":
    unittest.main()

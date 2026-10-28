"""분기배당 기업 증액 표시(2026-10-28) — 확정 증액·다음 회차 증액 예상 판정."""
import unittest
from datetime import date, timedelta

from portfolio_core.dividend_raise import (
    annotate_raise_markers,
    fx_converted_amounts,
    is_dividend_raise_candidate,
    is_quarterly_payer,
    ticker_raise_status,
)

TODAY = date(2026, 10, 28)


def series(*points):
    """(YYYY-MM-DD, 금액) → 정기 회차 시계열."""
    out = []
    for text, amount in points:
        day = date.fromisoformat(text)
        out.append({"date": day, "ex_date": day, "amount": amount, "raw_amount": amount})
    return out


def quarterly(start, amounts):
    day = date.fromisoformat(start)
    return series(*[((day + timedelta(days=91 * i)).isoformat(), amount) for i, amount in enumerate(amounts)])


def event(ticker, ex_date, source="polygon"):
    return {"ticker": ticker, "ex_date": ex_date, "pay_date": None, "source": source}


class ConfirmedRaiseTests(unittest.TestCase):
    def test_declared_raise_is_marked_with_both_comparisons(self):
        s = quarterly("2025-09-20", [0.59, 0.59, 0.59, 0.59, 0.65])   # 마지막 2026-09-15 증액
        rows = [event("X", s[-1]["date"].isoformat())]
        annotate_raise_markers(rows, {"X": s}, TODAY, {"X"})
        marker = rows[0]["raise_marker"]
        self.assertEqual(marker["kind"], "confirmed")
        self.assertAlmostEqual(marker["pct"], (0.65 / 0.59 - 1) * 100)
        self.assertAlmostEqual(marker["yoy_pct"], (0.65 / 0.59 - 1) * 100)

    def test_raise_before_payment_is_declared_until_paid(self):
        # 동일 '지급 전' 기간: 증액 공시 회차의 지급일이 오늘 이후(오늘 포함)면 declared(파랑), 지나면 confirmed
        s = quarterly("2025-09-20", [0.59, 0.59, 0.59, 0.59, 0.65])
        for pay, kind in (("2026-11-10", "declared"), ("2026-10-28", "declared"), ("2026-10-27", "confirmed")):
            s[-1]["pay_date"] = date.fromisoformat(pay)
            rows = [event("X", s[-1]["date"].isoformat())]
            annotate_raise_markers(rows, {"X": s}, TODAY, {"X"})
            self.assertEqual((rows[0]["raise_marker"]["kind"], rows[0]["raise_marker"]["pay_date"]), (kind, pay))
            self.assertEqual(ticker_raise_status("X", s, TODAY)["kind"], kind, pay)

    def test_same_amount_after_raise_is_not_marked(self):
        s = quarterly("2025-09-20", [0.59, 0.65, 0.65, 0.65, 0.65])
        rows = [event("X", s[-1]["date"].isoformat())]
        annotate_raise_markers(rows, {"X": s}, TODAY, {"X"})
        self.assertNotIn("raise_marker", rows[0])

    def test_korean_style_big_final_equal_to_last_year_is_not_a_raise(self):
        # 분기 375원 + 기말 1,875원 — 기말이 작년 기말과 같으면 직전보다 커도 증액 아님
        s = quarterly("2025-02-28", [1875, 375, 375, 375, 1875])
        rows = [event("000660.KS", s[-1]["date"].isoformat(), "opendart")]
        annotate_raise_markers(rows, {"000660.KS": s}, s[-1]["date"] + timedelta(days=30), {"000660.KS"})
        self.assertNotIn("raise_marker", rows[0])

    def test_buyback_drift_under_one_percent_is_ignored(self):
        s = quarterly("2025-09-30", [367, 370, 372, 374, 376])   # 삼성전자식 주당배당 미세 증가
        rows = [event("005930.KS", s[-1]["date"].isoformat(), "opendart")]
        annotate_raise_markers(rows, {"005930.KS": s}, TODAY, {"005930.KS"})
        self.assertNotIn("raise_marker", rows[0])

    def test_adr_fx_drift_needs_five_percent(self):
        s = quarterly("2025-09-16", [0.8221, 0.7954, 0.9390, 0.9393, 0.9612])   # +2.3% 환율 변동
        self.assertTrue(fx_converted_amounts(s))
        rows = [event("TSM", s[-1]["date"].isoformat())]
        annotate_raise_markers(rows, {"TSM": s}, TODAY, {"TSM"})
        self.assertNotIn("raise_marker", rows[0])
        s[-1]["amount"] = s[-1]["raw_amount"] = 1.0963                       # 실제 증액 +16.7%
        rows = [event("TSM", s[-1]["date"].isoformat())]
        annotate_raise_markers(rows, {"TSM": s}, TODAY, {"TSM"})
        self.assertEqual(rows[0]["raise_marker"]["kind"], "confirmed")

    def test_estimated_rows_never_get_confirmed_marker(self):
        s = quarterly("2025-09-20", [0.59, 0.59, 0.59, 0.59, 0.65])
        rows = [event("X", s[-1]["date"].isoformat(), "estimated-history")]
        annotate_raise_markers(rows, {"X": s}, TODAY, {"X"})
        self.assertNotEqual(rows[0].get("raise_marker", {}).get("kind"), "confirmed")

    def test_non_eligible_and_non_quarterly_are_skipped(self):
        s = quarterly("2025-09-20", [0.59, 0.59, 0.59, 0.59, 0.65])
        rows = [event("QLD", s[-1]["date"].isoformat())]
        annotate_raise_markers(rows, {"QLD": s}, TODAY, set())
        self.assertNotIn("raise_marker", rows[0])
        semi = series(("2024-04-22", 5.0), ("2024-08-20", 1.2), ("2025-04-22", 4.5), ("2025-08-20", 1.0), ("2026-04-22", 6.9))
        self.assertFalse(is_quarterly_payer("300750.SZ", semi, TODAY))
        self.assertFalse(is_quarterly_payer("RMS.PA", quarterly("2025-01-01", [1, 1, 1, 1, 1, 1, 1]), TODAY))


class ExpectedRaiseTests(unittest.TestCase):
    def test_next_undeclared_quarter_after_last_years_raise_is_expected(self):
        # 매년 12월 인상(AVGO): 2025-12 0.59→0.65, 그 뒤 동결 → 2026-12 추정 회차는 증액 예상
        s = series(("2025-06-20", 0.59), ("2025-09-22", 0.59), ("2025-12-22", 0.65),
                   ("2026-03-23", 0.65), ("2026-06-22", 0.65), ("2026-09-21", 0.65))
        rows = [event("AVGO", "2026-12-22", "estimated-history"), event("AVGO", "2027-03-23", "estimated-history")]
        annotate_raise_markers(rows, {"AVGO": s}, TODAY, {"AVGO"})
        self.assertEqual(rows[0]["raise_marker"]["kind"], "expected")
        self.assertEqual(rows[0]["raise_marker"]["raised_date"], "2025-12-22")
        self.assertNotIn("raise_marker", rows[1])   # 다음 회차 하나만

    def test_not_expected_until_last_declared_dividend_is_paid(self):
        # LLY식: 2026-11-13 배당락·12-10 지급 회차가 아직 지급 전이면 다음 회차(2월) 주황 표시 안 함
        s = series(("2025-08-15", 1.5), ("2025-11-14", 1.5), ("2026-02-13", 1.73),
                   ("2026-05-15", 1.73), ("2026-08-14", 1.73), ("2026-11-13", 1.73))
        for pay, shown in (("2026-12-10", False), ("2026-10-28", False), ("2026-10-27", True)):
            s[-1]["pay_date"] = date.fromisoformat(pay)
            today = date(2026, 10, 28) if pay != "2026-12-10" else TODAY
            rows = [event("LLY", "2027-02-13", "estimated-history")]
            annotate_raise_markers(rows, {"LLY": s}, today, {"LLY"})
            self.assertEqual("raise_marker" in rows[0], shown, pay)
            self.assertEqual(ticker_raise_status("LLY", s, today) is not None, shown, pay)

    def test_not_expected_when_raise_quarter_is_further_away(self):
        s = series(("2025-06-20", 0.59), ("2025-09-22", 0.59), ("2025-12-22", 0.65),
                   ("2026-03-23", 0.65), ("2026-06-22", 0.65), ("2026-09-21", 0.65))
        rows = [event("AVGO", "2027-03-23", "estimated-history")]   # 12월 회차는 이미 공시됐다고 가정 → 3월은 예상 아님
        annotate_raise_markers(rows, {"AVGO": s}, TODAY, {"AVGO"})
        self.assertNotIn("raise_marker", rows[0])

    def test_not_expected_when_already_raised_off_cycle(self):
        s = series(("2025-06-20", 0.59), ("2025-09-22", 0.59), ("2025-12-22", 0.65),
                   ("2026-03-23", 0.65), ("2026-06-22", 0.70), ("2026-09-21", 0.70))
        rows = [event("X", "2026-12-22", "estimated-history")]
        annotate_raise_markers(rows, {"X": s}, TODAY, {"X"})
        self.assertNotIn("raise_marker", rows[0])


class TickerStatusTests(unittest.TestCase):
    """목록 배당율 칸 — 가장 최근 공시 회차가 증액이면 confirmed, 아니면 다음 회차 증액 예상."""

    def test_latest_declared_raise_is_confirmed(self):
        s = quarterly("2025-09-20", [0.59, 0.59, 0.59, 0.59, 0.65])
        self.assertEqual(ticker_raise_status("X", s, TODAY)["kind"], "confirmed")

    def test_confirmed_clears_once_next_same_amount_is_declared(self):
        s = quarterly("2025-06-20", [0.59, 0.59, 0.59, 0.59, 0.65, 0.65])
        self.assertIsNone(ticker_raise_status("X", s, TODAY))

    def test_next_quarter_after_last_years_raise_is_expected(self):
        s = series(("2025-06-20", 0.59), ("2025-09-22", 0.59), ("2025-12-22", 0.65),
                   ("2026-03-23", 0.65), ("2026-06-22", 0.65), ("2026-09-21", 0.65))
        status = ticker_raise_status("AVGO", s, TODAY)
        self.assertEqual((status["kind"], status["raised_date"]), ("expected", "2025-12-22"))

    def test_stopped_payer_is_ignored(self):
        s = quarterly("2024-01-10", [0.5, 0.5, 0.5, 0.5, 0.6])
        self.assertIsNone(ticker_raise_status("X", s, TODAY))


class CandidateTests(unittest.TestCase):
    def test_funds_and_leveraged_products_are_excluded(self):
        self.assertTrue(is_dividend_raise_candidate("AVGO", ["Broadcom Inc.", "Broadcom"]))
        self.assertTrue(is_dividend_raise_candidate("138930.KS", ["BNK금융지주", "BNK금융지주"]))
        self.assertFalse(is_dividend_raise_candidate("AAPU", ["Direxion Daily AAPL Bull 2X ETF", "Direxion AAPL 롱 2x"]))
        self.assertFalse(is_dividend_raise_candidate("UPRO", ["ProShares UltraPro S&P500", None]))
        self.assertFalse(is_dividend_raise_candidate(
            "1489.T", ["NEXT FUNDS Nikkei 225 High Dividend Yield Stock 50 Index Exchange Traded Fd", "일본 닛케이 고배당50"]))


if __name__ == "__main__":
    unittest.main()

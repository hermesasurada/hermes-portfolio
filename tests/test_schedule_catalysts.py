"""일정표 촉매(2026-11-22): 판정이 끝난 촉매는 원래 기한에 다시 나오지 않는다(ANT 상장 11-19 → 기한 11-26 표시 사고)."""
import unittest
from datetime import date
from unittest import mock

from portfolio_core import company_events, schedule

META = {"ANT": {"ticker": "ANT", "name": "Anthropic", "kind": "stock", "market_cap_currency": "USD", "market_cap": 1}}


def ev(title, when, **extra):
    return {"kind": "catalyst", "date": when, "date_precision": "day", "bucket": "upcoming",
            "attribution": "extracted", "title": title, **extra}


class ScheduleCatalystTests(unittest.TestCase):
    def rows(self, events):
        data = {"companies": {"ANT": {"events": events}}}
        with mock.patch.object(company_events, "_cache", return_value=data):
            return schedule._catalysts(META, set(), date(2026, 11, 1), date(2026, 12, 31), lambda *a: None)

    def test_resolved_catalyst_is_excluded(self):
        rows = self.rows([
            ev("Anthropic 상장", "2026-11-26", bucket="resolved", status="충족"),
            ev("Microsoft–Anthropic 연산 계약 개시", "2026-11-30"),
        ])
        self.assertEqual([r["title"] for r in rows], ["Microsoft–Anthropic 연산 계약 개시"])

    def test_existing_filters_kept(self):
        rows = self.rows([
            ev("실적", "2026-11-20", attribution="portfolio_db"),
            ev("감사 제외", "2026-11-21", audit="calendar_unsupported"),
            ev("월 단위", "2026-11-01", date_precision="month"),
            ev("기한 경과 미판정", "2026-11-10", bucket="overdue_unresolved"),
        ])
        self.assertEqual([r["title"] for r in rows], ["기한 경과 미판정"])


if __name__ == "__main__":
    unittest.main()

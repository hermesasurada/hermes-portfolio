"""증류 촉매·일정(2026-11-08): 캐시 파일만 읽고, 티커는 정확 일치, 파일이 바뀌면 다시 읽고, 묶음은 오늘 기준으로 다시 나눈다."""
import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from portfolio_core import company_events as C

TODAY = date(2026, 11, 8)


def ev(bucket, when=None, attribution="extracted", **extra):
    return {"bucket": bucket, "date": when, "attribution": attribution, "title": "t", **extra}


class CompanyEventsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "company-events.latest.json"
        patcher = mock.patch.object(C, "cache_path", return_value=self.path)
        patcher.start()
        self.addCleanup(patcher.stop)
        C._loaded = (0, {})

    def write(self, companies, stamp, **top):
        data = {"as_of": "2026-11-08", "serving": {"report_as_of": "2026-11-01", "refreshed_at": "R"}, "companies": companies, **top}
        self.path.write_text(json.dumps(data), encoding="utf-8")
        os.utime(self.path, (stamp, stamp))

    def test_missing_file_is_null_company(self):
        self.assertIsNone(C.load_company_events("MU")["company"])
        self.assertIsNone(C.company_events_summary("MU"))

    def test_exact_ticker_only(self):
        self.write({"2382.TW": {"events": [ev("upcoming", "2026-12-01")]}}, 1000)
        self.assertIsNotNone(C.load_company_events("2382.TW")["company"])
        self.assertIsNone(C.load_company_events("2382.HK")["company"])
        self.assertIsNone(C.load_company_events("2382")["company"])
        self.assertEqual(C.load_company_events("2382.TW")["as_of"], "2026-11-01")   # 리포트 기준일

    def test_reload_on_change(self):
        self.write({"MU": {"events": [ev("upcoming", "2026-12-01")]}}, 1000)
        self.assertEqual(C.company_events_summary("MU", TODAY)["count"], 1)
        self.write({"MU": {"events": [ev("upcoming", "2026-12-01"), ev("undated")]}}, 2000)
        self.assertEqual(C.company_events_summary("MU", TODAY)["count"], 2)

    def test_earnings_only_still_shows_button(self):
        self.write({"MMM": {"events": [ev("upcoming", "2026-12-01", "portfolio_db")]}}, 1000)
        self.assertEqual(C.company_events_summary("MMM", TODAY), {"count": 1, "upcoming": 1})
        self.write({"MMM": {"events": []}}, 2000)
        self.assertIsNone(C.company_events_summary("MMM", TODAY))
        self.assertIsNotNone(C.load_company_events("MMM", TODAY)["company"])

    def test_rebucket_by_today(self):
        self.write({"MU": {"events": [
            ev("upcoming", "2026-11-05"),            # 지난주 기준 예정 → 오늘은 기한 경과
            ev("upcoming", "2026-11-20"),
            ev("overdue_unresolved", "2026-09-01"),  # 45일 초과 → 재확인
            ev("undated"), ev("resolved", "2026-10-30"),
        ]}}, 1000)
        got = C.load_company_events("MU", TODAY)["company"]
        # 7일 이상 지난 09-01(stale)·10-30(resolved)은 빠진다
        self.assertEqual([e["bucket"] for e in got["events"]], ["overdue_unresolved", "upcoming", "undated"])
        self.assertEqual(got["events"][0]["source_bucket"], "upcoming")
        self.assertEqual(got["counts"]["upcoming"], 1)
        self.assertEqual(got["counts"]["stale"], 0)
        self.assertEqual(got["next_date"], "2026-11-20")
        self.assertEqual(C.company_events_summary("MU", TODAY), {"count": 3, "upcoming": 1})

    def test_hide_events_a_week_past(self):
        self.write({"AAA": {"events": [ev("overdue_unresolved", "2026-11-02"), ev("overdue_unresolved", "2026-11-01")]},
                    "BBB": {"events": [ev("stale", "2026-08-01")]}}, 1000)
        dates = [e["date"] for e in C.load_company_events("AAA", TODAY)["company"]["events"]]
        self.assertEqual(dates, ["2026-11-02"])       # 6일 경과는 남고 7일 경과는 빠진다
        self.assertIsNone(C.company_events_summary("BBB", TODAY))   # 남는 일정이 없으면 버튼도 없다


if __name__ == "__main__":
    unittest.main()

"""갓 상장한 종목의 분할 조회 폴백(2026-11-20 ANT 상장 다음 날 '주식분할 캐시 실패' 경보).

야후는 이력이 며칠뿐인 종목에 period=max를 거부하고 yfinance 1.3은 그걸 AttributeError로 터뜨린다.
1년 창으로 다시 보고, '분할 없음'일 때만 빈 결과로 받아들인다.
"""
import sys
import types
import unittest

from portfolio_core import corporate_actions


class FakeSeries:
    def __init__(self, rows):
        self.rows = rows

    @property
    def empty(self):
        return not self.rows

    def items(self):
        return iter(self.rows)


def install_fake_yfinance(behaviour):
    calls = []

    class Ticker:
        def __init__(self, symbol):
            self.symbol = symbol

        def get_splits(self, period):
            calls.append(period)
            result = behaviour[period]
            if isinstance(result, Exception):
                raise result
            return result

    sys.modules["yfinance"] = types.SimpleNamespace(Ticker=Ticker)
    return calls


class SplitFetchNewListingTest(unittest.TestCase):
    def tearDown(self):
        sys.modules.pop("yfinance", None)

    def test_max_rejected_falls_back_to_one_year_without_splits(self):
        calls = install_fake_yfinance({
            "max": AttributeError("'PriceHistory' object has no attribute '_dividends'"),
            "1y": FakeSeries([]),
        })
        self.assertEqual(corporate_actions.fetch_yahoo_stock_splits("ANT"), [])
        self.assertEqual(calls, ["max", "1y"])

    def test_fallback_with_splits_keeps_original_error(self):
        # 1년 창에서 분할이 보이면 전체 이력이 아니므로 믿지 않는다(기존 행 삭제 위험).
        import datetime
        install_fake_yfinance({
            "max": AttributeError("boom"),
            "1y": FakeSeries([(datetime.date(2026, 6, 1), 4.0)]),
        })
        with self.assertRaises(AttributeError):
            corporate_actions.fetch_yahoo_stock_splits("NVDA")

    def test_max_success_does_not_call_fallback(self):
        calls = install_fake_yfinance({"max": FakeSeries([]), "1y": AttributeError("unused")})
        self.assertEqual(corporate_actions.fetch_yahoo_stock_splits("NVDA"), [])
        self.assertEqual(calls, ["max"])


if __name__ == "__main__":
    unittest.main()

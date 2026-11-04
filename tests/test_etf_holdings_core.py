"""ETF 구성종목 캐시 조회(2026-11-04): 수집기 캐시를 그대로 읽고, 파일이 바뀌면 다시 읽는다."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from portfolio_core import etf_holdings as E


class EtfHoldingsCacheTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "etf_holdings.json"
        patcher = mock.patch.object(E, "cache_path", return_value=self.path)
        patcher.start()
        self.addCleanup(patcher.stop)
        names = mock.patch.object(E, "_list_names", return_value={})
        names.start()
        self.addCleanup(names.stop)
        E._loaded = (0, {})

    def write(self, data, stamp):
        self.path.write_text(json.dumps(data), encoding="utf-8")
        os.utime(self.path, (stamp, stamp))

    def test_missing_cache_is_not_found(self):
        self.assertFalse(E.load_etf_holdings("SMH")["found"])
        self.assertFalse(E.etf_holdings_available("AAPL", "Apple"))

    def test_rows_and_marks(self):
        self.write({"SMH": {"source": "VanEck 공식", "url": "https://v", "as_of": "2026-11-03", "complete": True,
                            "items": [{"symbol": "NVDA", "name": "NVIDIA", "weight": 19.0, "weight_estimated": True}],
                            "others": [{"name": "Cash", "weight": 0.1, "type": "cash"}]}}, 100)
        got = E.load_etf_holdings(" smh ")
        self.assertTrue(got["found"] and got["complete"])
        self.assertTrue(got["items"][0]["estimated"])
        self.assertEqual(got["others"][0]["name"], "Cash")

    def test_list_names_replace_exact_tickers_only(self):
        self.write({"SMH": {"items": [{"symbol": "005930.KS", "name": "Samsung Electronics Co Ltd", "weight": 3},
                                      {"symbol": "2382.HK", "name": "Sunny Optical", "weight": 2},
                                      {"symbol": "", "name": "No Ticker", "weight": 1}],
                            "others": [{"symbol": "005930.KS", "name": "005930 Swap", "type": "derivative"}]}}, 100)
        with mock.patch.object(E, "_list_names", return_value={"005930.KS": "삼성전자", "2382.TW": "Quanta Computer"}):
            got = E.load_etf_holdings("SMH")
        self.assertEqual([row["name"] for row in got["items"]], ["삼성전자", "Sunny Optical", "No Ticker"])
        self.assertEqual(got["others"][0]["name"], "005930 Swap")

    def test_internal_keys_and_empty_entries_are_hidden(self):
        self.write({"_symbols": {"items": [1]}, "AAA": {"items": []}}, 100)
        self.assertFalse(E.load_etf_holdings("_symbols")["found"])
        self.assertFalse(E.load_etf_holdings("AAA")["found"])

    def test_available_covers_collected_and_named_etfs(self):
        self.write({"1623.T": {"items": [{"name": "A"}]}}, 100)
        self.assertTrue(E.etf_holdings_available("1623.T", "일본 철강·비철금속"))   # 이름으로는 안 잡힌다
        self.assertTrue(E.etf_holdings_available("069500.KS", "KODEX 200"))
        self.assertFalse(E.etf_holdings_available("AAPL", "Apple"))

    def test_rereads_when_file_changes(self):
        self.write({"AAA": {"items": [{"name": "old"}]}}, 100)
        self.assertEqual(E.load_etf_holdings("AAA")["items"][0]["name"], "old")
        self.write({"AAA": {"items": [{"name": "new"}]}}, 200)
        self.assertEqual(E.load_etf_holdings("AAA")["items"][0]["name"], "new")


if __name__ == "__main__":
    unittest.main()

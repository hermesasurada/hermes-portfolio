"""한국 종목 조회(2026-11-09): 네이버 상세 API가 404·네트워크 오류를 내도 예외를 올리지 않고 KRX 상장목록으로 넘어간다."""
import unittest
import urllib.error
from unittest import mock

from portfolio_core import ticker_lookup


class KoreanLookupFallbackTests(unittest.TestCase):
    def test_naver_http_error_returns_none(self):
        error = urllib.error.HTTPError("https://stock.naver.com/x", 404, "Not Found", {}, None)
        with mock.patch.object(ticker_lookup.urllib.request, "urlopen", side_effect=error):
            self.assertIsNone(ticker_lookup.lookup_korean_ticker("0183J0.KS"))

    def test_lookup_ticker_falls_back_to_krx_listing(self):
        krx = {"ticker": "0183J0.KS", "name": "TIGER 미국우주테크", "currency": "KRW", "category": "kr", "region": "KR"}
        with mock.patch.object(ticker_lookup.urllib.request, "urlopen", side_effect=OSError("down")), \
             mock.patch.object(ticker_lookup, "lookup_krx_listing", return_value=krx), \
             mock.patch.object(ticker_lookup, "connect") as connect:
            connect.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = None
            self.assertEqual(ticker_lookup.lookup_ticker("0183J0.KS")["name"], "TIGER 미국우주테크")


if __name__ == "__main__":
    unittest.main()

"""웹 요청은 외부 시세를 오래 기다리지 않는다(2026-11-11).

2026-10-21 DNS 장애 때 /api/portfolio가 요청 안에서 Yahoo 배치·yfinance 폴백의 30초 타임아웃을
줄줄이 기다려 90~180초 걸렸다. 이제 받는 일은 늘 백그라운드에서 하고, 요청은 정해진 시간만 기다린다."""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import portfolio_core.db as _db_module
_TEST_DB_DIR = tempfile.TemporaryDirectory(prefix="portfolio-test-")
_db_module.DB_PATH = Path(_TEST_DB_DIR.name) / "stock_history.db"
_db_module.initialize_schema()

import portfolio_core.kr_live_quotes as k  # noqa: E402
import portfolio_core.us_live_quotes as m  # noqa: E402
from portfolio_core.single_flight import SingleFlight  # noqa: E402


def wait_idle(flight: SingleFlight) -> None:
    for thread in threading.enumerate():
        if thread.name == f"{flight.name}-refresh":
            thread.join(timeout=10)


class UsLiveDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.saved = {name: getattr(m, name) for name in (
            "yahoo_quote_batch", "load_shared_quote_rows", "schedule_us_live_fallback",
            "US_LIVE_WAIT_SECONDS", "same_market_day")}
        self.cache = dict(m.US_LIVE_QUOTE_CACHE)
        m.US_LIVE_QUOTE_CACHE.clear()
        m.US_LIVE_UNRESOLVED_UNTIL.clear()
        m._NETWORK_PAUSED_UNTIL = 0.0
        m.load_shared_quote_rows = lambda symbols: {}
        m.schedule_us_live_fallback = lambda *args: None
        m.US_LIVE_WAIT_SECONDS = 0.2

    def tearDown(self):
        wait_idle(m.US_LIVE_REFRESH)
        for name, value in self.saved.items():
            setattr(m, name, value)
        m.US_LIVE_QUOTE_CACHE.clear()
        m.US_LIVE_QUOTE_CACHE.update(self.cache)
        m.US_LIVE_UNRESOLVED_UNTIL.clear()
        m._NETWORK_PAUSED_UNTIL = 0.0

    def test_slow_batch_does_not_hold_the_request(self):
        release = threading.Event()

        def slow_batch(symbols):
            release.wait(5)
            return {s: {"symbol": s, "regularMarketPrice": 999.0, "marketState": "REGULAR"} for s in symbols}

        m.yahoo_quote_batch = slow_batch
        m.same_market_day = lambda a, b: True
        stale = {"price": 100.0, "fetched_ts": time.time() - 3600}
        m.US_LIVE_QUOTE_CACHE[("AAPL", "regular")] = stale
        started = time.monotonic()
        result = m.fetch_us_live_quotes(["AAPL", "MSFT"], include_extended=False, regular_hours=True)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertIs(result["AAPL"], stale)      # 같은 거래일의 묵은 값
        self.assertNotIn("MSFT", result)          # 캐시도 없으면 DB 종가에 맡긴다
        release.set()
        wait_idle(m.US_LIVE_REFRESH)
        self.assertEqual(m.US_LIVE_QUOTE_CACHE[("MSFT", "regular")]["price"], 999.0)

    def test_previous_day_cache_is_not_served_as_today(self):
        m.yahoo_quote_batch = lambda symbols: (_ for _ in ()).throw(OSError("nodename nor servname"))
        m.US_LIVE_QUOTE_CACHE[("AAPL", "regular")] = {"price": 100.0, "fetched_ts": time.time() - 3 * 86400}
        result = m.fetch_us_live_quotes(["AAPL"], include_extended=False, regular_hours=True)
        self.assertEqual(result, {})

    def test_batch_failure_pauses_yahoo(self):
        calls = []

        def failing(symbols):
            calls.append(symbols)
            raise OSError("nodename nor servname")

        m.yahoo_quote_batch = failing
        m.fetch_us_live_quotes(["AAPL"], include_extended=False, regular_hours=True)
        wait_idle(m.US_LIVE_REFRESH)
        self.assertTrue(m.network_paused())
        m.fetch_us_live_quotes(["AAPL"], include_extended=False, regular_hours=True)
        wait_idle(m.US_LIVE_REFRESH)
        self.assertEqual(len(calls), 1)

    def test_shared_db_rows_still_serve_while_paused(self):
        m._NETWORK_PAUSED_UNTIL = time.time() + 60
        m.yahoo_quote_batch = lambda symbols: self.fail("paused — no network")
        m.load_shared_quote_rows = lambda symbols: {"AAPL": {"regularMarketPrice": 150.0, "_shared_fetched_ts": time.time()}}
        result = m.fetch_us_live_quotes(["AAPL"], include_extended=False, regular_hours=True)
        self.assertEqual(result["AAPL"]["price"], 150.0)


class UsFallbackTests(unittest.TestCase):
    def setUp(self):
        self.yf = sys.modules.get("yfinance")
        m.US_LIVE_UNRESOLVED_UNTIL.clear()
        m._NETWORK_PAUSED_UNTIL = 0.0

    def tearDown(self):
        if self.yf is None:
            sys.modules.pop("yfinance", None)
        else:
            sys.modules["yfinance"] = self.yf
        m.US_LIVE_UNRESOLVED_UNTIL.clear()
        m._NETWORK_PAUSED_UNTIL = 0.0
        for symbol in ("AAA", "BBB", "CCC", "DDD"):
            m.US_LIVE_QUOTE_CACHE.pop((symbol, "regular"), None)

    def install_yf(self, info_for):
        calls = []

        class Ticker:
            def __init__(self, symbol):
                self.symbol = symbol

            @property
            def info(self):
                calls.append(self.symbol)
                return info_for(self.symbol)

        sys.modules["yfinance"] = type(sys)("yfinance")
        sys.modules["yfinance"].Ticker = Ticker
        return calls

    def test_fallback_stops_after_consecutive_errors(self):
        def info_for(symbol):
            raise OSError("Resolving timed out after 30000 milliseconds")

        calls = self.install_yf(info_for)
        m.fetch_us_live_fallback_worker(["AAA", "BBB", "CCC", "DDD"], "regular", False, True)
        self.assertEqual(calls, ["AAA", "BBB"])
        self.assertTrue(m.network_paused())

    def test_unresolved_symbol_is_not_retried_for_a_while(self):
        calls = self.install_yf(lambda symbol: {} if symbol == "AAA" else {"regularMarketPrice": 5.0})
        m.fetch_us_live_fallback_worker(["AAA", "BBB"], "regular", False, True)
        self.assertEqual(m.US_LIVE_QUOTE_CACHE[("BBB", "regular")]["price"], 5.0)
        self.assertIn(("AAA", "regular"), m.US_LIVE_UNRESOLVED_UNTIL)
        started = []
        original_thread = m.threading.Thread
        m.threading.Thread = lambda target, args, daemon: type("T", (), {"start": lambda self: started.append(args[0])})()
        try:
            m.schedule_us_live_fallback(["AAA", "BBB"], "regular", False, True)
        finally:
            m.threading.Thread = original_thread
        self.assertEqual(started, [["BBB"]])
        self.assertEqual(calls, ["AAA", "BBB"])


class NxtDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.saved = (k._fetch_one, k.NXT_WAIT_SECONDS, dict(k._QUOTE_CACHE))
        k._QUOTE_CACHE.clear()
        k._FAILED_UNTIL.clear()
        k.NXT_WAIT_SECONDS = 0.2

    def tearDown(self):
        wait_idle(k.NXT_REFRESH)
        k._fetch_one, k.NXT_WAIT_SECONDS, cache = self.saved
        k._QUOTE_CACHE.clear()
        k._QUOTE_CACHE.update(cache)
        k._FAILED_UNTIL.clear()

    def test_slow_nxt_does_not_hold_the_request(self):
        release = threading.Event()
        k._fetch_one = lambda code: (release.wait(5), None)[1]
        started = time.monotonic()
        self.assertEqual(k.fetch_nxt_quotes(["005930.KS"]), {})
        self.assertLess(time.monotonic() - started, 1.5)
        release.set()

    def test_failed_code_cools_down(self):
        import urllib.request
        calls = []
        original = urllib.request.urlopen

        def boom(*args, **kwargs):
            calls.append(1)
            raise OSError("dns")

        urllib.request.urlopen = boom
        try:
            k.fetch_nxt_quotes(["005930.KS"])
            wait_idle(k.NXT_REFRESH)
            k.fetch_nxt_quotes(["005930.KS"])
            wait_idle(k.NXT_REFRESH)
        finally:
            urllib.request.urlopen = original
        self.assertEqual(len(calls), 1)
        self.assertIn("005930", k._FAILED_UNTIL)


class SingleFlightWaitTests(unittest.TestCase):
    def test_waits_for_key_started_by_someone_else(self):
        flight = SingleFlight("w")
        gate = threading.Event()
        flight.run(["a"], lambda keys: gate.wait(5))
        threading.Timer(0.1, gate.set).start()
        self.assertTrue(flight.run_and_wait(["a"], lambda keys: self.fail("already running"), timeout=3))
        self.assertFalse(flight.in_flight("a"))

    def test_gives_up_at_the_deadline(self):
        flight = SingleFlight("w2")
        gate = threading.Event()
        started = time.monotonic()
        self.assertFalse(flight.run_and_wait(["a"], lambda keys: gate.wait(5), timeout=0.1))
        self.assertLess(time.monotonic() - started, 1)
        gate.set()
        wait_idle(flight)
        self.assertFalse(flight.in_flight("a"))


if __name__ == "__main__":
    unittest.main()

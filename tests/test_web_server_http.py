"""웹서버 요청 경계(2026-11-11): 라우팅 표·정적 파일·잘못된 POST 본문을 실제 소켓으로 확인한다.
핸들러 함수만 부르는 테스트로는 read_json·_dispatch·send_file이 한 번도 실행되지 않았다."""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 운영 DB 격리 — test_portfolio_core.py와 같은 방식.
import portfolio_core.db as _db_module
_TEST_DB_DIR = tempfile.TemporaryDirectory(prefix="portfolio-test-")
_db_module.DB_PATH = Path(_TEST_DB_DIR.name) / "stock_history.db"
_db_module.initialize_schema()

import portfolio_web_server as server


class HttpBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.PortfolioHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def post(self, path, raw, headers=None):
        status, _, body = self.request("POST", path, raw, {"Content-Type": "application/json", **(headers or {})})
        return status, json.loads(body)

    def test_every_handler_is_routed_once(self):
        handlers = {name for name in vars(server.Handler) if name.startswith(("api_", "post_"))}
        routed = [fn.__name__ for fn in (*server.Handler.GET_ROUTES.values(), *server.Handler.POST_ROUTES.values())]
        self.assertEqual(sorted(routed), sorted(handlers))

    def test_health_and_unknown_path(self):
        status, headers, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(self.request("GET", "/api/nope")[0], 404)
        self.assertEqual(self.request("POST", "/api/nope", b"{}")[0], 404)

    def test_static_file_etag_and_gzip(self):
        status, headers, body = self.request("GET", "/static/format.js")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertEqual(body, (server.STATIC_DIR / "format.js").read_bytes())
        self.assertEqual(self.request("GET", "/static/format.js", headers={"If-None-Match": headers["ETag"]})[0], 304)
        status, gz_headers, gz_body = self.request("GET", "/static/format.js", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(gz_headers["Content-Encoding"], "gzip")
        self.assertNotEqual(gz_headers["ETag"], headers["ETag"])
        self.assertLess(len(gz_body), len(body))

    def test_static_and_logo_stay_inside_their_directories(self):
        self.assertEqual(self.request("GET", "/static/../portfolio_web_server.py")[0], 404)
        self.assertEqual(self.request("GET", "/static/..")[0], 404)
        self.assertEqual(self.request("GET", "/logos/../../stock_history.db")[0], 404)
        self.assertEqual(self.request("GET", "/logos/NOPE.png")[0], 404)

    def test_malformed_post_body_is_400_not_500(self):
        for raw in (b"[1, 2]", b'"text"', b"{broken", b"\xff\xfe"):
            status, payload = self.post("/api/tags", raw)
            self.assertEqual((status, payload["error"]), (400, server.BAD_JSON_BODY), raw)
        status, payload = self.post("/api/tags", b"{}", {"Content-Length": "abc"})
        self.assertEqual((status, payload["error"]), (400, server.BAD_JSON_BODY))
        status, payload = self.post("/api/tags", b"{}", {"Content-Length": str(server.MAX_JSON_BODY_BYTES + 1)})
        self.assertEqual(status, 400)

    def test_post_requires_json_content_type(self):
        with mock.patch.object(server, "set_ticker_tags") as save:
            for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"):
                status, _, body = self.request("POST", "/api/tags", b'{"ticker": "MU"}', {"Content-Type": content_type})
                self.assertEqual((status, json.loads(body)["error"]), (415, server.POST_NEEDS_JSON), content_type)
            status, _, _ = self.request("POST", "/api/tags", b'{"ticker": "MU"}')
            self.assertEqual(status, 415)
        save.assert_not_called()

    def test_post_from_another_site_is_refused(self):
        host = f"127.0.0.1:{self.httpd.server_address[1]}"
        with mock.patch.object(server, "set_ticker_tags", return_value={"ok": True}) as save:
            for origin in ("http://evil.example", "null", f"http://{host}.evil.example", f"file://{host}"):
                status, payload = self.post("/api/tags", b"{}", {"Origin": origin})
                self.assertEqual((status, payload["error"]), (403, server.CROSS_SITE_POST), origin)
            save.assert_not_called()
            self.assertEqual(self.post("/api/tags", b"{}", {"Origin": f"http://{host}"}), (200, {"ok": True}))
            self.assertEqual(self.post("/api/tags", b"{}", {"Content-Type": "application/json; charset=utf-8"}), (200, {"ok": True}))
        self.assertEqual(save.call_count, 2)

    def test_rebuild_rejects_non_list_account_ids(self):
        with mock.patch.object(server, "rebuild_account_snapshots") as rebuild:
            status, payload = self.post("/api/performance/rebuild", b'{"account_ids": "12"}')
        self.assertEqual(status, 400)
        rebuild.assert_not_called()

    def test_value_error_is_400_and_unexpected_error_is_500(self):
        with mock.patch.object(server, "lookup_ticker", side_effect=ValueError("종목을 찾지 못했습니다.")):
            status, _, body = self.request("GET", "/api/watchlist/lookup?q=zzz")
        self.assertEqual((status, json.loads(body)["error"]), (400, "종목을 찾지 못했습니다."))
        with mock.patch.object(server, "lookup_ticker", side_effect=RuntimeError("boom")), \
             mock.patch.object(server.logging, "exception") as logged:
            status, _, body = self.request("GET", "/api/watchlist/lookup?q=zzz")
        self.assertEqual((status, json.loads(body)["error"]), (500, "Internal Server Error"))
        logged.assert_called_once()


class RequestHelperTests(unittest.TestCase):
    def test_query_helpers(self):
        query = {"ticker": ["MU", "NVDA"], "lite": ["true"], "compact": ["0"]}
        self.assertEqual(server.query_first(query, "ticker"), "MU")
        self.assertIsNone(server.query_first(query, "range"))
        self.assertEqual(server.query_first(query, "q", ""), "")
        self.assertTrue(server.query_flag(query, "lite"))
        self.assertFalse(server.query_flag(query, "compact"))
        self.assertFalse(server.query_flag(query, "us_extended"))

    def test_parse_json_body_accepts_only_objects(self):
        self.assertEqual(server.parse_json_body('{"메모": "가"}'.encode("utf-8")), {"메모": "가"})
        for raw in (b"null", b"3", b"[]", b""):
            with self.assertRaises(ValueError):
                server.parse_json_body(raw)

    def test_dropped_connection_is_not_logged_as_failure(self):
        httpd = server.PortfolioHTTPServer.__new__(server.PortfolioHTTPServer)
        with mock.patch.object(server.logging, "exception") as logged:
            for exc in (ConnectionResetError(54, "reset"), BrokenPipeError(32, "pipe")):
                try:
                    raise exc
                except ConnectionError:
                    httpd.handle_error(None, ("127.0.0.1", 1))
            logged.assert_not_called()
            try:
                raise RuntimeError("boom")
            except RuntimeError:
                httpd.handle_error(None, ("127.0.0.1", 1))
            logged.assert_called_once()


class OpsSetupTests(unittest.TestCase):
    def test_open_file_limit_is_raised_within_hard_limit(self):
        import resource
        before = resource.getrlimit(resource.RLIMIT_NOFILE)
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (256, before[1]))
            soft = server.raise_open_file_limit(1024)
            self.assertEqual(resource.getrlimit(resource.RLIMIT_NOFILE)[0], soft)
            self.assertGreaterEqual(soft, min(1024, before[1]))
        finally:
            resource.setrlimit(resource.RLIMIT_NOFILE, before)

    def test_request_log_rotates_and_stderr_gets_warnings_only(self):
        import logging
        root = logging.getLogger()
        saved = (list(root.handlers), root.level)
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "web.log"
            try:
                with mock.patch.object(server, "WEB_LOG_MAX_BYTES", 200):
                    server.configure_logging(log_path)
                stderr = [h for h in root.handlers if type(h) is logging.StreamHandler]
                self.assertEqual([h.level for h in stderr], [logging.WARNING])
                for i in range(20):
                    logging.info("GET /api/portfolio 200 0.01s %d", i)
                self.assertTrue(log_path.exists())
                self.assertTrue((Path(tmp) / "web.log.1").exists())
            finally:
                for handler in list(root.handlers):
                    root.removeHandler(handler)
                    handler.close()
                for handler in saved[0]:
                    root.addHandler(handler)
                root.setLevel(saved[1])


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Interactive portfolio web page served from the local stock_history DB."""

from __future__ import annotations

import argparse
import json
import logging
import math
import mimetypes
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from portfolio_core.charts import load_account_performance, load_price_chart
from portfolio_core.constants import KOREAN_ETF_BRANDS, KOREAN_SUFFIXES, LOCAL_MARKET_SUFFIXES
from portfolio_core.db import connect, initialize_schema
from portfolio_core.queries import load_collection_diagnostics, load_ticker_directory
from portfolio_core.logos import is_dark_logo
from portfolio_core.dividends import load_dividend_history, load_dividends
from portfolio_core.interest_watchlists import (
    add_interest_item,
    create_interest_group,
    delete_interest_group,
    delete_interest_item,
    load_interest_watchlists,
    reorder_interest_groups,
    rename_interest_group,
)
from portfolio_core.paths import DB_PATH, LOGO_DIR
from portfolio_core.portfolio import load_portfolio as load_portfolio_data
from portfolio_core.prices import load_ticker_changes
from portfolio_core.stats import load_stats
from portfolio_core.tickers import asset_class
from portfolio_core.transactions import add_transaction, delete_transaction, load_transactions, update_transaction
from portfolio_core.watchlist import add_watchlist_async, is_registered_ticker, lookup_ticker


def badge_text(ticker: str, name: str) -> str:
    words = [word for word in (name or "").replace("&", " ").split() if word]
    ascii_words = [word for word in words if word[0].isascii() and word[0].isalnum()]
    if len(ascii_words) >= 2:
        return (ascii_words[0][0] + ascii_words[1][0]).upper()
    if ascii_words:
        return ascii_words[0][:2].upper()
    compact_name = "".join(ch for ch in (name or "") if not ch.isspace())
    if compact_name:
        return compact_name[:2].upper()
    return ticker.replace(".KS", "").replace(".KQ", "")[:2].upper()


def logo_stem(ticker: str) -> str:
    safe = "".join(ch if ch.isalnum() else "_" for ch in ticker.upper())
    return safe


# Short-TTL cache so a portfolio render doesn't stat the logo dir once per
# ticker on every request; new logos appear within the TTL window. (#7)
_LOGO_URL_CACHE: dict[str, tuple[float, str | None]] = {}
_LOGO_URL_TTL = 60.0
SVG_PREFERRED_LOGOS = frozenset(
    {
        # FMP numeric ticker lookup can return unrelated overseas listings.
        # These have local curated SVGs and should not be shadowed by PNG.
        "SPCX",  # SpaceX
        "018260.KS",  # 삼성SDS
        "042660.KS",  # 한화오션
        "108490.KS",  # 로보티즈
        "175330.KS",  # JB금융지주
        "263750.KS",  # 펄어비스
        "298040.KS",  # 효성중공업
        "079550.KS",  # LIG디펜스앤에어로스페이스
        "010120.KS",  # LS ELECTRIC
        "HWM",  # Howmet Aerospace
        "MEDP",  # Medpace Holdings
        "FSLR",  # First Solar
        *KOREAN_ETF_BRANDS,
    }
)


def logo_url(ticker: str) -> str | None:
    now = time.time()
    cached = _LOGO_URL_CACHE.get(ticker)
    if cached and now - cached[0] < _LOGO_URL_TTL:
        return cached[1]
    stem = logo_stem(ticker)
    url = None
    extensions = ("svg", "png") if ticker in SVG_PREFERRED_LOGOS else ("png", "svg")
    for ext in extensions:
        logo_path = LOGO_DIR / f"{stem}.{ext}"
        if logo_path.exists():
            url = f"/logos/{logo_path.name}?v={int(logo_path.stat().st_mtime)}"
            break
    _LOGO_URL_CACHE[ticker] = (now, url)
    return url


def logo_hint(ticker: str, name: str) -> dict[str, str | bool | None]:
    cls = asset_class(ticker, name)
    upper_name = (name or ticker).upper()
    dark = is_dark_logo(ticker)
    if cls == "crypto":
        return {"kind": "crypto", "text": "₿", "url": logo_url(ticker), "dark": dark}
    for brand in KOREAN_ETF_BRANDS:
        if ticker.endswith(KOREAN_SUFFIXES) and upper_name.startswith(brand):
            return {"kind": "etf", "text": brand[:2], "url": logo_url(brand), "dark": is_dark_logo(brand)}
    clean_ticker = ticker.replace(".KS", "").replace(".KQ", "")
    if ticker.endswith(LOCAL_MARKET_SUFFIXES):
        text = badge_text(ticker, name)
    else:
        text = clean_ticker[:2].upper()
    return {
        "kind": cls,
        "text": text,
        "url": logo_url(ticker),
        "dark": dark,
    }


def load_portfolio(us_extended: bool = False) -> dict:
    return load_portfolio_data(us_extended=us_extended, logo_hint_fn=logo_hint)


def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


STATIC_DIR = Path(__file__).with_name("portfolio_static")
INDEX_HTML = STATIC_DIR / "index.html"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def request_elapsed(self) -> float:
        return time.perf_counter() - getattr(self, "_request_started_at", time.perf_counter())

    def should_log_access(self, status: int | str) -> bool:
        try:
            status_code = int(status)
        except (TypeError, ValueError):
            status_code = 0
        if status_code >= 400:
            return True
        if self.path.startswith(("/static/", "/logos/")):
            return self.request_elapsed() >= 1.0
        return True

    def log_access(self, status: int | str, body_len: int = 0) -> None:
        if not self.should_log_access(status):
            return
        logging.info(
            "%s %s %s %.3fs %dB client=%s",
            self.command,
            self.path,
            status,
            self.request_elapsed(),
            body_len,
            self.client_address[0] if self.client_address else "-",
        )

    def log_client_abort(self, status: int | str, body_len: int = 0) -> None:
        logging.warning(
            "%s %s client-aborted %.3fs status=%s %dB client=%s",
            self.command,
            self.path,
            self.request_elapsed(),
            status,
            body_len,
            self.client_address[0] if self.client_address else "-",
        )

    def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            self.log_client_abort(status, len(body))
            raise
        self.log_access(status, len(body))

    def send_json(self, payload: dict, status: int = 200) -> None:
        self.send_bytes(
            json.dumps(json_safe(payload), ensure_ascii=False, allow_nan=False).encode("utf-8"),
            "application/json; charset=utf-8",
            status,
        )

    def send_file(self, file_path: Path, content_type: str | None = None, cache_control: str = "no-store") -> bool:
        if not file_path.exists() or not file_path.is_file():
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)
            return True
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            self.log_client_abort(200, len(body))
            raise
        self.log_access(200, len(body))
        return True

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_static(self, name: str) -> bool:
        static_path = (STATIC_DIR / name).resolve()
        try:
            static_path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)
            return True
        # 폰트(2MB woff2)는 거의 안 바뀌므로 no-store 예외 — 하루 캐시
        if static_path.suffix == ".woff2":
            return self.send_file(static_path, "font/woff2", cache_control="public, max-age=86400")
        return self.send_file(static_path)

    def send_logo(self, name: str) -> bool:
        logo_path = (LOGO_DIR / name).resolve()
        try:
            logo_path.relative_to(LOGO_DIR.resolve())
        except ValueError:
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)
            return True
        if not logo_path.exists() or not logo_path.is_file():
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)
            return True
        content_type = mimetypes.guess_type(str(logo_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(logo_path.stat().st_size))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        body = logo_path.read_bytes()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            self.log_client_abort(200, len(body))
            raise
        self.log_access(200, len(body))
        return True

    def query_values(self, query: dict[str, list[str]], key: str) -> list[str]:
        values: list[str] = []
        for value in query.get(key) or []:
            values.extend(part for part in value.split(",") if part)
        return values

    def api_portfolio(self, query: dict[str, list[str]]) -> dict:
        us_extended = (query.get("us_extended") or ["0"])[0] in {"1", "true", "yes", "on"}
        return load_portfolio(us_extended=us_extended)

    def api_stats(self, query: dict[str, list[str]]) -> dict:
        return load_stats(self.query_values(query, "tickers"))

    def api_changes(self, query: dict[str, list[str]]) -> dict:
        # 종목별 등락폭만 내부 DB에서 계산 (외부 호출 없음). ?tickers=A,B 로 선택 조회.
        return load_ticker_changes(self.query_values(query, "tickers") or None)

    def api_tickers(self, query: dict[str, list[str]]) -> dict:
        # DB 등록 종목 목록 (비교 검색 자동완성용). DB 전용.
        with connect() as conn:
            return {"tickers": load_ticker_directory(conn)}

    def api_diagnostics(self, query: dict[str, list[str]]) -> dict:
        # 수집 상태 진단 (실패/지연 노출). DB 전용.
        with connect() as conn:
            return load_collection_diagnostics(conn)

    def api_chart(self, query: dict[str, list[str]]) -> dict:
        ticker = (query.get("ticker") or [""])[0]
        return load_price_chart(ticker)

    def api_account_performance(self, query: dict[str, list[str]]) -> dict:
        return load_account_performance(self.query_values(query, "account_ids"))

    def api_dividends(self, query: dict[str, list[str]]) -> dict:
        return load_dividends(self.query_values(query, "account_ids"))

    def api_dividend_history(self, query: dict[str, list[str]]) -> dict:
        ticker = (query.get("ticker") or [""])[0]
        return load_dividend_history(ticker)

    def api_transactions(self, query: dict[str, list[str]]) -> dict:
        account_id = (query.get("account_id") or [None])[0]
        ticker = (query.get("ticker") or [None])[0]
        return load_transactions(account_id, ticker, self.query_values(query, "account_ids"))

    def api_watchlist_lookup(self, query: dict[str, list[str]]) -> dict:
        q = (query.get("q") or [""])[0]
        found = lookup_ticker(q)
        found["registered"] = is_registered_ticker(found.get("ticker", ""))
        return {"ticker": found}

    def api_interest_watchlists(self, query: dict[str, list[str]]) -> dict:
        return load_interest_watchlists()

    def post_transactions(self) -> dict:
        return add_transaction(self.read_json(), portfolio_loader=load_portfolio)

    def post_transaction_update(self) -> dict:
        return update_transaction(self.read_json())

    def post_transaction_delete(self) -> dict:
        return delete_transaction(self.read_json())

    def post_watchlist(self) -> dict:
        payload = self.read_json()
        return add_watchlist_async(payload.get("tickers") or [])

    def post_interest_group(self) -> dict:
        return create_interest_group(self.read_json())

    def post_interest_group_delete(self) -> dict:
        return delete_interest_group(self.read_json())

    def post_interest_group_rename(self) -> dict:
        return rename_interest_group(self.read_json())

    def post_interest_group_reorder(self) -> dict:
        return reorder_interest_groups(self.read_json())

    def post_interest_item(self) -> dict:
        return add_interest_item(self.read_json())

    def post_interest_item_delete(self) -> dict:
        return delete_interest_item(self.read_json())

    def _dispatch(self, verb: str, handler) -> None:
        """GET/POST 공통 에러 처리: 끊긴 파이프 무시, ValueError→400, 그 외→로그+500."""
        try:
            handler()
        except BrokenPipeError:
            return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception:
            logging.exception("%s %s failed", verb, self.path)
            try:
                self.send_json({"error": HTTPStatus.INTERNAL_SERVER_ERROR.phrase}, 500)
            except BrokenPipeError:
                return

    def do_GET(self) -> None:
        self._request_started_at = time.perf_counter()
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        def handle() -> None:
            if path.startswith("/static/"):
                self.send_static(Path(path).name)
                return
            if path.startswith("/logos/"):
                self.send_logo(Path(path).name)
                return
            get_routes = {
                "/api/portfolio": self.api_portfolio,
                "/api/stats": self.api_stats,
                "/api/changes": self.api_changes,
                "/api/tickers": self.api_tickers,
                "/api/diagnostics": self.api_diagnostics,
                "/api/chart": self.api_chart,
                "/api/account-performance": self.api_account_performance,
                "/api/dividends": self.api_dividends,
                "/api/dividend-history": self.api_dividend_history,
                "/api/transactions": self.api_transactions,
                "/api/watchlist/lookup": self.api_watchlist_lookup,
                "/api/interest-watchlists": self.api_interest_watchlists,
            }
            if path in get_routes:
                self.send_json(get_routes[path](query))
                return
            if path in {"/", "/index.html"}:
                self.send_file(INDEX_HTML, "text/html; charset=utf-8")
                return
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)

        self._dispatch("GET", handle)

    def do_POST(self) -> None:
        self._request_started_at = time.perf_counter()
        path = urlparse(self.path).path

        def handle() -> None:
            post_routes = {
                "/api/transactions": self.post_transactions,
                "/api/transactions/update": self.post_transaction_update,
                "/api/transactions/delete": self.post_transaction_delete,
                "/api/watchlist": self.post_watchlist,
                "/api/interest-watchlists/groups": self.post_interest_group,
                "/api/interest-watchlists/groups/rename": self.post_interest_group_rename,
                "/api/interest-watchlists/groups/reorder": self.post_interest_group_reorder,
                "/api/interest-watchlists/groups/delete": self.post_interest_group_delete,
                "/api/interest-watchlists/items": self.post_interest_item,
                "/api/interest-watchlists/items/delete": self.post_interest_item_delete,
            }
            if path in post_routes:
                self.send_json(post_routes[path]())
                return
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)

        self._dispatch("POST", handle)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s")
    initialize_schema()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving portfolio web page on http://{args.host}:{args.port}")
    print(f"DB: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()

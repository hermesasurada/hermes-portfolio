#!/usr/bin/env python3
"""Interactive portfolio web page served from the local stock_history DB."""

from __future__ import annotations

import argparse
import json
import logging
import math
import mimetypes
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from portfolio_core.charts import load_account_performance, load_price_chart
from portfolio_core.constants import KOREAN_ETF_BRANDS, LOCAL_MARKET_SUFFIXES
from portfolio_core.db import initialize_schema
from portfolio_core.dividends import load_dividends
from portfolio_core.paths import DB_PATH, LOGO_DIR
from portfolio_core.portfolio import load_portfolio as load_portfolio_data
from portfolio_core.stats import load_stats
from portfolio_core.tickers import asset_class
from portfolio_core.transactions import add_transaction, load_transactions
from portfolio_core.watchlist import add_watchlist_async, lookup_ticker


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


def logo_url(ticker: str) -> str | None:
    now = time.time()
    cached = _LOGO_URL_CACHE.get(ticker)
    if cached and now - cached[0] < _LOGO_URL_TTL:
        return cached[1]
    stem = logo_stem(ticker)
    url = None
    for ext in ("png", "svg"):
        logo_path = LOGO_DIR / f"{stem}.{ext}"
        if logo_path.exists():
            url = f"/logos/{logo_path.name}?v={int(logo_path.stat().st_mtime)}"
            break
    _LOGO_URL_CACHE[ticker] = (now, url)
    return url


def logo_hint(ticker: str, name: str) -> dict[str, str | None]:
    cls = asset_class(ticker, name)
    upper_name = (name or ticker).upper()
    if cls == "crypto":
        return {"kind": "crypto", "text": "₿", "url": logo_url(ticker)}
    for brand in KOREAN_ETF_BRANDS:
        if brand in upper_name:
            return {"kind": "etf", "text": brand[:2], "url": logo_url(ticker)}
    clean_ticker = ticker.replace(".KS", "").replace(".KQ", "")
    if ticker.endswith(LOCAL_MARKET_SUFFIXES):
        text = badge_text(ticker, name)
    else:
        text = clean_ticker[:2].upper()
    return {
        "kind": cls,
        "text": text,
        "url": logo_url(ticker),
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

    def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

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
        self.wfile.write(body)
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
        self.wfile.write(logo_path.read_bytes())
        return True

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/static/"):
                self.send_static(Path(path).name)
                return
            if path.startswith("/logos/"):
                self.send_logo(Path(path).name)
                return
            if path == "/api/portfolio":
                us_extended = (query.get("us_extended") or ["0"])[0] in {"1", "true", "yes", "on"}
                self.send_json(load_portfolio(us_extended=us_extended))
                return
            if path == "/api/stats":
                tickers = []
                for value in query.get("tickers") or []:
                    tickers.extend(part for part in value.split(",") if part)
                self.send_json(load_stats(tickers))
                return
            if path == "/api/chart":
                ticker = (query.get("ticker") or [""])[0]
                self.send_json(load_price_chart(ticker))
                return
            if path == "/api/account-performance":
                account_ids = []
                for value in query.get("account_ids") or []:
                    account_ids.extend(part for part in value.split(",") if part)
                self.send_json(load_account_performance(account_ids))
                return
            if path == "/api/dividends":
                account_ids = []
                for value in query.get("account_ids") or []:
                    account_ids.extend(part for part in value.split(",") if part)
                self.send_json(load_dividends(account_ids))
                return
            if path == "/api/transactions":
                account_id = (query.get("account_id") or [None])[0]
                ticker = (query.get("ticker") or [None])[0]
                account_ids = []
                for value in query.get("account_ids") or []:
                    account_ids.extend(part for part in value.split(",") if part)
                self.send_json(load_transactions(account_id, ticker, account_ids))
                return
            if path == "/api/watchlist/lookup":
                q = (query.get("q") or [""])[0]
                self.send_json({"ticker": lookup_ticker(q)})
                return
            if path in {"/", "/index.html"}:
                self.send_file(INDEX_HTML, "text/html; charset=utf-8")
                return
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception:
            logging.exception("GET %s failed", self.path)
            self.send_json({"error": "Internal server error"}, 500)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/transactions":
                self.send_json(add_transaction(self.read_json(), portfolio_loader=load_portfolio))
                return
            if path == "/api/watchlist":
                payload = self.read_json()
                self.send_json(add_watchlist_async(payload.get("tickers") or []))
                return
            self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception:
            logging.exception("POST %s failed", self.path)
            self.send_json({"error": "Internal server error"}, 500)


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

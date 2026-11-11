#!/usr/bin/env python3
"""Interactive portfolio web page served from the local stock_history DB."""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import logging.handlers
import math
import mimetypes
import resource
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import lan_guard  # 로컬·Tailscale 외 접속 차단(2026-10-30)
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

from portfolio_core.cash_flows import add_cash_flow, delete_cash_flow, list_cash_flows
from portfolio_core.company_profiles import load_company_profile
from portfolio_core.payload_compact import compact_chart_payload, compact_performance_payload
from portfolio_core.charts import load_account_performance, load_price_chart
from portfolio_core.price_since import load_price_since
from portfolio_core.performance_snapshots import load_account_snapshots, rebuild_account_snapshots
from portfolio_core.constants import (
    KOREAN_ETF_BRANDS,
    KOREAN_SUFFIXES,
    LOCAL_MARKET_SUFFIXES,
)
from portfolio_core.db import connect, initialize_schema
from portfolio_core.company_events import company_events_summary, load_company_events
from portfolio_core.etf_holdings import (
    etf_exposure_count,
    etf_holdings_available,
    load_etf_exposure,
    load_etf_holdings,
    load_etf_universe,
)
from portfolio_core.queries import load_collection_diagnostics, load_ticker_directory
from portfolio_core.schedule import load_schedule
from portfolio_core.logos import KR_ETF_BRAND_SOURCES, SVG_PREFERRED_LOGOS, is_dark_logo
from portfolio_core.dividend_history import load_dividend_history
from portfolio_core.dividends import load_dividends
from portfolio_core.interest_watchlists import (
    add_interest_item,
    create_interest_group,
    delete_interest_group,
    delete_interest_item,
    load_interest_watchlists,
    reorder_interest_groups,
    rename_interest_group,
    set_favorite_item,
)
from portfolio_core.paths import DB_PATH, LOGO_DIR
from portfolio_core.portfolio import load_portfolio as load_portfolio_data
from portfolio_core.stats import empty_quote_stats, load_quote_stats, load_stats
from portfolio_core.tickers import asset_class, kr_ticker_code
from portfolio_core.transactions import add_transaction, delete_transaction, load_transactions, update_transaction, update_transaction_memo
from portfolio_core.ticker_lookup import is_registered_ticker, lookup_ticker
from portfolio_core.ticker_metadata import update_ticker_display_name
from portfolio_core.ticker_tags import load_tags_payload, set_ticker_tags
from portfolio_core.watchlist import add_watchlist_async, unregister_collected_ticker


# 애널리스트 컨센서스는 별도 서비스(analyst-reports, 8767)가 담당한다. 같은
# 맥미니에 있으므로 서버에서 127.0.0.1로 프록시해 브라우저 CORS·IP 하드코딩을
# 없앤다(대시보드를 localhost로 열어도 동작). 서비스가 죽어도 대시보드는 계속
# 뜨도록 실패는 조용히 빈 결과로 처리한다.
ANALYST_QUOTE_URL = "http://127.0.0.1:8767/api/quote"


def fetch_analyst_quotes(tickers: list[str]) -> dict:
    if not tickers:
        return {}
    param = quote(",".join(tickers), safe=",.:-")
    request = Request(f"{ANALYST_QUOTE_URL}?ticker={param}", headers={"User-Agent": "portfolio-web/1.0"})
    try:
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        logging.warning("analyst quote proxy failed: %s", exc)
        return {}


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
    return kr_ticker_code(ticker)[:2]


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
        if ticker.endswith(KOREAN_SUFFIXES) and upper_name.startswith(brand + " "):
            # SOL is also Solana's ticker. Never share its asset with SOL ETFs.
            key = KR_ETF_BRAND_SOURCES.get(brand, brand) if brand == "SOL" else brand
            if not logo_url(key):
                key = ticker  # an unavailable brand must not hide a valid ticker logo
            return {"kind": "etf", "text": brand[:2], "url": logo_url(key), "dark": is_dark_logo(key)}
    if ticker.endswith(LOCAL_MARKET_SUFFIXES):
        text = badge_text(ticker, name)
    else:
        text = kr_ticker_code(ticker)[:2]
    return {
        "kind": cls,
        "text": text,
        "url": logo_url(ticker),
        "dark": dark,
    }


def load_portfolio(
    us_extended: bool = False,
    ticker_filter: list[str] | None = None,
    compact: bool = False,
) -> dict:
    return load_portfolio_data(
        us_extended=us_extended,
        logo_hint_fn=logo_hint,
        ticker_filter=ticker_filter,
        compact=compact,
    )


def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


COMPRESSIBLE_CONTENT_TYPES = (
    "application/javascript",
    "application/json",
    "application/xml",
    "image/svg+xml",
    "text/",
)
MIN_GZIP_BYTES = 1024


def accepts_gzip(header: str | None) -> bool:
    """Return whether the request accepts gzip, respecting an explicit q=0."""
    qualities: dict[str, float] = {}
    for item in str(header or "").lower().split(","):
        encoding, *parameters = (part.strip() for part in item.split(";"))
        if not encoding:
            continue
        quality = 1.0
        for parameter in parameters:
            if not parameter.startswith("q="):
                continue
            try:
                quality = float(parameter[2:])
            except ValueError:
                quality = 0.0
        qualities[encoding] = quality
    if "gzip" in qualities:
        return qualities["gzip"] > 0
    return qualities.get("*", 0) > 0


def is_gzip_candidate(body: bytes, content_type: str) -> bool:
    return len(body) >= MIN_GZIP_BYTES and any(
        content_type.startswith(prefix) for prefix in COMPRESSIBLE_CONTENT_TYPES
    )


def gzip_response_body(body: bytes, content_type: str, accept_encoding: str | None) -> tuple[bytes, bool]:
    if not is_gzip_candidate(body, content_type) or not accepts_gzip(accept_encoding):
        return body, False
    compressed = gzip.compress(body, compresslevel=5, mtime=0)
    return (compressed, True) if len(compressed) < len(body) else (body, False)


STATIC_DIR = Path(__file__).with_name("portfolio_static")
INDEX_HTML = STATIC_DIR / "index.html"


# /api/chart?lite=1에서 빼는 큰 키. 나머지 시세 필드 모양은 일반 응답과 같다.
CHART_LITE_DROP_KEYS = ("points", "ichimoku_projection", "transactions")


TRUE_FLAGS = frozenset({"1", "true", "yes", "on"})


def query_first(query: dict[str, list[str]], key: str, default: str | None = None) -> str | None:
    """쿼리 문자열의 첫 값. parse_qs는 빈 값을 버리므로 `?ticker=`도 default가 된다."""
    values = query.get(key)
    return values[0] if values else default


def query_flag(query: dict[str, list[str]], key: str) -> bool:
    return query_first(query, key, "0") in TRUE_FLAGS


MAX_JSON_BODY_BYTES = 1_000_000
BAD_JSON_BODY = "요청 형식이 올바르지 않습니다."


CROSS_SITE_POST = "다른 사이트에서 보낸 요청은 받지 않습니다."
POST_NEEDS_JSON = "요청 형식은 application/json이어야 합니다."


def post_rejection(headers) -> tuple[int, str] | None:
    """쓰기 요청(POST) 경계 검사. 통과하면 None, 막으면 (상태 코드, 문구).

    - 본문은 application/json만 받는다. 다른 사이트의 <form>·text/plain 요청은 브라우저가 사전 확인 없이
      바로 보내지만, application/json은 CORS 사전 확인을 거치고 이 서버는 허락하지 않으므로 막힌다.
    - 브라우저가 Origin을 붙였으면 이 서버 주소(Host)와 같아야 한다. curl·서버 간 호출은 Origin이 없어 통과.
    lan_guard(접속 주소 제한)와 별개로, 내 브라우저에 열린 다른 페이지가 원장을 고치는 일을 막는다."""
    content_type = str(headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return HTTPStatus.UNSUPPORTED_MEDIA_TYPE, POST_NEEDS_JSON
    origin = headers.get("Origin")
    if origin is not None:
        parsed = urlparse(origin)
        host = str(headers.get("Host") or "").strip().lower()
        if parsed.scheme not in ("http", "https") or not host or parsed.netloc.lower() != host:
            return HTTPStatus.FORBIDDEN, CROSS_SITE_POST
    return None


def parse_json_body(raw: bytes) -> dict:
    """POST 본문 → dict. JSON이 아니거나 객체가 아니면 ValueError(→ 400) — 핸들러들이 payload.get을 바로 쓴다."""
    try:
        payload = json.loads(raw.decode("utf-8"))
    except ValueError as exc:   # JSONDecodeError·UnicodeDecodeError
        raise ValueError(BAD_JSON_BODY) from exc
    if not isinstance(payload, dict):
        raise ValueError(BAD_JSON_BODY)
    return payload


def resolve_child(base: Path, name: str) -> Path | None:
    """base 바로 아래의 실제 파일 경로. 밖으로 나가는 이름(심볼릭 링크 포함)·없는 파일은 None."""
    path = (base / name).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def logo_dark_header(file_name: str) -> str:
    """/logos/<stem>.<ext> 응답의 X-Logo-Dark 값. logo_stem은 stem에 다시 걸어도 같아서 기존 판정(is_dark_logo:
    logo_dark.json + .source.json의 dark)을 그대로 쓴다."""
    return "1" if is_dark_logo(Path(file_name).stem) else "0"

class Handler(BaseHTTPRequestHandler):
    # 요청 로그는 log_access 한 곳(logging → err.log)만 남긴다. 기본 log_request까지 두면 같은 요청이
    # out.log에도 필터 없이 찍혀 두 배로 쌓였다(2026-10-11 정리 전 out.log 27MB·err.log 45MB).
    def log_request(self, code="-", size="-") -> None:
        return None

    def log_message(self, fmt: str, *args) -> None:
        logging.warning("%s", fmt % args)   # log_error 경로(끊긴 연결 등)만 여기로 온다

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
        if self.path == "/" and self.command == "GET":
            return self.request_elapsed() >= 1.0   # 포털 상태 점검이 1분마다 치는 첫 화면 — 느릴 때만
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

    def write_body(self, status: int, body: bytes) -> None:
        """헤더 뒤 본문 전송 + 접속 로그. 보내는 중 끊긴 연결은 기록만 하고 올려 _dispatch가 조용히 끝낸다."""
        try:
            self.wfile.write(body)
        except ConnectionError:
            self.log_client_abort(status, len(body))
            raise
        self.log_access(status, len(body))

    def send_not_found(self) -> None:
        self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)

    def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        varies_by_encoding = is_gzip_candidate(body, content_type)
        response_body, compressed = gzip_response_body(
            body,
            content_type,
            self.headers.get("Accept-Encoding"),
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(response_body)))
        self.send_header("Cache-Control", "no-store")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        if varies_by_encoding:
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.write_body(status, response_body)

    def send_json(self, payload: dict, status: int = 200) -> None:
        self.send_bytes(
            json.dumps(json_safe(payload), ensure_ascii=False, allow_nan=False).encode("utf-8"),
            "application/json; charset=utf-8",
            status,
        )

    def send_file(self, file_path: Path, content_type: str | None = None, cache_control: str = "no-store") -> None:
        if not file_path.is_file():
            self.send_not_found()
            return
        stat = file_path.stat()
        resolved_content_type = content_type or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        body = file_path.read_bytes()
        varies_by_encoding = is_gzip_candidate(body, resolved_content_type)
        response_body, compressed = gzip_response_body(
            body,
            resolved_content_type,
            self.headers.get("Accept-Encoding"),
        )
        encoding_tag = "-gzip" if compressed else ""
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}{encoding_tag}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache_control)
            if varies_by_encoding:
                self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            self.log_access(304)
            return
        self.send_response(200)
        self.send_header("Content-Type", resolved_content_type)
        self.send_header("Content-Length", str(len(response_body)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("ETag", etag)
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        if varies_by_encoding:
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.write_body(200, response_body)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise ValueError(BAD_JSON_BODY) from exc
        if length <= 0:
            return {}
        if length > MAX_JSON_BODY_BYTES:
            raise ValueError("요청 본문이 너무 큽니다.")
        return parse_json_body(self.rfile.read(length))

    def send_static(self, name: str) -> None:
        static_path = resolve_child(STATIC_DIR, name)
        if static_path is None:
            self.send_not_found()
            return
        # 폰트(2MB woff2)는 거의 안 바뀌므로 하루 캐시. 나머지 정적 파일은
        # 본문을 보관하되 매번 ETag만 확인해 변경 즉시 반영한다.
        if static_path.suffix == ".woff2":
            self.send_file(static_path, "font/woff2", cache_control="public, max-age=86400")
        else:
            self.send_file(static_path, cache_control="no-cache")

    def send_logo(self, name: str) -> None:
        # send_file과 달리 압축·ETag 없이 원본 그대로(다른 서비스가 /logos를 프록시한다) — 하루 캐시.
        logo_path = resolve_child(LOGO_DIR, name)
        if logo_path is None:
            self.send_not_found()
            return
        content_type = mimetypes.guess_type(str(logo_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(logo_path.stat().st_size))
        self.send_header("Cache-Control", "public, max-age=86400")
        # 흰 바탕에서 안 보이는 로고 표시(2026-11-08, 증류 뷰어 등 /logos 프록시 소비처용). 프런트 칩과 같은 판정.
        self.send_header("X-Logo-Dark", logo_dark_header(logo_path.name))
        self.end_headers()
        self.write_body(200, logo_path.read_bytes())

    def query_values(self, query: dict[str, list[str]], key: str) -> list[str]:
        values: list[str] = []
        for value in query.get(key) or []:
            values.extend(part for part in value.split(",") if part)
        return values

    def api_portfolio(self, query: dict[str, list[str]]) -> dict:
        us_extended = query_flag(query, "us_extended")
        compact = query_flag(query, "compact")
        return load_portfolio(
            us_extended=us_extended,
            ticker_filter=self.query_values(query, "tickers"),
            compact=compact,
        )

    def api_health(self, query: dict[str, list[str]]) -> dict:
        with connect() as conn:
            row = conn.execute(
                """
                SELECT updated_at, item_count
                FROM collector_runs
                WHERE name IN ('price', 'price-daily')
                ORDER BY CASE name WHEN 'price' THEN 0 ELSE 1 END
                LIMIT 1
                """
            ).fetchone()
        return {
            "ok": True,
            "price_updated_at": row["updated_at"] if row else None,
            "item_count": row["item_count"] if row else 0,
        }

    def api_stats(self, query: dict[str, list[str]]) -> dict:
        us_extended = query_flag(query, "us_extended")
        return load_stats(self.query_values(query, "tickers"), us_extended=us_extended)

    def api_quote(self, query: dict[str, list[str]]) -> dict:
        # 애널리스트 컨센서스(목표가·업사이드·매수강도)를 8767 서비스에서 프록시.
        # ?ticker=A,B,C (tickers도 허용). 서비스 불가 시 {} 반환(대시보드 무영향).
        tickers = self.query_values(query, "ticker") or self.query_values(query, "tickers")
        return fetch_analyst_quotes(tickers)

    def api_tickers(self, query: dict[str, list[str]]) -> dict:
        # DB 등록 종목 목록 (비교 검색 자동완성용). DB 전용.
        with connect() as conn:
            return {"tickers": load_ticker_directory(conn)}

    def api_company_profile(self, query: dict[str, list[str]]) -> dict:
        return load_company_profile(query_first(query, "ticker", ""))

    def api_etf_holdings(self, query: dict[str, list[str]]) -> dict:
        return load_etf_holdings(query_first(query, "ticker", ""))

    def api_etf_exposure(self, query: dict[str, list[str]]) -> dict:
        return load_etf_exposure(query_first(query, "ticker", ""))

    def api_company_events(self, query: dict[str, list[str]]) -> dict:
        return load_company_events(query_first(query, "ticker", ""))

    def api_etf_universe(self, query: dict[str, list[str]]) -> dict:
        return load_etf_universe()

    def api_diagnostics(self, query: dict[str, list[str]]) -> dict:
        # 수집 상태 진단 (실패/지연 노출). DB 전용.
        with connect() as conn:
            return load_collection_diagnostics(conn)

    def api_chart(self, query: dict[str, list[str]]) -> dict:
        ticker = query_first(query, "ticker", "")
        us_extended = query_flag(query, "us_extended")
        # 화면 정밀도를 넘는 실수 자릿수는 응답 경계에서만 줄인다(payload_compact).
        payload = compact_chart_payload(load_price_chart(
            ticker,
            us_extended=us_extended,
            range_key=query_first(query, "range"),
            start=query_first(query, "start"),
            end=query_first(query, "end"),
            lite=query_flag(query, "lite"),
        ))
        payload["has_etf_holdings"] = etf_holdings_available(ticker, payload.get("name") or "")
        # 이 종목을 편입한 ETF 수(2026-11-09). 캐시가 깨져도 차트 응답은 그대로 낸다.
        try:
            payload["etf_exposure_count"] = etf_exposure_count(ticker)
        except Exception:
            payload["etf_exposure_count"] = 0
        # 증류 촉매·일정 버튼(2026-11-08). 캐시가 깨져도 차트 응답은 그대로 낸다.
        try:
            payload["company_events"] = company_events_summary(ticker)
        except Exception:
            payload["company_events"] = None
        # 티커칩 시세 팝오버(wm·sa·td·xw)용 — 목록 표와 같은 계산. 실패해도 차트 응답은 그대로 낸다.
        try:
            payload["quote_stats"] = load_quote_stats(ticker, us_extended=us_extended)
        except Exception:
            payload["quote_stats"] = empty_quote_stats()
        # 시세 팝오버용 가벼운 응답(2026-11-08): 봉 배열·일목 예상경로를 빼고 시세·quote_stats만(1.3MB → 2KB 안팎).
        if query_flag(query, "lite"):
            for key in CHART_LITE_DROP_KEYS:
                payload.pop(key, None)
        return payload

    def api_price_since(self, query: dict[str, list[str]]) -> dict:
        """기준 시각(since, ISO) 이후 등락률 묶음 — 지식증류 뷰어의 '리포트 생성 이후' 열(2026-10-25)."""
        since = query_first(query, "since", "")
        try:
            return load_price_since(self.query_values(query, "tickers"), since)
        except ValueError as exc:
            return {"error": str(exc), "items": {}}

    def api_account_performance(self, query: dict[str, list[str]]) -> dict:
        return compact_performance_payload(load_account_performance(
            self.query_values(query, "account_ids"),
            detail=query_flag(query, "detail"),
            range_key=query_first(query, "range"),
            start=query_first(query, "start"),
            end=query_first(query, "end"),
        ))

    def api_dividends(self, query: dict[str, list[str]]) -> dict:
        return load_dividends(self.query_values(query, "account_ids"))

    def api_dividend_history(self, query: dict[str, list[str]]) -> dict:
        return load_dividend_history(query_first(query, "ticker", ""))

    def api_schedule(self, query: dict[str, list[str]]) -> dict:
        return load_schedule(logo_hint_fn=logo_hint)

    def api_transactions(self, query: dict[str, list[str]]) -> dict:
        return load_transactions(
            query_first(query, "account_id"),
            query_first(query, "ticker"),
            self.query_values(query, "account_ids"),
        )

    def api_watchlist_lookup(self, query: dict[str, list[str]]) -> dict:
        found = lookup_ticker(query_first(query, "q", ""))
        found["registered"] = is_registered_ticker(found.get("ticker", ""))
        return {"ticker": found}

    def api_interest_watchlists(self, query: dict[str, list[str]]) -> dict:
        return load_interest_watchlists()

    def post_transactions(self) -> dict:
        return add_transaction(self.read_json(), portfolio_loader=load_portfolio)

    def post_transaction_update(self) -> dict:
        return update_transaction(self.read_json(), portfolio_loader=load_portfolio)

    def post_transaction_memo(self) -> dict:
        return update_transaction_memo(self.read_json())

    def post_transaction_delete(self) -> dict:
        return delete_transaction(self.read_json(), portfolio_loader=load_portfolio)

    # ── 성과 스냅샷·현금 입출금 (아직 화면 미노출 — API만) ──
    def api_performance_snapshots(self, query: dict[str, list[str]]) -> dict:
        account_ids = self.query_values(query, "account_ids") or []
        single = query_first(query, "account_id")
        if single:
            account_ids = [single]
        return load_account_snapshots(
            account_ids or None,
            query_first(query, "start"),
            query_first(query, "end"),
        )

    def api_cash_flows(self, query: dict[str, list[str]]) -> dict:
        account_id = query_first(query, "account_id")
        return list_cash_flows(int(account_id) if account_id else None)

    def post_cash_flow(self) -> dict:
        return add_cash_flow(self.read_json())

    def post_cash_flow_delete(self) -> dict:
        return delete_cash_flow(self.read_json())

    def post_performance_rebuild(self) -> dict:
        ids = self.read_json().get("account_ids") or None
        if ids is not None and not isinstance(ids, list):
            raise ValueError("account_ids는 목록이어야 합니다.")
        return {"ok": True, "rows": rebuild_account_snapshots([int(x) for x in ids] if ids else None)}

    def post_watchlist(self) -> dict:
        payload = self.read_json()
        return add_watchlist_async(payload.get("tickers") or [])

    def post_watchlist_delete(self) -> dict:
        return unregister_collected_ticker(self.read_json())

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

    def post_interest_favorite(self) -> dict:
        return set_favorite_item(self.read_json())

    def post_interest_item_delete(self) -> dict:
        return delete_interest_item(self.read_json())

    def post_ticker_display_name(self) -> dict:
        return update_ticker_display_name(self.read_json())

    def api_tags(self, query: dict[str, list[str]]) -> dict:
        return load_tags_payload()

    def post_ticker_tags(self) -> dict:
        return set_ticker_tags(self.read_json())

    # 경로 → 핸들러. 요청마다 사전을 다시 만들지 않도록 클래스에 한 번 둔다.
    GET_ROUTES = {
        "/api/health": api_health,
        "/api/portfolio": api_portfolio,
        "/api/stats": api_stats,
        "/api/quote": api_quote,
        "/api/tickers": api_tickers,
        "/api/company-profile": api_company_profile,
        "/api/etf-holdings": api_etf_holdings,
        "/api/etf-exposure": api_etf_exposure,
        "/api/company-events": api_company_events,
        "/api/etf-universe": api_etf_universe,
        "/api/diagnostics": api_diagnostics,
        "/api/chart": api_chart,
        "/api/price-since": api_price_since,
        "/api/account-performance": api_account_performance,
        "/api/performance/snapshots": api_performance_snapshots,
        "/api/cash-flows": api_cash_flows,
        "/api/dividends": api_dividends,
        "/api/dividend-history": api_dividend_history,
        "/api/schedule": api_schedule,
        "/api/transactions": api_transactions,
        "/api/watchlist/lookup": api_watchlist_lookup,
        "/api/interest-watchlists": api_interest_watchlists,
        "/api/tags": api_tags,
    }
    POST_ROUTES = {
        "/api/transactions": post_transactions,
        "/api/transactions/update": post_transaction_update,
        "/api/transactions/delete": post_transaction_delete,
        "/api/transactions/memo": post_transaction_memo,
        "/api/cash-flows": post_cash_flow,
        "/api/cash-flows/delete": post_cash_flow_delete,
        "/api/performance/rebuild": post_performance_rebuild,
        "/api/watchlist": post_watchlist,
        "/api/watchlist/delete": post_watchlist_delete,
        "/api/interest-watchlists/groups": post_interest_group,
        "/api/interest-watchlists/groups/rename": post_interest_group_rename,
        "/api/interest-watchlists/groups/reorder": post_interest_group_reorder,
        "/api/interest-watchlists/groups/delete": post_interest_group_delete,
        "/api/interest-watchlists/items": post_interest_item,
        "/api/interest-watchlists/items/delete": post_interest_item_delete,
        "/api/interest-watchlists/favorite": post_interest_favorite,
        "/api/tickers/display-name": post_ticker_display_name,
        "/api/tags": post_ticker_tags,
    }

    def _dispatch(self, verb: str, handler) -> None:
        """GET/POST 공통 에러 처리: 끊긴 연결 무시, ValueError→400, 그 외→로그+500."""
        self._request_started_at = time.perf_counter()
        try:
            handler()
        except ConnectionError:   # BrokenPipe·ConnectionReset — 응답을 받을 상대가 없다
            return
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception:
            logging.exception("%s %s failed", verb, self.path)
            try:
                self.send_json({"error": HTTPStatus.INTERNAL_SERVER_ERROR.phrase}, 500)
            except ConnectionError:
                return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        def handle() -> None:
            if path.startswith("/static/"):
                self.send_static(Path(path).name)
            elif path.startswith("/logos/"):
                self.send_logo(Path(path).name)
            elif path in self.GET_ROUTES:
                self.send_json(self.GET_ROUTES[path](self, parse_qs(parsed.query)))
            elif path in {"/", "/index.html"}:
                self.send_file(INDEX_HTML, "text/html; charset=utf-8")
            else:
                self.send_not_found()

        self._dispatch("GET", handle)

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        def handle() -> None:
            if path not in self.POST_ROUTES:
                self.send_not_found()
                return
            rejection = post_rejection(self.headers)
            if rejection is not None:
                status, message = rejection
                logging.warning("POST %s rejected (%d) origin=%s content-type=%s", path, status,
                                self.headers.get("Origin"), self.headers.get("Content-Type"))
                self.send_json({"error": message}, status)
                return
            self.send_json(self.POST_ROUTES[path](self))

        self._dispatch("POST", handle)


class PortfolioHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        """요청 줄을 읽기도 전에 끊긴 연결(브라우저 예비 연결 정리 등)은 장애가 아니다 — 기본 구현은
        그때마다 Traceback 20여 줄을 stderr에 찍어 err.log를 채웠다. 그 밖의 오류는 시각과 함께 남긴다."""
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        logging.exception("request from %s failed", client_address[0] if client_address else "-")


OPEN_FILE_SOFT_LIMIT = 4096
WEB_LOG_PATH = Path.home() / "Library" / "Logs" / "hermes" / "portfolio-web.log"
WEB_LOG_MAX_BYTES = 5_000_000
WEB_LOG_BACKUPS = 3


def raise_open_file_limit(target: int = OPEN_FILE_SOFT_LIMIT) -> int:
    """launchd가 주는 기본 소프트 한도(256)는 요청 스레드·SQLite·외부 소켓이 겹치면 바닥난다
    (2026-11-09 'Too many open files'로 index.html까지 500). 하드 한도 안에서 올린다."""
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    wanted = target if hard == resource.RLIM_INFINITY else min(target, hard)
    if soft != resource.RLIM_INFINITY and soft < wanted:
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (wanted, hard))
            soft = wanted
        except (ValueError, OSError) as exc:
            logging.warning("could not raise open-file limit to %d: %s", wanted, exc)
    return soft


def configure_logging(log_path: Path = WEB_LOG_PATH) -> None:
    """요청 기록(INFO)은 크기로 돌려 쓰는 파일에, 경고 이상만 stderr(launchd err.log)에 남긴다.
    예전엔 요청마다 err.log에 한 줄씩 쌓여 순환 없이 8.7MB까지 자랐다."""
    formatter = logging.Formatter("[%(asctime)s] %(levelname)s %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    stderr_handler = logging.StreamHandler()
    stderr_handler.setLevel(logging.WARNING)
    stderr_handler.setFormatter(formatter)
    root.addHandler(stderr_handler)
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=WEB_LOG_MAX_BYTES, backupCount=WEB_LOG_BACKUPS, encoding="utf-8")
    except OSError as exc:
        stderr_handler.setLevel(logging.INFO)   # 파일을 못 열면 예전처럼 전부 stderr로
        logging.warning("request log file unavailable (%s); logging to stderr", exc)
        return
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    configure_logging()
    raise_open_file_limit()
    initialize_schema()
    server = PortfolioHTTPServer((args.host, args.port), Handler)
    lan_guard.guard_http_server(server)
    print(f"Serving portfolio web page on http://{args.host}:{args.port}")
    print(f"DB: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()

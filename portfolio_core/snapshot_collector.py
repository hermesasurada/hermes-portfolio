from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from .collectors import CollectedPrice, FX_SYMBOLS, fetch_crypto_krw
from .constants import MARKET_INDEXES
from .db import connect, ensure_live_quote_cache_table, ensure_quote_source_state_table
from .paths import KST
from .price_store import load_watch
from .tickers import kr_ticker_code, normalize_yfinance_symbol, ticker_currency
from .us_live_quotes import yahoo_quote_batch

YAHOO_BATCH_SIZE = 120
BACKOFF_MAX_SECONDS = 60 * 60
NAVER_HEADERS = {
    "Accept": "*/*",
    "Referer": "https://finance.naver.com/",
    "User-Agent": "Mozilla/5.0",
}


def chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[index:index + size] for index in range(0, len(items), size)]


def source_ready(source: str) -> tuple[bool, int]:
    now = time.time()
    with connect() as conn:
        ensure_quote_source_state_table(conn)
        row = conn.execute(
            "SELECT blocked_until FROM quote_source_state WHERE source = ?",
            (source,),
        ).fetchone()
    blocked_until = float(row["blocked_until"] or 0) if row else 0
    return blocked_until <= now, max(0, round(blocked_until - now))


def record_source_success(source: str) -> None:
    with connect() as conn:
        ensure_quote_source_state_table(conn)
        conn.execute(
            """
            INSERT INTO quote_source_state
              (source, failure_count, blocked_until, last_error, updated_at)
            VALUES (?, 0, NULL, NULL, ?)
            ON CONFLICT(source) DO UPDATE SET
              failure_count = 0,
              blocked_until = NULL,
              last_error = NULL,
              updated_at = excluded.updated_at
            """,
            (source, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()


def record_source_failure(source: str, error: Exception) -> int:
    with connect() as conn:
        ensure_quote_source_state_table(conn)
        row = conn.execute(
            "SELECT failure_count FROM quote_source_state WHERE source = ?",
            (source,),
        ).fetchone()
        failure_count = int(row["failure_count"] or 0) + 1 if row else 1
        status = getattr(error, "code", None)
        minimum = 5 * 60 if status in (403, 418, 429) else 60
        delay = min(BACKOFF_MAX_SECONDS, max(minimum, 60 * (2 ** min(failure_count - 1, 6))))
        delay += random.randint(0, min(30, max(1, delay // 10)))
        conn.execute(
            """
            INSERT INTO quote_source_state
              (source, failure_count, blocked_until, last_error, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source) DO UPDATE SET
              failure_count = excluded.failure_count,
              blocked_until = excluded.blocked_until,
              last_error = excluded.last_error,
              updated_at = excluded.updated_at
            """,
            (
                source,
                failure_count,
                time.time() + delay,
                str(error)[:500],
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    return delay


def save_live_quote_rows(rows: dict[str, dict]) -> None:
    if not rows:
        return
    fetched_ts = time.time()
    with connect() as conn:
        ensure_live_quote_cache_table(conn)
        conn.executemany(
            """
            INSERT INTO ticker_live_quotes (ticker, fetched_ts, payload_json)
            VALUES (?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
              fetched_ts = excluded.fetched_ts,
              payload_json = excluded.payload_json
            """,
            [
                (symbol.upper(), fetched_ts, json.dumps(payload, ensure_ascii=False))
                for symbol, payload in rows.items()
            ],
        )
        conn.commit()


def quote_date(row: dict) -> str:
    timestamp = row.get("regularMarketTime")
    if timestamp:
        return datetime.fromtimestamp(float(timestamp), timezone.utc).strftime("%Y-%m-%d")
    return datetime.now(KST).strftime("%Y-%m-%d")


def kr_market_date(timestamp_ms: float | int | None) -> str:
    observed = datetime.fromtimestamp(float(timestamp_ms or time.time() * 1000) / 1000, KST)
    market_date = observed.date()
    if observed.weekday() >= 5 or observed.hour < 9:
        market_date -= timedelta(days=1)
        while market_date.weekday() >= 5:
            market_date -= timedelta(days=1)
    return market_date.isoformat()


def fetch_yahoo_snapshots(watch: dict[str, list[str]]) -> tuple[list[CollectedPrice], list[str]]:
    requests: dict[str, tuple[str, str]] = {}
    for ticker in watch.get("overseas", []):
        symbol = normalize_yfinance_symbol(ticker) or ticker
        requests[symbol.upper()] = (ticker, ticker_currency(ticker))
    for ticker in watch.get("fx", []):
        symbol = FX_SYMBOLS.get(ticker, f"{ticker}=X")
        requests[symbol.upper()] = (ticker, "FX")
    for ticker in watch.get("index", []):
        if ticker == "KOSPI":
            continue
        meta = MARKET_INDEXES.get(ticker)
        if meta:
            requests[str(meta["symbol"]).upper()] = (ticker, str(meta["currency"]))
    if not requests:
        return [], []

    ready, wait_seconds = source_ready("yahoo")
    if not ready:
        print(f"  - yahoo backoff active ({wait_seconds}s remaining)")
        return [], [ticker for ticker, _ in requests.values()]

    rows: dict[str, dict] = {}
    try:
        for batch in chunks(list(requests), YAHOO_BATCH_SIZE):
            rows.update(yahoo_quote_batch(batch))
    except Exception as exc:
        try:
            delay = record_source_failure("yahoo", exc)
        except Exception:
            delay = 60
        print(f"  x yahoo batch: {exc} (backoff {delay}s)")
        return [], [ticker for ticker, _ in requests.values()]
    try:
        record_source_success("yahoo")
    except Exception as exc:
        print(f"  x Yahoo source state write skipped: {exc}")
    try:
        save_live_quote_rows(rows)
    except Exception as exc:
        print(f"  x shared Yahoo cache write skipped: {exc}")

    fetched: list[CollectedPrice] = []
    missing: list[str] = []
    for symbol, (ticker, currency) in requests.items():
        row = rows.get(symbol, {})
        price = row.get("regularMarketPrice")
        if price in (None, 0):
            missing.append(ticker)
            continue
        date_text = quote_date(row)
        fetched.append(
            CollectedPrice(
                ticker=ticker,
                price=float(price),
                currency=currency,
                source="yf-batch",
                price_date=date_text,
                recent=[(date_text, float(price))],
            )
        )
    return fetched, missing


def naver_realtime(query: str) -> dict:
    url = f"https://polling.finance.naver.com/api/realtime?query={quote(query, safe=':,')}"
    request = urllib.request.Request(url, headers=NAVER_HEADERS)
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read()
        charset = response.headers.get_content_charset()
        if charset:
            return json.loads(raw.decode(charset))
        try:
            return json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError:
            return json.loads(raw.decode("cp949"))


def fetch_naver_snapshots(watch: dict[str, list[str]]) -> tuple[list[CollectedPrice], list[str]]:
    ticker_by_code = {kr_ticker_code(ticker): ticker for ticker in watch.get("kr", [])}
    now_kst = datetime.now(KST)
    wants_kospi = (
        "KOSPI" in watch.get("index", [])
        and now_kst.weekday() < 5
        and 8 <= now_kst.hour <= 18
    )
    if not ticker_by_code and not wants_kospi:
        return [], []

    ready, wait_seconds = source_ready("naver-realtime")
    if not ready:
        print(f"  - naver backoff active ({wait_seconds}s remaining)")
        return [], [*ticker_by_code.values(), *(["KOSPI"] if wants_kospi else [])]

    fetched: list[CollectedPrice] = []
    found: set[str] = set()
    try:
        if ticker_by_code:
            payload = naver_realtime(f"SERVICE_ITEM:{','.join(ticker_by_code)}")
            result = payload.get("result") or {}
            date_text = kr_market_date(result.get("time"))
            for area in result.get("areas") or []:
                for row in area.get("datas") or []:
                    ticker = ticker_by_code.get(str(row.get("cd") or ""))
                    price = row.get("nv")
                    if not ticker or price in (None, 0):
                        continue
                    found.add(ticker)
                    fetched.append(
                        CollectedPrice(
                            ticker,
                            float(price),
                            "KRW",
                            "naver-realtime",
                            date_text,
                            [(date_text, float(price))],
                        )
                    )
        if wants_kospi:
            payload = naver_realtime("SERVICE_INDEX:KOSPI")
            result = payload.get("result") or {}
            date_text = kr_market_date(result.get("time"))
            for area in result.get("areas") or []:
                for row in area.get("datas") or []:
                    if row.get("cd") != "KOSPI" or row.get("nv") in (None, 0):
                        continue
                    price = float(row["nv"]) / 100
                    found.add("KOSPI")
                    fetched.append(
                        CollectedPrice("KOSPI", price, "KRW", "naver-index", date_text, [(date_text, price)])
                    )
    except Exception as exc:
        try:
            delay = record_source_failure("naver-realtime", exc)
        except Exception:
            delay = 60
        print(f"  x naver batch: {exc} (backoff {delay}s)")
        return [], [*ticker_by_code.values(), *(["KOSPI"] if wants_kospi else [])]
    try:
        record_source_success("naver-realtime")
    except Exception as exc:
        print(f"  x Naver source state write skipped: {exc}")

    wanted = {*ticker_by_code.values(), *(["KOSPI"] if wants_kospi else [])}
    return fetched, sorted(wanted - found)


def collect_snapshots(categories: list[str], tickers: list[str] | None = None) -> tuple[list[CollectedPrice], list[str]]:
    watch = load_watch(categories=categories, tickers=tickers)
    fetched: list[CollectedPrice] = []
    errors: list[str] = []

    yahoo_rows, yahoo_errors = fetch_yahoo_snapshots(watch)
    fetched.extend(yahoo_rows)
    errors.extend(yahoo_errors)

    naver_rows, naver_errors = fetch_naver_snapshots(watch)
    fetched.extend(naver_rows)
    errors.extend(naver_errors)

    for ticker in watch.get("crypto", []):
        try:
            crypto = fetch_crypto_krw(ticker)
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"  x {ticker}: {exc}")
            errors.append(ticker)
        else:
            if crypto:
                fetched.append(crypto)
            else:
                errors.append(ticker)
    return fetched, sorted(set(errors))

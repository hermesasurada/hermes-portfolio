#!/usr/bin/env python3
"""Download portfolio ticker logos into the local portfolio logo cache."""

from __future__ import annotations

import argparse
import hashlib
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

DB_PATH = Path.home() / ".hermes" / "data" / "stock_history.db"
LOGO_DIR = Path.home() / ".hermes" / "data" / "portfolio_v2" / "logos"
FMP_LOGO_URL = "https://financialmodelingprep.com/image-stock/{ticker}.png"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
FALLBACK_COPY_SOURCES = {
    "010140.KS": "005930.KS",
    "0117V0.KS": "241180.KS",
    "0167Z0.KS": "278530.KS",
    "0173Y0.KS": "278530.KS",
    "100790.KQ": "006800.KS",
    "267260.KS": "267250.KS",
    "379800.KS": "278530.KS",
    "379810.KS": "278530.KS",
    "390390.KS": "278530.KS",
    "443060.KS": "267250.KS",
    "447770.KS": "241180.KS",
    "475080.KS": "278530.KS",
}


def logo_stem(ticker: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in ticker.upper())


def tickers_from_db(db_path: Path) -> list[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT DISTINCT ticker FROM holdings WHERE ticker IS NOT NULL ORDER BY ticker"
        ).fetchall()
    finally:
        conn.close()
    return [row[0] for row in rows]


def candidate_symbols(ticker: str) -> list[str]:
    candidates = [ticker]
    if "." in ticker:
        candidates.append(ticker.split(".", 1)[0])
    if ticker == "BTC":
        candidates.extend(["BTCUSD", "BTC-USD"])
    return list(dict.fromkeys(candidates))


def fetch_logo(symbol: str, timeout: float) -> tuple[bytes | None, str]:
    url = FMP_LOGO_URL.format(ticker=quote(symbol, safe=".:-"))
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 portfolio-logo-cache/1.0",
            "Accept": "image/png,image/*;q=0.8,*/*;q=0.5",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            body = response.read()
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}"
    except urllib.error.URLError as exc:
        return None, f"URL error: {exc.reason}"
    except TimeoutError:
        return None, "timeout"

    if not content_type.lower().startswith("image/"):
        return None, f"not image: {content_type or 'unknown'}"
    if not body.startswith(PNG_MAGIC):
        return None, "not png"
    if len(body) < 300:
        return None, f"too small: {len(body)} bytes"
    return body, f"ok {len(body)} bytes"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--logo-dir", type=Path, default=LOGO_DIR)
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--sleep", type=float, default=0.08)
    parser.add_argument("--keep-existing", action="store_true")
    args = parser.parse_args()

    args.logo_dir.mkdir(parents=True, exist_ok=True)
    tickers = tickers_from_db(args.db)
    seen_hashes: dict[str, str] = {}
    saved = 0
    skipped = 0
    failed = 0

    print(f"DB: {args.db}")
    print(f"Logo dir: {args.logo_dir}")
    print(f"Tickers: {len(tickers)}")

    for ticker in tickers:
        out_path = args.logo_dir / f"{logo_stem(ticker)}.png"
        if args.keep_existing and out_path.exists():
            print(f"SKIP {ticker}: existing {out_path.name}")
            skipped += 1
            continue

        last_status = "not tried"
        for symbol in candidate_symbols(ticker):
            body, status = fetch_logo(symbol, args.timeout)
            last_status = f"{symbol}: {status}"
            if body is None:
                time.sleep(args.sleep)
                continue

            digest = hashlib.sha256(body).hexdigest()
            duplicate_of = seen_hashes.get(digest)
            tmp_path = out_path.with_suffix(".png.tmp")
            tmp_path.write_bytes(body)
            tmp_path.replace(out_path)
            seen_hashes[digest] = ticker
            saved += 1
            duplicate_note = f" duplicate-of={duplicate_of}" if duplicate_of else ""
            print(f"SAVE {ticker}: {out_path.name} via {symbol} {len(body)} bytes{duplicate_note}")
            break
        else:
            source_ticker = FALLBACK_COPY_SOURCES.get(ticker)
            source_path = (
                args.logo_dir / f"{logo_stem(source_ticker)}.png"
                if source_ticker
                else None
            )
            if source_path and source_path.exists():
                out_path.write_bytes(source_path.read_bytes())
                saved += 1
                print(f"COPY {ticker}: {out_path.name} from {source_ticker}")
            else:
                failed += 1
                print(f"FAIL {ticker}: {last_status}")
        time.sleep(args.sleep)

    print(f"Done: saved={saved} skipped={skipped} failed={failed}")
    return 0 if saved else 1


if __name__ == "__main__":
    sys.exit(main())

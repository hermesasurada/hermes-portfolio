from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

from .paths import LOGO_DIR

FMP_LOGO_URL = "https://financialmodelingprep.com/image-stock/{ticker}.png"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# Manual ticker -> source-ticker logo overrides (e.g. tickers FMP has no image
# for, reusing a related listing's logo). Kept in an editable data file rather
# than hardcoded so it can be tuned without code changes. (#9)
FALLBACK_MAP_PATH = LOGO_DIR.parent / "logo_fallbacks.json"
_fallback_cache: dict | None = None


def fallback_copy_sources() -> dict:
    global _fallback_cache
    if _fallback_cache is None:
        try:
            _fallback_cache = (
                json.loads(FALLBACK_MAP_PATH.read_text())
                if FALLBACK_MAP_PATH.exists()
                else {}
            )
        except Exception:
            _fallback_cache = {}
    return _fallback_cache


def logo_stem(ticker: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in ticker.upper())


def existing_logo_path(ticker: str, logo_dir: Path = LOGO_DIR) -> Path | None:
    stem = logo_stem(ticker)
    for ext in ("png", "svg"):
        path = logo_dir / f"{stem}.{ext}"
        if path.exists():
            return path
    return None


def candidate_symbols(ticker: str) -> list[str]:
    candidates = [ticker]
    if "." in ticker:
        candidates.append(ticker.split(".", 1)[0])
    if ticker == "BTC":
        candidates.extend(["BTCUSD", "BTC-USD"])
    return list(dict.fromkeys(candidates))


def fetch_logo(symbol: str, timeout: float = 8.0) -> tuple[bytes | None, str]:
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


def copy_fallback_logo(ticker: str, logo_dir: Path = LOGO_DIR) -> dict | None:
    source_ticker = fallback_copy_sources().get(ticker)
    if not source_ticker:
        return None
    source_path = existing_logo_path(source_ticker, logo_dir)
    if not source_path:
        return None
    out_path = logo_dir / f"{logo_stem(ticker)}{source_path.suffix}"
    out_path.write_bytes(source_path.read_bytes())
    return {"saved": True, "path": out_path.name, "source": f"copy:{source_ticker}"}


def cache_logo(ticker: str, keep_existing: bool = True, timeout: float = 8.0) -> dict:
    ticker = str(ticker or "").strip().upper()
    if not ticker:
        return {"saved": False, "error": "empty ticker"}

    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    existing = existing_logo_path(ticker)
    if keep_existing and existing:
        return {"saved": False, "path": existing.name, "source": "existing"}

    out_path = LOGO_DIR / f"{logo_stem(ticker)}.png"
    last_status = "not tried"
    for symbol in candidate_symbols(ticker):
        body, status = fetch_logo(symbol, timeout=timeout)
        last_status = f"{symbol}: {status}"
        if body is None:
            continue
        tmp_path = out_path.with_suffix(".png.tmp")
        tmp_path.write_bytes(body)
        tmp_path.replace(out_path)
        return {"saved": True, "path": out_path.name, "source": f"fmp:{symbol}"}

    fallback = copy_fallback_logo(ticker)
    if fallback:
        return fallback
    return {"saved": False, "error": last_status}

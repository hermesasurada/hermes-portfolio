from __future__ import annotations

import hashlib
import json
import struct
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

from .paths import LOGO_DIR
from .tickers import normalize_yfinance_symbol

FMP_LOGO_URL = "https://financialmodelingprep.com/image-stock/{ticker}.png"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# 정방형 심볼 로고 소스 — FMP가 가로 워드마크를 줄 때 기업 도메인 파비콘으로 대체.
FAVICON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
    "Accept": "image/png,image/*;q=0.8,*/*;q=0.5",
}
# icon.horse가 '아이콘 없음' 도메인에 돌려주는 기본 플레이스홀더(256x256, 4267B) — 채택 금지.
ICONHORSE_GENERIC_MD5 = "3c8b6314dfa2"
FMP_MAX_ASPECT = 1.5      # 이보다 가로로 길면 FMP 로고는 워드마크로 보고 파비콘을 시도
FAVICON_MAX_ASPECT = 1.3  # 파비콘 결과는 사실상 정방형이어야 채택

# Manual ticker -> source-ticker logo overrides (e.g. tickers FMP has no image
# for, reusing a related listing's logo). Kept in an editable data file rather
# than hardcoded so it can be tuned without code changes. (#9)
FALLBACK_MAP_PATH = LOGO_DIR.parent / "logo_fallbacks.json"
# 파일 mtime이 바뀌면 자동 재로드 — json을 수동 갱신해도 서버 재시작이 필요 없다.
_fallback_cache: tuple[float, dict] | None = None


def _file_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def fallback_copy_sources() -> dict:
    global _fallback_cache
    mtime = _file_mtime(FALLBACK_MAP_PATH)
    if _fallback_cache is None or _fallback_cache[0] != mtime:
        try:
            data = (
                json.loads(FALLBACK_MAP_PATH.read_text())
                if FALLBACK_MAP_PATH.exists()
                else {}
            )
        except Exception:
            data = {}
        _fallback_cache = (mtime, data)
    return _fallback_cache[1]


def logo_stem(ticker: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in ticker.upper())


# 흰색/연한 로고(흰 배경 카드에서 안 보이는 것) 목록. detect_dark_logos.py 가
# 자동 생성. 프런트엔드는 이 목록의 로고에 brightness(0) 반전을 적용한다.
DARK_LOGO_PATH = LOGO_DIR.parent / "logo_dark.json"
# 파일 mtime이 바뀌면 자동 재로드 — detect_dark_logos.py 실행 후 서버 재시작 불필요.
_dark_logo_cache: tuple[float, set[str]] | None = None


def dark_logo_stems() -> set[str]:
    global _dark_logo_cache
    mtime = _file_mtime(DARK_LOGO_PATH)
    if _dark_logo_cache is None or _dark_logo_cache[0] != mtime:
        try:
            data = json.loads(DARK_LOGO_PATH.read_text()) if DARK_LOGO_PATH.exists() else []
            stems = {str(stem) for stem in data}
        except Exception:
            stems = set()
        _dark_logo_cache = (mtime, stems)
    return _dark_logo_cache[1]


def is_dark_logo(ticker: str) -> bool:
    return logo_stem(ticker) in dark_logo_stems()


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


def _png_dimensions(body: bytes | None) -> tuple[int, int] | None:
    if not body or len(body) < 24 or not body.startswith(PNG_MAGIC):
        return None
    width, height = struct.unpack(">II", body[16:24])
    return width, height


def _is_square_logo(body: bytes | None, max_aspect: float) -> bool:
    dims = _png_dimensions(body)
    if not dims:
        return False
    width, height = dims
    if width <= 0 or height <= 0:
        return False
    aspect = max(width / height, height / width)
    return width >= 48 and height >= 48 and len(body) > 400 and aspect <= max_aspect


def _http_get(url: str, timeout: float = 10.0) -> bytes | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=FAVICON_HEADERS), timeout=timeout) as resp:
            return resp.read()
    except Exception:
        return None


def resolve_company_domain(ticker: str) -> str | None:
    """yfinance 기업 홈페이지 도메인 — 정방형 파비콘 심볼 소스로 쓴다."""
    try:
        import yfinance as yf

        symbol = normalize_yfinance_symbol(ticker) or ticker
        info = yf.Ticker(symbol).info or {}
    except Exception:
        return None
    website = info.get("website") or info.get("websiteUrl") or ""
    netloc = urlparse(website if "//" in website else f"//{website}").netloc
    return netloc.replace("www.", "").strip().lower() or None


def fetch_square_symbol(domain: str | None, timeout: float = 10.0) -> tuple[bytes | None, str]:
    """도메인 파비콘에서 정방형 심볼 로고 — icon.horse(고해상)→gstatic→google.
    icon.horse '아이콘 없음' 플레이스홀더는 스킵, 정방형 PNG만 채택(가장 큰 것 우선)."""
    if not domain:
        return None, "no domain"
    sources = (
        ("icon.horse", f"https://icon.horse/icon/{domain}", min(timeout, 12.0)),
        ("gstatic", f"https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://{domain}&size=128", timeout),
        ("google", f"https://www.google.com/s2/favicons?domain={domain}&sz=128", timeout),
    )
    best: tuple[str, bytes, int] | None = None
    for name, url, source_timeout in sources:
        body = _http_get(url, timeout=source_timeout)
        if not _is_square_logo(body, FAVICON_MAX_ASPECT):
            continue
        if name == "icon.horse" and hashlib.md5(body).hexdigest().startswith(ICONHORSE_GENERIC_MD5):
            continue
        width = _png_dimensions(body)[0]
        if best is None or width > best[2]:
            best = (name, body, width)
    if best:
        return best[1], f"favicon:{best[0]}"
    return None, "no square favicon"


def _write_logo_png(ticker: str, body: bytes, logo_dir: Path = LOGO_DIR) -> Path:
    out_path = logo_dir / f"{logo_stem(ticker)}.png"
    tmp_path = out_path.with_suffix(".png.tmp")
    tmp_path.write_bytes(body)
    tmp_path.replace(out_path)
    svg_path = logo_dir / f"{logo_stem(ticker)}.svg"   # 잔존 플레이스홀더 제거
    if svg_path.exists():
        svg_path.unlink()
    return out_path


# 한국 ETF 운용사 브랜드 로고 — 대표 종목의 로고가 곧 브랜드 로고. 같은 브랜드의
# 모든 ETF는 개별 로고 대신 이 운용사 브랜드 로고를 공유한다.
KR_ETF_BRAND_SOURCES = {
    "KODEX": "278530.KS",   # 삼성자산운용
    "TIGER": "241180.KS",   # 미래에셋자산운용
    "ACE": "457480.KS",     # 한국투자신탁운용
    "SOL": "473330.KS",     # 신한자산운용
}


def _lookup_ticker_name(ticker: str) -> str | None:
    try:
        from .db import connect

        with connect() as conn:
            row = conn.execute("SELECT name FROM tickers WHERE ticker = ?", (ticker,)).fetchone()
        return row["name"] if row else None
    except Exception:
        return None


def kr_etf_brand_source(ticker: str, name: str | None) -> str | None:
    """한국 ETF면 운용사 브랜드 대표 종목(로고 출처)을 돌려준다.
    대표 종목 자신이거나 한국 ETF가 아니면 None."""
    if not ticker.upper().endswith((".KS", ".KQ")):
        return None
    upper_name = (name or "").strip().upper()
    for brand, source in KR_ETF_BRAND_SOURCES.items():
        if upper_name.startswith(brand) and source.upper() != ticker.upper():
            return source
    return None


def copy_ticker_logo(source_ticker: str, dest_ticker: str, logo_dir: Path = LOGO_DIR) -> dict | None:
    source_path = existing_logo_path(source_ticker, logo_dir)
    if not source_path:
        return None
    out_path = logo_dir / f"{logo_stem(dest_ticker)}{source_path.suffix}"
    out_path.write_bytes(source_path.read_bytes())
    for ext in ("png", "svg"):           # 다른 확장자 잔존본 제거(대체)
        other = logo_dir / f"{logo_stem(dest_ticker)}.{ext}"
        if other != out_path and other.exists():
            other.unlink()
    return {"saved": True, "path": out_path.name, "source": f"brand:{source_ticker}"}


def cache_logo(ticker: str, name: str | None = None, domain: str | None = None, keep_existing: bool = True, timeout: float = 8.0) -> dict:
    ticker = str(ticker or "").strip().upper()
    if not ticker:
        return {"saved": False, "error": "empty ticker"}

    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    existing = existing_logo_path(ticker)
    if keep_existing and existing:
        return {"saved": False, "path": existing.name, "source": "existing"}

    # 0) 한국 ETF → 운용사 브랜드 로고 우선(개별 로고 대신 KODEX·TIGER·ACE·SOL 등).
    brand_source = kr_etf_brand_source(ticker, name if name is not None else _lookup_ticker_name(ticker))
    if brand_source:
        copied = copy_ticker_logo(brand_source, ticker)
        if copied:
            return copied

    # 1) FMP — 정방형이면 그대로(깔끔한 심볼). 가로 워드마크면 보류.
    fmp_body = None
    last_status = "not tried"
    for symbol in candidate_symbols(ticker):
        body, status = fetch_logo(symbol, timeout=timeout)
        last_status = f"{symbol}: {status}"
        if body is not None:
            fmp_body = body
            break
    if _is_square_logo(fmp_body, FMP_MAX_ASPECT):
        out_path = _write_logo_png(ticker, fmp_body)
        return {"saved": True, "path": out_path.name, "source": "fmp"}

    # 2) FMP가 없거나 워드마크 → 기업 도메인 파비콘에서 정방형 심볼.
    domain = domain or resolve_company_domain(ticker)
    square_body, square_source = fetch_square_symbol(domain, timeout=timeout)
    if square_body is not None:
        out_path = _write_logo_png(ticker, square_body)
        return {"saved": True, "path": out_path.name, "source": square_source, "domain": domain}

    # 3) 정방형을 못 구하면 FMP 워드마크라도 저장(초기자 플레이스홀더보다 낫다).
    if fmp_body is not None:
        out_path = _write_logo_png(ticker, fmp_body)
        return {"saved": True, "path": out_path.name, "source": "fmp-wordmark"}

    # 4) 수동 폴백 복사.
    fallback = copy_fallback_logo(ticker)
    if fallback:
        return fallback
    return {"saved": False, "error": last_status}

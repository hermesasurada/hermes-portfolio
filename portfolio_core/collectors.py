from __future__ import annotations

import json
import re
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from html import unescape
from urllib.parse import quote
from typing import Any

from .constants import CRYPTO_MARKETS, MARKET_INDEXES
from .paths import KST
from .tickers import kr_ticker_code, normalize_yfinance_symbol, ticker_currency

FX_SYMBOLS = {
    "USDKRW": "USDKRW=X",
    "EURKRW": "EURKRW=X",
    "JPYKRW": "JPYKRW=X",
    "CNYKRW": "CNYKRW=X",
    "TWDKRW": "TWDKRW=X",
    "GBPKRW": "GBPKRW=X",
    "CHFKRW": "CHFKRW=X",
    "CADKRW": "CADKRW=X",
    "AUDKRW": "AUDKRW=X",
    "SGDKRW": "SGDKRW=X",
    "HKDKRW": "HKDKRW=X",
}
YAHOO_INDEX_SYMBOL_OVERRIDES = {"KOSPI": "^KS11"}
INVESTING_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
    "DNT": "1",
    "Referer": "https://kr.investing.com/",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
}


@dataclass(frozen=True)
class CollectedPrice:
    ticker: str
    price: float
    currency: str
    source: str
    price_date: str
    recent: list[dict[str, Any] | tuple[str, float]]


def _finite_number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _rows_from_frame(frame, tail: int | None = None) -> list[dict[str, Any]]:
    """pandas 일봉 프레임을 저장용 OHLC 행으로 정규화한다."""
    if frame is None or frame.empty or "Close" not in frame:
        return []
    selected = frame.tail(tail) if tail else frame
    rows: list[dict[str, Any]] = []
    for date, item in selected.iterrows():
        close = _finite_number(item.get("Close"))
        if close is None or close <= 0:
            continue
        rows.append(
            {
                "date": date.strftime("%Y-%m-%d"),
                "open": _finite_number(item.get("Open")),
                "high": _finite_number(item.get("High")),
                "low": _finite_number(item.get("Low")),
                "close": close,
                "volume": _finite_number(item.get("Volume")),
                "adj_close": _finite_number(item.get("Adj Close")),
            }
        )
    return rows


def _upbit_candle_row(item: dict) -> dict[str, Any] | None:
    date_text = str(item.get("candle_date_time_kst") or "")[:10]
    close = _finite_number(item.get("trade_price"))
    if not date_text or close is None or close <= 0:
        return None
    return {
        "date": date_text,
        "open": _finite_number(item.get("opening_price")),
        "high": _finite_number(item.get("high_price")),
        "low": _finite_number(item.get("low_price")),
        "close": close,
        "volume": _finite_number(item.get("candle_acc_trade_volume")),
        "adj_close": None,
    }


def recent_history_start(days: int = 30) -> str:
    return (datetime.now(KST).date() - timedelta(days=days)).strftime("%Y%m%d")


def fetch_kr_price(ticker: str, history_start: str | None = None) -> CollectedPrice | None:
    from FinanceDataReader import DataReader as fdr

    code = kr_ticker_code(ticker)
    df = fdr(code, history_start or recent_history_start())
    if df is None or df.empty or "Close" not in df:
        return None
    df = df.dropna(subset=["Close"])
    if df.empty:
        return None
    recent = _rows_from_frame(df, tail=7)
    price_date, price = recent[-1]["date"], recent[-1]["close"]
    return CollectedPrice(ticker, price, "KRW", "fdr", price_date, recent)


def fetch_history_rows(category: str, ticker: str, period: str = "10y") -> list[dict[str, Any]]:
    """장기 일별 OHLC — 신규 종목 및 캔들차트 과거 이력 백필용.

    일일 수집기는 해외 7일치 / KR history_start 이후만 받으므로, 새로 추가된
    종목은 RSI·볼린저·베타·기간수익률 계산에 필요한 과거가 비어버린다. 이 함수로
    가능한 전체 이력을 받아 채운다. (stock 보유 카테고리 overseas/kr 전용)
    """
    if category == "kr":
        from FinanceDataReader import DataReader as fdr

        code = kr_ticker_code(ticker)
        years = int(period[:-1]) if period.endswith("y") and period[:-1].isdigit() else 10
        start = f"{datetime.now(KST).year - years:04d}0101"
        df = fdr(code, start)
        if df is None or df.empty or "Close" not in df:
            return []
        df = df.dropna(subset=["Close"])
        return _rows_from_frame(df)

    if category == "crypto":
        meta = CRYPTO_MARKETS.get(str(ticker or "").strip().upper())
        if not meta:
            return []
        return fetch_crypto_history_rows(str(meta["market"]), days=3650)

    import yfinance as yf

    if category == "fx":
        symbol = FX_SYMBOLS.get(ticker, f"{ticker}=X")
    elif category == "index":
        meta = MARKET_INDEXES.get(ticker)
        symbol = YAHOO_INDEX_SYMBOL_OVERRIDES.get(ticker) or (str(meta["symbol"]) if meta else ticker)
    else:
        symbol = normalize_yfinance_symbol(ticker) or ticker
    hist = yf.Ticker(symbol).history(period=period, auto_adjust=False)
    if hist is None or hist.empty or "Close" not in hist:
        return []
    return _rows_from_frame(hist)


def fetch_yahoo_price(ticker: str, cache_ticker: str | None = None, currency: str | None = None) -> CollectedPrice | None:
    import yfinance as yf

    cache_ticker = cache_ticker or ticker
    currency = currency or ticker_currency(cache_ticker)
    stock = yf.Ticker(ticker)
    hist = stock.history(period="7d", auto_adjust=False)
    if hist is not None and not hist.empty and "Close" in hist:
        recent = _rows_from_frame(hist, tail=7)
        if recent:
            price_date, price = recent[-1]["date"], recent[-1]["close"]
            return CollectedPrice(cache_ticker, price, currency, "yf", price_date, recent)

    info = stock.info or {}
    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("regularMarketPreviousClose")
    if price:
        price_date = datetime.now(KST).strftime("%Y-%m-%d")
        return CollectedPrice(cache_ticker, float(price), currency, "yf", price_date, [(price_date, float(price))])
    return None


def yahoo_batch_target(category: str, ticker: str) -> tuple[str, str, str] | None:
    """배치 다운로드용 (저장 티커, Yahoo 심볼, 통화) 변환."""
    if category == "overseas":
        return ticker, normalize_yfinance_symbol(ticker) or ticker, ticker_currency(ticker)
    if category == "fx":
        return ticker, FX_SYMBOLS.get(ticker, f"{ticker}=X"), "FX"
    if category == "index" and ticker != "KOSPI":
        meta = MARKET_INDEXES.get(ticker)
        if meta:
            symbol = YAHOO_INDEX_SYMBOL_OVERRIDES.get(ticker) or str(meta["symbol"])
            return ticker, symbol, str(meta["currency"])
    return None


def _download_symbol_frame(frame, symbol: str, single_symbol: bool):
    """yfinance 단일/복수 다운로드의 컬럼 레벨 차이를 흡수한다."""
    if frame is None or frame.empty:
        return None
    columns = frame.columns
    if getattr(columns, "nlevels", 1) == 1:
        return frame if "Close" in columns else None
    level_zero = set(columns.get_level_values(0))
    level_one = set(columns.get_level_values(1))
    if symbol in level_zero:
        return frame[symbol]
    if symbol in level_one:
        return frame.xs(symbol, axis=1, level=1)
    if single_symbol and "Close" in level_zero:
        return frame.droplevel(1, axis=1)
    return None


def _download_close_series(frame, symbol: str, single_symbol: bool):
    """기존 호출부 호환용 종가 시리즈 헬퍼."""
    symbol_frame = _download_symbol_frame(frame, symbol, single_symbol)
    return symbol_frame["Close"] if symbol_frame is not None and "Close" in symbol_frame else None


def fetch_yahoo_prices_batch(
    targets: list[tuple[str, str, str]],
    chunk_size: int = 100,
) -> tuple[list[CollectedPrice], list[str]]:
    """Yahoo 대상의 최근 일봉을 묶어서 병렬 다운로드한다."""
    import yfinance as yf

    unique_targets = {
        cache_ticker: (cache_ticker, symbol, currency)
        for cache_ticker, symbol, currency in targets
    }
    ordered = list(unique_targets.values())
    fetched: list[CollectedPrice] = []
    errors: list[str] = []
    for offset in range(0, len(ordered), chunk_size):
        chunk = ordered[offset : offset + chunk_size]
        symbols = [symbol for _, symbol, _ in chunk]
        try:
            frame = yf.download(
                symbols,
                period="1mo",
                auto_adjust=False,
                actions=False,
                group_by="ticker",
                threads=True,
                progress=False,
            )
        except Exception as exc:
            # 청크 단위로 격리 — 한 청크가 터져도 앞서 성공한 청크의 결과를
            # 버리지 않는다. 실패분은 호출부가 개별 요청으로 재시도한다.
            print(f"[prices] yahoo batch chunk failed ({len(symbols)} symbols): {exc}")
            errors.extend(cache_ticker for cache_ticker, _symbol, _currency in chunk)
            continue
        single_symbol = len(symbols) == 1
        for cache_ticker, symbol, currency in chunk:
            try:
                symbol_frame = _download_symbol_frame(frame, symbol, single_symbol)
                recent = _rows_from_frame(symbol_frame, tail=7)
            except Exception:
                recent = []
            if not recent:
                errors.append(cache_ticker)
                continue
            price_date, price = recent[-1]["date"], recent[-1]["close"]
            fetched.append(
                CollectedPrice(cache_ticker, price, currency, "yf-batch", price_date, recent)
            )
    return fetched, errors


def fetch_yahoo_history_batch(
    targets: list[tuple[str, str, str]],
    period: str = "10y",
) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    """여러 Yahoo 종목의 장기 OHLC를 한 요청으로 내려받는다."""
    import yfinance as yf

    unique_targets = list({ticker: (ticker, symbol, currency) for ticker, symbol, currency in targets}.values())
    if not unique_targets:
        return {}, []
    symbols = [symbol for _, symbol, _ in unique_targets]
    frame = yf.download(
        symbols,
        period=period,
        auto_adjust=False,
        actions=False,
        group_by="ticker",
        threads=True,
        progress=False,
    )
    single_symbol = len(symbols) == 1
    result: dict[str, list[dict[str, Any]]] = {}
    errors: list[str] = []
    for cache_ticker, symbol, _currency in unique_targets:
        try:
            symbol_frame = _download_symbol_frame(frame, symbol, single_symbol)
            rows = _rows_from_frame(symbol_frame)
        except Exception:
            rows = []
        if rows:
            result[cache_ticker] = rows
        else:
            errors.append(cache_ticker)
    return result, errors


def normalize_earnings_date(value) -> str | None:
    if not value:
        return None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    text = str(value)
    return text[:10] if text else None


def fetch_yahoo_earnings_date(ticker: str) -> str | None:
    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker) or ticker
    calendar = yf.Ticker(symbol).calendar or {}
    return normalize_earnings_date(calendar.get("Earnings Date"))


def _date_from_korean_text(text: str) -> str | None:
    match = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", text)
    if not match:
        return None
    year, month, day = (int(part) for part in match.groups())
    return f"{year:04d}-{month:02d}-{day:02d}"


def fetch_investing_kr_earnings_date(ticker: str) -> str | None:
    code = kr_ticker_code(ticker)
    search_url = f"https://api.investing.com/api/search/v2/search?q={quote(code)}"
    headers = {**INVESTING_HEADERS, "Accept": "application/json"}
    req = urllib.request.Request(search_url, headers=headers)
    with urllib.request.urlopen(req, timeout=8) as resp:
        search = json.loads(resp.read().decode("utf-8"))

    quote_url = None
    for item in search.get("quotes") or []:
        if str(item.get("symbol") or "") != code:
            continue
        if item.get("exchange") != "Seoul" and item.get("flag") != "South_Korea":
            continue
        quote_url = item.get("url")
        break
    if not quote_url:
        return None

    earnings_url = f"https://kr.investing.com{quote_url}-earnings"
    req = urllib.request.Request(earnings_url, headers=INVESTING_HEADERS)
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8", "ignore")
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", unescape(body)))

    faq_match = re.search(r"다음 실적[^?]{0,160}?(\d{4}년\s*\d{1,2}월\s*\d{1,2}일)", text)
    if faq_match:
        return _date_from_korean_text(faq_match.group(1))
    table_match = re.search(r"발표일\s+마감 기준.*?(\d{4}년\s*\d{1,2}월\s*\d{1,2}일)", text)
    if table_match:
        return _date_from_korean_text(table_match.group(1))
    return None


def fetch_fx_price(label: str) -> CollectedPrice | None:
    symbol = FX_SYMBOLS.get(label, f"{label}=X")
    return fetch_yahoo_price(symbol, cache_ticker=label, currency="FX")


def fetch_index_price(label: str, history_start: str | None = None) -> CollectedPrice | None:
    meta = MARKET_INDEXES.get(label)
    if not meta:
        return None
    if label == "KOSPI":
        from FinanceDataReader import DataReader as fdr

        try:
            df = fdr(meta["symbol"], history_start or recent_history_start())
        except Exception:
            df = None
        if df is None or df.empty or "Close" not in df:
            return fetch_yahoo_price(
                YAHOO_INDEX_SYMBOL_OVERRIDES["KOSPI"],
                cache_ticker=label,
                currency=meta["currency"],
            )
        recent = _rows_from_frame(df.dropna(subset=["Close"]), tail=7)
        if not recent:
            return None
        price_date, price = recent[-1]["date"], recent[-1]["close"]
        return CollectedPrice(label, price, meta["currency"], "fdr-index", price_date, recent)
    return fetch_yahoo_price(meta["symbol"], cache_ticker=label, currency=meta["currency"])


def fetch_crypto_krw(ticker: str) -> CollectedPrice | None:
    ticker = str(ticker or "").strip().upper()
    meta = CRYPTO_MARKETS.get(ticker)
    if not meta:
        return None
    market = str(meta["market"])
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        f"https://api.upbit.com/v1/ticker?markets={market}",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        data = json.loads(resp.read())
    if not data:
        return None
    price = float(data[0].get("trade_price") or 0)
    if price <= 0:
        return None
    price_date = datetime.now(KST).strftime("%Y-%m-%d")
    recent = fetch_crypto_daily_rows(market)
    if recent and recent[-1]["date"] == price_date:
        recent[-1] = {
            **recent[-1],
            "high": max(float(recent[-1].get("high") or price), price),
            "low": min(float(recent[-1].get("low") or price), price),
            "close": price,
        }
    elif recent:
        recent.append({"date": price_date, "open": price, "high": price, "low": price, "close": price})
    else:
        recent = [{"date": price_date, "open": price, "high": price, "low": price, "close": price}]
    return CollectedPrice(ticker, price, str(meta["currency"]), "upbit", price_date, recent[-7:])


def fetch_crypto_daily_rows(market: str, count: int = 7) -> list[dict[str, Any]]:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        f"https://api.upbit.com/v1/candles/days?market={market}&count={count}",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        data = json.loads(resp.read())
    rows = [row for item in data or [] if (row := _upbit_candle_row(item)) is not None]
    return sorted(rows, key=lambda row: row["date"])


def fetch_crypto_history_rows(market: str, days: int = 3650) -> list[dict[str, Any]]:
    """Upbit KRW daily candles for long-horizon crypto technical indicators."""
    ctx = ssl.create_default_context()
    rows: dict[str, dict[str, Any]] = {}
    to_dt: datetime | None = None
    remaining = max(1, int(days))
    while remaining > 0:
        count = min(200, remaining)
        url = f"https://api.upbit.com/v1/candles/days?market={market}&count={count}"
        if to_dt is not None:
            url += f"&to={quote(to_dt.strftime('%Y-%m-%dT%H:%M:%S'))}"
        req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
        data = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
                    data = json.loads(resp.read())
                break
            except urllib.error.HTTPError as exc:
                if exc.code != 429 or attempt == 3:
                    raise
                time.sleep(1.0 * (attempt + 1))
        time.sleep(0.15)
        if not data:
            break
        oldest_utc = None
        for item in data:
            candle = _upbit_candle_row(item)
            if candle is not None:
                rows[candle["date"]] = candle
            utc_text = str(item.get("candle_date_time_utc") or "")
            if utc_text:
                parsed = datetime.strptime(utc_text[:19], "%Y-%m-%dT%H:%M:%S")
                oldest_utc = parsed if oldest_utc is None else min(oldest_utc, parsed)
        if len(data) < count or oldest_utc is None:
            break
        to_dt = oldest_utc - timedelta(seconds=1)
        remaining -= len(data)
    return [rows[key] for key in sorted(rows)]


def fetch_price(category: str, ticker: str, history_start: str | None = None) -> CollectedPrice | None:
    if category == "kr":
        return fetch_kr_price(ticker, history_start)
    if category == "fx":
        return fetch_fx_price(ticker)
    if category == "index":
        return fetch_index_price(ticker, history_start)
    if category == "crypto":
        return fetch_crypto_krw(ticker)
    return fetch_yahoo_price(ticker)

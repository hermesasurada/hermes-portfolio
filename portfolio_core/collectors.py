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
    recent: list[tuple[str, float]]


def _rows_from_close_series(series) -> list[tuple[str, float]]:
    closes = series.dropna()
    return [(date.strftime("%Y-%m-%d"), float(price)) for date, price in closes.tail(7).items()]


def fetch_kr_price(ticker: str, history_start: str = "20250101") -> CollectedPrice | None:
    from FinanceDataReader import DataReader as fdr

    code = kr_ticker_code(ticker)
    df = fdr(code, history_start)
    if df is None or df.empty or "Close" not in df:
        return None
    df = df.dropna(subset=["Close"])
    if df.empty:
        return None
    recent = [
        (date.strftime("%Y-%m-%d"), float(row["Close"]))
        for date, row in df.tail(7).iterrows()
    ]
    price_date, price = recent[-1]
    return CollectedPrice(ticker, price, "KRW", "fdr", price_date, recent)


def fetch_history_rows(category: str, ticker: str, period: str = "10y") -> list[tuple[str, float]]:
    """장기 일별 종가 — 신규 보유 종목의 과거 이력 1회 백필용.

    일일 수집기는 해외 7일치 / KR history_start 이후만 받으므로, 새로 추가된
    종목은 RSI·볼린저·베타·기간수익률 계산에 필요한 과거가 비어버린다. 이 함수로
    가능한 전체 이력을 받아 채운다. (stock 보유 카테고리 overseas/kr 전용)
    """
    if category == "kr":
        from FinanceDataReader import DataReader as fdr

        code = kr_ticker_code(ticker)
        df = fdr(code, "20150101")
        if df is None or df.empty or "Close" not in df:
            return []
        df = df.dropna(subset=["Close"])
        return [
            (date.strftime("%Y-%m-%d"), float(row["Close"]))
            for date, row in df.iterrows()
            if row["Close"] and row["Close"] > 0
        ]

    if category == "crypto":
        meta = CRYPTO_MARKETS.get(str(ticker or "").strip().upper())
        if not meta:
            return []
        return fetch_crypto_history_rows(str(meta["market"]), days=3650)

    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker) or ticker
    hist = yf.Ticker(symbol).history(period=period, auto_adjust=False)
    if hist is None or hist.empty or "Close" not in hist:
        return []
    closes = hist["Close"].dropna()
    return [
        (date.strftime("%Y-%m-%d"), float(price))
        for date, price in closes.items()
        if price == price and price > 0
    ]


def fetch_yahoo_price(ticker: str, cache_ticker: str | None = None, currency: str | None = None) -> CollectedPrice | None:
    import yfinance as yf

    cache_ticker = cache_ticker or ticker
    currency = currency or ticker_currency(cache_ticker)
    stock = yf.Ticker(ticker)
    hist = stock.history(period="7d")
    if hist is not None and not hist.empty and "Close" in hist:
        recent = _rows_from_close_series(hist["Close"])
        if recent:
            price_date, price = recent[-1]
            return CollectedPrice(cache_ticker, price, currency, "yf", price_date, recent)

    info = stock.info or {}
    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("regularMarketPreviousClose")
    if price:
        price_date = datetime.now(KST).strftime("%Y-%m-%d")
        return CollectedPrice(cache_ticker, float(price), currency, "yf", price_date, [(price_date, float(price))])
    return None


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


def fetch_index_price(label: str) -> CollectedPrice | None:
    meta = MARKET_INDEXES.get(label)
    if not meta:
        return None
    if label == "KOSPI":
        from FinanceDataReader import DataReader as fdr

        df = fdr(meta["symbol"], "20250101")
        if df is None or df.empty or "Close" not in df:
            return None
        recent = [
            (date.strftime("%Y-%m-%d"), float(row["Close"]))
            for date, row in df.dropna(subset=["Close"]).tail(7).iterrows()
        ]
        if not recent:
            return None
        price_date, price = recent[-1]
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
    if recent and recent[-1][0] == price_date:
        recent[-1] = (price_date, price)
    elif recent:
        recent.append((price_date, price))
    else:
        recent = [(price_date, price)]
    return CollectedPrice(ticker, price, str(meta["currency"]), "upbit", price_date, recent[-7:])


def fetch_crypto_daily_rows(market: str, count: int = 7) -> list[tuple[str, float]]:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        f"https://api.upbit.com/v1/candles/days?market={market}&count={count}",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        data = json.loads(resp.read())
    rows = []
    for item in data or []:
        date_text = str(item.get("candle_date_time_kst") or "")[:10]
        price = item.get("trade_price")
        if date_text and price not in (None, 0):
            rows.append((date_text, float(price)))
    return sorted(rows)


def fetch_crypto_history_rows(market: str, days: int = 3650) -> list[tuple[str, float]]:
    """Upbit KRW daily candles for long-horizon crypto technical indicators."""
    ctx = ssl.create_default_context()
    rows: dict[str, float] = {}
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
            date_text = str(item.get("candle_date_time_kst") or "")[:10]
            price = item.get("trade_price")
            if date_text and price not in (None, 0):
                rows[date_text] = float(price)
            utc_text = str(item.get("candle_date_time_utc") or "")
            if utc_text:
                parsed = datetime.strptime(utc_text[:19], "%Y-%m-%dT%H:%M:%S")
                oldest_utc = parsed if oldest_utc is None else min(oldest_utc, parsed)
        if len(data) < count or oldest_utc is None:
            break
        to_dt = oldest_utc - timedelta(seconds=1)
        remaining -= len(data)
    return sorted(rows.items())


def fetch_price(category: str, ticker: str, history_start: str = "20250101") -> CollectedPrice | None:
    if category == "kr":
        return fetch_kr_price(ticker, history_start)
    if category == "fx":
        return fetch_fx_price(ticker)
    if category == "index":
        return fetch_index_price(ticker)
    if category == "crypto":
        return fetch_crypto_krw(ticker)
    return fetch_yahoo_price(ticker)

from __future__ import annotations

import json
import re
import ssl
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from html import unescape
from urllib.parse import quote

from .constants import MARKET_INDEXES
from .paths import KST
from .tickers import normalize_yfinance_symbol, ticker_currency

FX_SYMBOLS = {"USDKRW": "USDKRW=X", "EURKRW": "EURKRW=X", "JPYKRW": "JPYKRW=X"}
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

    code = ticker.replace(".KS", "").replace(".KQ", "")
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
    code = ticker.split(".")[0]
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


def fetch_btc_krw() -> CollectedPrice | None:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        "https://api.upbit.com/v1/ticker?markets=KRW-BTC",
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
    return CollectedPrice("BTC", price, "KRW", "upbit", price_date, [(price_date, price)])


def fetch_price(category: str, ticker: str, history_start: str = "20250101") -> CollectedPrice | None:
    if category == "kr":
        return fetch_kr_price(ticker, history_start)
    if category == "fx":
        return fetch_fx_price(ticker)
    if category == "index":
        return fetch_index_price(ticker)
    if category == "crypto" and ticker == "BTC":
        return fetch_btc_krw()
    return fetch_yahoo_price(ticker)

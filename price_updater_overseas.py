#!/usr/bin/env python3
"""Price Updater — 해외주식, 환율, BTC.

소스: ~/.hermes/data/stock_history.db tickers.category
저장: daily_prices, helper cache
한국주식(.KS/.KQ)은 price_updater_kr.py 담당.
"""

import json
import ssl
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed")
    exit(1)

from price_cache_utils import load_cache, save_cache, ticker_currency

def update_daily_prices(ticker: str, price: float, date_str: str = None, source: str = "yf"):
    """daily_prices 테이블에 실제 거래일 기준 가격 저장."""
    if date_str is None:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    
    try:
        import sqlite3
        DB_PATH = Path.home() / ".hermes" / "data" / "stock_history.db"
        conn = sqlite3.connect(str(DB_PATH))
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO daily_prices 
            (date, ticker, close, source)
            VALUES (?, ?, ?, ?)
        """, (date_str, ticker, price, source))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"  [DB] {ticker} 저장 실패: {e}")


def load_watch() -> dict:
    """tickers 테이블에서 category별로 조회"""
    try:
        import sqlite3
        DB_PATH = Path.home() / ".hermes" / "data" / "stock_history.db"
        conn = sqlite3.connect(str(DB_PATH))
        cursor = conn.cursor()
        cursor.execute("SELECT ticker, category FROM tickers")
        rows = cursor.fetchall()
        conn.close()
        
        result = {"overseas": [], "kr": [], "fx": [], "crypto": []}
        for ticker, category in rows:
            if not category:
                cur = ticker_currency(ticker)
                if ticker == "BTC":
                    category = "crypto"
                elif ticker in {"USDKRW", "EURKRW", "JPYKRW"}:
                    category = "fx"
                elif cur == "KRW":
                    category = "kr"
                else:
                    category = "overseas"
            if category in result:
                result[category].append(ticker)
        return result
    except Exception as e:
        print(f"ERROR: tickers 테이블 조회 실패 - {e}")
        return {"overseas": [], "kr": [], "fx": [], "crypto": []}


def fetch_yf_prices(ticker):
    try:
        stock = yf.Ticker(ticker)
        hist = stock.history(period="7d")
        if hist is not None and not hist.empty and "Close" in hist:
            closes = hist["Close"].dropna()
            if not closes.empty:
                recent = [
                    (date.strftime("%Y-%m-%d"), float(price))
                    for date, price in closes.tail(7).items()
                ]
                latest_date, latest_price = recent[-1]
                return latest_price, latest_date, recent
        info = stock.info or {}
        price = info.get("currentPrice") or info.get("regularMarketPrice")
        if price:
            date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            return float(price), date_str, [(date_str, float(price))]
        prev = info.get("regularMarketPreviousClose")
        if prev and prev > 0:
            date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            return float(prev), date_str, [(date_str, float(prev))]
    except Exception as e:
        print(f"  ✗ {ticker}: {e}")
    return None


def fetch_btc_krw():
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(
            "https://api.upbit.com/v1/ticker?markets=KRW-BTC",
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read())
            if data:
                return data[0].get("trade_price", 0)
    except Exception as e:
        print(f"  ✗ Upbit API: {e}")
    return None


def main():
    watch = load_watch()
    cache = load_cache()
    cache.setdefault("updated", "")
    cache.setdefault("prices", {})

    now = datetime.now(timezone.utc).isoformat()
    fetched, errors = [], []
    updates = {}

    # ── 1. 환율 (fx) ──
    fx_map = {"USDKRW": "USDKRW=X", "EURKRW": "EURKRW=X", "JPYKRW": "JPYKRW=X"}
    for label in watch.get("fx", []):
        yf_ticker = fx_map.get(label, label + "=X")
        result = fetch_yf_prices(yf_ticker)
        if result:
            price, price_date, recent = result
            cache["prices"][label] = {"price": price, "currency": "FX", "source": "yf"}
            updates[label] = (recent, "yf")
            fetched.append(f"{label}: {price:.2f} ({price_date})")
        else:
            errors.append(label)

    # ── 2. BTC (crypto) ──
    for label in watch.get("crypto", []):
        if label == "BTC":
            price = fetch_btc_krw()
            if price:
                cache["prices"]["BTC"] = {"price": price, "currency": "KRW", "source": "upbit"}
                today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                updates["BTC"] = ([(today, price)], "upbit")
                fetched.append(f"BTC: {price:,.0f}원")
            else:
                errors.append("BTC")

    # ── 3. 해외주식 (overseas) ──
    for ticker in watch.get("overseas", []):
        result = fetch_yf_prices(ticker)
        if result:
            price, price_date, recent = result
            currency = ticker_currency(ticker)
            cache["prices"][ticker] = {"price": price, "currency": currency, "source": "yf"}
            updates[ticker] = (recent, "yf")
            sym = {"USD": "$", "EUR": "€", "JPY": "¥", "KRW": "원"}.get(currency, "")
            fetched.append(f"{ticker}: {price:,.2f}{sym} ({price_date})")
        else:
            errors.append(ticker)

    cache["updated"] = now
    save_cache(cache)

    for label, (recent, source) in updates.items():
        for price_date, price in recent:
            update_daily_prices(label, price, price_date, source)

    print(f"✅ Updated at {now}")
    print(f"   Fetched {len(fetched)}: {', '.join(fetched)}")
    if errors:
        print(f"   ❌ Failed: {', '.join(errors)}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Price Updater — 한국주식 (.KS/.KQ) via FinanceDataReader.

소스: ~/.hermes/data/stock_history.db tickers.category
저장: daily_prices, helper cache
해외주식/환율은 price_updater_overseas.py 담당.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

try:
    from FinanceDataReader import DataReader as FDR
except ImportError:
    print("ERROR: finance-datareader not installed (pip3 install finance-datareader)")
    exit(1)

from price_cache_utils import load_cache, save_cache, ticker_currency

def update_daily_prices(ticker: str, price: float, date_str: str = None):
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
        """, (date_str, ticker, price, "fdr"))
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
                category = "kr" if cur == "KRW" and ticker != "BTC" else "overseas"
            if category in result:
                result[category].append(ticker)
        return result
    except Exception as e:
        print(f"ERROR: tickers 테이블 조회 실패 - {e}")
        return {"overseas": [], "kr": [], "fx": [], "crypto": []}


def fetch_kr_prices(ticker):
    code = ticker.replace(".KS", "").replace(".KQ", "")
    try:
        df = FDR(code, "20250101")
        if len(df) > 0:
            df = df.dropna(subset=["Close"])
            if len(df) > 0:
                recent = [
                    (date.strftime("%Y-%m-%d"), float(row["Close"]))
                    for date, row in df.tail(7).iterrows()
                ]
                latest_date, latest_price = recent[-1]
                return latest_price, latest_date, recent
    except Exception as e:
        print(f"  ✗ {ticker} (FDR): {e}")
    return None


def main():
    watch = load_watch()
    cache = load_cache()
    cache.setdefault("updated", "")
    cache.setdefault("prices", {})

    now = datetime.now(timezone.utc).isoformat()
    fetched, errors = [], []
    updates = {}

    for ticker in watch.get("kr", []):
        result = fetch_kr_prices(ticker)
        if result:
            price, price_date, recent = result
            cache["prices"][ticker] = {"price": price, "currency": "KRW", "source": "fdr"}
            updates[ticker] = recent
            fetched.append(f"{ticker}: {price:,.0f}원 ({price_date})")
        else:
            errors.append(ticker)

    cache["updated"] = now
    save_cache(cache)

    for ticker, recent in updates.items():
        for price_date, price in recent:
            update_daily_prices(ticker, price, price_date)

    print(f"✅ Updated at {now}")
    print(f"   Fetched {len(fetched)} Korean prices")
    if errors:
        print(f"   ❌ Failed ({len(errors)}): {', '.join(errors)}")
    else:
        print(f"   All {len(fetched)} kr tickers updated.")


if __name__ == "__main__":
    main()

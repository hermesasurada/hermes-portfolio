from __future__ import annotations

from datetime import datetime

from .db import connect
from .fundamentals import fetch_fundamentals
from .paths import KST
from .technical_stats import load_technical_stats_cache


def load_stats(tickers: list[str]) -> dict:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return {"stats": {}, "updated": datetime.now(KST).isoformat(timespec="seconds")}
    with connect() as conn:
        technical = load_technical_stats_cache(conn, clean_tickers)
        # The stats tab must stay read-only/low-latency. Fundamental refreshes
        # and RSI/BB/performance refreshes are handled by price/watchlist jobs.
        fundamentals = fetch_fundamentals(conn, clean_tickers, refresh_stale=False)
    return {
        "updated": datetime.now(KST).isoformat(timespec="seconds"),
        "stats": {
            ticker: {**technical.get(ticker, {}), **fundamentals.get(ticker, {})}
            for ticker in clean_tickers
        },
    }

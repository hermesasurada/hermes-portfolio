from __future__ import annotations

from datetime import datetime

from .db import connect
from .fundamentals import fetch_fundamentals
from .indicators import bollinger_pband, recent_performance, resample_last, rsi_value
from .paths import KST


def load_stats(tickers: list[str]) -> dict:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return {"stats": {}, "updated": datetime.now(KST).isoformat(timespec="seconds")}
    technical: dict[str, dict] = {}
    with connect() as conn:
        for ticker in clean_tickers:
            rows = conn.execute(
                """
                SELECT date, close
                FROM daily_prices
                WHERE ticker = ? AND close IS NOT NULL
                ORDER BY date
                """,
                (ticker,),
            ).fetchall()
            daily = [float(row["close"]) for row in rows]
            weekly = resample_last(rows, "week")
            monthly = resample_last(rows, "month")
            technical[ticker] = {
                "rsi": {
                    "day": rsi_value(daily),
                    "week": rsi_value(weekly),
                    "month": rsi_value(monthly),
                },
                "bollinger_pband": {
                    "day": bollinger_pband(daily),
                    "week": bollinger_pband(weekly),
                    "month": bollinger_pband(monthly),
                },
                "performance": recent_performance(rows),
            }
        fundamentals = fetch_fundamentals(conn, clean_tickers)
    return {
        "updated": datetime.now(KST).isoformat(timespec="seconds"),
        "stats": {
            ticker: {**technical.get(ticker, {}), **fundamentals.get(ticker, {})}
            for ticker in clean_tickers
        },
    }

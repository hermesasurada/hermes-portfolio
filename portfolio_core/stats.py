from __future__ import annotations

import json
from datetime import datetime

from .db import connect, ensure_technical_stats_cache_table
from .fundamentals import fetch_fundamentals
from .indicators import bollinger_pband, recent_performance, resample_last, rsi_value
from .paths import KST

TECHNICAL_CACHE_VERSION = 1


def technical_stats(rows: list) -> dict:
    daily = [float(row["close"]) for row in rows]
    weekly = resample_last(rows, "week")
    monthly = resample_last(rows, "month")
    return {
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


def placeholders(items: list[str]) -> str:
    return ",".join("?" for _ in items)


def load_stats(tickers: list[str]) -> dict:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return {"stats": {}, "updated": datetime.now(KST).isoformat(timespec="seconds")}
    technical: dict[str, dict] = {}
    with connect() as conn:
        ensure_technical_stats_cache_table(conn)
        price_meta = {
            row["ticker"]: {"price_count": int(row["price_count"] or 0), "latest_date": row["latest_date"]}
            for row in conn.execute(
                f"""
                SELECT ticker, COUNT(date) AS price_count, MAX(date) AS latest_date
                FROM daily_prices
                WHERE ticker IN ({placeholders(clean_tickers)}) AND close IS NOT NULL
                GROUP BY ticker
                """,
                clean_tickers,
            ).fetchall()
        }
        cached = {
            row["ticker"]: row
            for row in conn.execute(
                f"""
                SELECT ticker, latest_date, price_count, payload_json
                FROM ticker_technical_stats_cache
                WHERE version = ? AND ticker IN ({placeholders(clean_tickers)})
                """,
                [TECHNICAL_CACHE_VERSION, *clean_tickers],
            ).fetchall()
        }
        stale_tickers: list[str] = []
        for ticker in clean_tickers:
            meta = price_meta.get(ticker, {"price_count": 0, "latest_date": None})
            row = cached.get(ticker)
            if row and row["latest_date"] == meta["latest_date"] and int(row["price_count"] or 0) == meta["price_count"]:
                try:
                    technical[ticker] = json.loads(row["payload_json"])
                    continue
                except json.JSONDecodeError:
                    pass
            stale_tickers.append(ticker)

        if stale_tickers:
            grouped: dict[str, list] = {ticker: [] for ticker in stale_tickers}
            rows = conn.execute(
                f"""
                SELECT ticker, date, close
                FROM daily_prices
                WHERE ticker IN ({placeholders(stale_tickers)}) AND close IS NOT NULL
                ORDER BY ticker, date
                """,
                stale_tickers,
            ).fetchall()
            for row in rows:
                grouped[row["ticker"]].append(row)
            now_text = datetime.now(KST).isoformat(timespec="seconds")
            for ticker in stale_tickers:
                payload = technical_stats(grouped.get(ticker, []))
                technical[ticker] = payload
                meta = price_meta.get(ticker, {"price_count": 0, "latest_date": None})
                conn.execute(
                    """
                    INSERT INTO ticker_technical_stats_cache
                      (ticker, version, latest_date, price_count, computed_at, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(ticker) DO UPDATE SET
                      version = excluded.version,
                      latest_date = excluded.latest_date,
                      price_count = excluded.price_count,
                      computed_at = excluded.computed_at,
                      payload_json = excluded.payload_json
                    """,
                    (
                        ticker,
                        TECHNICAL_CACHE_VERSION,
                        meta["latest_date"],
                        meta["price_count"],
                        now_text,
                        json.dumps(payload, ensure_ascii=False),
                    ),
                )
        # The stats tab must stay read-only/low-latency. Fundamental refreshes
        # are handled by price/watchlist hydration jobs, not by page loads.
        fundamentals = fetch_fundamentals(conn, clean_tickers, refresh_stale=False)
        conn.commit()
    return {
        "updated": datetime.now(KST).isoformat(timespec="seconds"),
        "stats": {
            ticker: {**technical.get(ticker, {}), **fundamentals.get(ticker, {})}
            for ticker in clean_tickers
        },
    }

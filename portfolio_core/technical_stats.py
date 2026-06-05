from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from typing import Iterable

from .db import connect, ensure_technical_stats_cache_table
from .indicators import bollinger_pband, recent_performance, resample_last, rsi_value, technical_indicators_available
from .paths import KST

TECHNICAL_CACHE_VERSION = 1


def placeholders(items: list[str]) -> str:
    return ",".join("?" for _ in items)


TRADING_DAYS_52W = 252


def high_52w_drawdown(daily: list[float]) -> float | None:
    """현재가의 52주(~252거래일) 최고점 대비 하락폭(%). 고점이면 0, 아래면 음수."""
    window = [c for c in daily[-TRADING_DAYS_52W:] if c is not None and c > 0]
    if len(window) < 2:
        return None
    peak = max(window)
    if peak <= 0:
        return None
    return round((window[-1] / peak - 1) * 100, 2)


def calculate_technical_stats(rows: list[sqlite3.Row]) -> dict:
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
        "drawdown_52w": high_52w_drawdown(daily),
    }


def normalize_tickers(tickers: Iterable[str]) -> list[str]:
    return sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})


def load_technical_stats_cache(conn: sqlite3.Connection, tickers: Iterable[str]) -> dict[str, dict]:
    clean_tickers = normalize_tickers(tickers)
    if not clean_tickers:
        return {}
    ensure_technical_stats_cache_table(conn)
    rows = conn.execute(
        f"""
        SELECT c.ticker, c.latest_date, c.price_count, c.payload_json,
               pm.latest_date AS current_latest_date,
               COALESCE(pm.price_count, 0) AS current_price_count
        FROM ticker_technical_stats_cache c
        LEFT JOIN (
            SELECT ticker, COUNT(date) AS price_count, MAX(date) AS latest_date
            FROM daily_prices
            WHERE ticker IN ({placeholders(clean_tickers)}) AND close IS NOT NULL
            GROUP BY ticker
        ) pm ON pm.ticker = c.ticker
        WHERE c.version = ? AND c.ticker IN ({placeholders(clean_tickers)})
        """,
        [*clean_tickers, TECHNICAL_CACHE_VERSION, *clean_tickers],
    ).fetchall()
    result: dict[str, dict] = {}
    for row in rows:
        if row["latest_date"] != row["current_latest_date"]:
            continue
        if int(row["price_count"] or 0) != int(row["current_price_count"] or 0):
            continue
        try:
            result[row["ticker"]] = json.loads(row["payload_json"])
        except json.JSONDecodeError:
            continue
    return result


def refresh_technical_stats_cache(tickers: Iterable[str]) -> int:
    clean_tickers = normalize_tickers(tickers)
    if not clean_tickers:
        return 0
    if not technical_indicators_available():
        print("[stats] skipped technical stats refresh; pandas/ta is not available in this Python environment")
        return 0
    with connect() as conn:
        ensure_technical_stats_cache_table(conn)
        grouped: dict[str, list[sqlite3.Row]] = {ticker: [] for ticker in clean_tickers}
        rows = conn.execute(
            f"""
            SELECT ticker, date, close
            FROM daily_prices
            WHERE ticker IN ({placeholders(clean_tickers)}) AND close IS NOT NULL
            ORDER BY ticker, date
            """,
            clean_tickers,
        ).fetchall()
        for row in rows:
            grouped[row["ticker"]].append(row)
        now_text = datetime.now(KST).isoformat(timespec="seconds")
        updated = 0
        for ticker in clean_tickers:
            price_rows = grouped.get(ticker, [])
            payload = calculate_technical_stats(price_rows)
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
                    price_rows[-1]["date"] if price_rows else None,
                    len(price_rows),
                    now_text,
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            updated += 1
        conn.commit()
        return updated

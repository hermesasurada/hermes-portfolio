from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from typing import Iterable

from .db import connect, ensure_daily_technical_indicators_table, ensure_technical_stats_cache_table
from .indicators import bollinger_pband, recent_performance, resample_last, rsi_series, rsi_value, technical_indicators_available
from .paths import KST

TECHNICAL_CACHE_VERSION = 2
DAILY_RSI_REFRESH_ROWS = 90
BETA_BENCHMARK = "SP500"
BETA_WINDOW = 180


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


def _returns(closes: list[float]) -> list[float]:
    return [closes[index] / closes[index - 1] - 1 for index in range(1, len(closes)) if closes[index - 1]]


def beta_stats(rows: list[sqlite3.Row], benchmark_rows: list[sqlite3.Row]) -> dict[str, float | None]:
    stock = {row["date"]: float(row["close"]) for row in rows[-400:]}
    benchmark = {row["date"]: float(row["close"]) for row in benchmark_rows[-400:]}
    common = sorted(set(stock) & set(benchmark))[-(BETA_WINDOW + 1):]
    if len(common) < 40:
        return {"beta": None, "beta_adj": None}
    stock_returns = _returns([stock[day] for day in common])
    market_returns = _returns([benchmark[day] for day in common])
    count = min(len(stock_returns), len(market_returns))
    if count < 30:
        return {"beta": None, "beta_adj": None}
    stock_returns = stock_returns[-count:]
    market_returns = market_returns[-count:]
    stock_mean = sum(stock_returns) / count
    market_mean = sum(market_returns) / count
    market_variance = sum((value - market_mean) ** 2 for value in market_returns) / count
    stock_variance = sum((value - stock_mean) ** 2 for value in stock_returns) / count
    if market_variance <= 0:
        return {"beta": None, "beta_adj": None}
    covariance = sum(
        (stock_returns[index] - stock_mean) * (market_returns[index] - market_mean)
        for index in range(count)
    ) / count
    return {
        "beta": round(covariance / market_variance, 2),
        "beta_adj": round((stock_variance / market_variance) ** 0.5, 2),
    }


def calculate_technical_stats(
    rows: list[sqlite3.Row],
    daily_rsi: list[float | None] | None = None,
    benchmark_rows: list[sqlite3.Row] | None = None,
) -> dict:
    daily = [float(row["close"]) for row in rows]
    weekly = resample_last(rows, "week")
    monthly = resample_last(rows, "month")
    latest_daily_rsi = next(
        (value for value in reversed(daily_rsi or []) if value is not None),
        None,
    )
    return {
        "rsi": {
            "day": latest_daily_rsi if daily_rsi is not None else rsi_value(daily),
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
        **beta_stats(rows, benchmark_rows or []),
    }


def upsert_daily_rsi(
    conn: sqlite3.Connection,
    ticker: str,
    rows: list[sqlite3.Row],
    values: list[float | None],
    computed_at: str,
) -> None:
    existing_rows = conn.execute(
        """
        SELECT date, rsi_14
        FROM daily_technical_indicators
        WHERE ticker = ?
        ORDER BY date DESC
        LIMIT ?
        """,
        (ticker, DAILY_RSI_REFRESH_ROWS),
    ).fetchall()
    existing = {
        row["date"]: float(row["rsi_14"])
        for row in existing_rows
        if row["rsi_14"] is not None
    }
    start = 0 if not existing_rows else max(0, len(rows) - DAILY_RSI_REFRESH_ROWS)
    entries = [
        (ticker, row["date"], value, computed_at)
        for row, value in zip(rows[start:], values[start:])
        if value is not None
        and (
            row["date"] not in existing
            or abs(existing[row["date"]] - value) > 0.0000001
        )
    ]
    if not entries:
        return
    conn.executemany(
        """
        INSERT INTO daily_technical_indicators (ticker, date, rsi_14, computed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ticker, date) DO UPDATE SET
          rsi_14 = excluded.rsi_14,
          computed_at = excluded.computed_at
        """,
        entries,
    )


def normalize_tickers(tickers: Iterable[str]) -> list[str]:
    return sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})


def load_technical_stats_cache(conn: sqlite3.Connection, tickers: Iterable[str]) -> dict[str, dict]:
    clean_tickers = normalize_tickers(tickers)
    if not clean_tickers:
        return {}
    rows = conn.execute(
        f"""
        SELECT ticker, payload_json
        FROM ticker_technical_stats_cache
        WHERE version = ? AND ticker IN ({placeholders(clean_tickers)})
        """,
        [TECHNICAL_CACHE_VERSION, *clean_tickers],
    ).fetchall()
    result: dict[str, dict] = {}
    for row in rows:
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
        ensure_daily_technical_indicators_table(conn)
        query_tickers = sorted(set(clean_tickers) | {BETA_BENCHMARK})
        grouped: dict[str, list[sqlite3.Row]] = {ticker: [] for ticker in query_tickers}
        rows = conn.execute(
            f"""
            SELECT ticker, date, close
            FROM daily_prices
            WHERE ticker IN ({placeholders(query_tickers)}) AND close IS NOT NULL
            ORDER BY ticker, date
            """,
            query_tickers,
        ).fetchall()
        for row in rows:
            grouped[row["ticker"]].append(row)
        now_text = datetime.now(KST).isoformat(timespec="seconds")
        updated = 0
        for ticker in clean_tickers:
            price_rows = grouped.get(ticker, [])
            daily_rsi = rsi_series([float(row["close"]) for row in price_rows])
            payload = calculate_technical_stats(price_rows, daily_rsi, grouped.get(BETA_BENCHMARK, []))
            upsert_daily_rsi(conn, ticker, price_rows, daily_rsi, now_text)
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

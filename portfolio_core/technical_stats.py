from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from typing import Iterable

from .db import connect, ensure_technical_stats_cache_table
from .indicators import bollinger_pband, recent_performance, resample_last, rsi_series, rsi_value
from .paths import KST

TECHNICAL_CACHE_VERSION = 4  # 4: vol_annual(연율화 변동성) 추가
TECHNICAL_LOOKBACK_DAYS = 6 * 366
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


def annualized_volatility(daily: list[float]) -> float | None:
    """최근 180거래일 일수익률의 연율화 변동성(%) — 손익비 점수의 위험 축.
    벤치마크 교집합에 묶이는 beta_stats와 달리 자기 시계열만 쓴다."""
    closes = [c for c in daily[-(BETA_WINDOW + 1):] if c is not None and c > 0]
    returns = _returns(closes)
    count = len(returns)
    if count < 30:
        return None
    mean = sum(returns) / count
    variance = sum((value - mean) ** 2 for value in returns) / count
    return round((variance ** 0.5) * (252 ** 0.5) * 100, 2)


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
        "vol_annual": annualized_volatility(daily),
        **beta_stats(rows, benchmark_rows or []),
    }


def price_adjusted_rows(
    rows: list[sqlite3.Row] | list[dict],
    current_price: float,
    current_date: str,
) -> list[dict]:
    """마지막 시장가격으로 해당 거래일 종가를 임시 대체한 시계열.

    장외 시세는 영구 일봉 데이터에 저장하지 않고, 화면용 기술지표를 계산할
    때만 당일 종가 자리에 넣는다. 당일 일봉이 아직 없으면 새 행을 추가한다.
    """
    adjusted = [dict(row) for row in rows if row["date"] and row["close"] is not None]
    replaced = False
    for row in adjusted:
        if row["date"] == current_date:
            row["close"] = float(current_price)
            replaced = True
            break
    if not replaced:
        adjusted.append(
            {
                "date": current_date,
                "close": float(current_price),
                "high": float(current_price),
                "low": float(current_price),
            }
        )
        adjusted.sort(key=lambda row: row["date"])
    return adjusted


def calculate_price_adjusted_indicators(
    rows: list[sqlite3.Row] | list[dict],
    current_price: float,
    current_date: str,
) -> dict:
    adjusted = price_adjusted_rows(rows, current_price, current_date)
    daily = [float(row["close"]) for row in adjusted]
    weekly = resample_last(adjusted, "week")
    monthly = resample_last(adjusted, "month")
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
    }


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
    with connect() as conn:
        ensure_technical_stats_cache_table(conn)
        query_tickers = sorted(set(clean_tickers) | {BETA_BENCHMARK})
        grouped: dict[str, list[sqlite3.Row]] = {ticker: [] for ticker in query_tickers}
        cutoff = (datetime.now(KST).date() - timedelta(days=TECHNICAL_LOOKBACK_DAYS)).isoformat()
        rows = conn.execute(
            f"""
            SELECT ticker, date, close
            FROM daily_prices
            WHERE ticker IN ({placeholders(query_tickers)})
              AND date >= ?
              AND close IS NOT NULL
            ORDER BY ticker, date
            """,
            [*query_tickers, cutoff],
        ).fetchall()
        for row in rows:
            grouped[row["ticker"]].append(row)
        now_text = datetime.now(KST).isoformat(timespec="seconds")
        updated = 0
        for ticker in clean_tickers:
            price_rows = grouped.get(ticker, [])
            daily_rsi = rsi_series([float(row["close"]) for row in price_rows])
            payload = calculate_technical_stats(price_rows, daily_rsi, grouped.get(BETA_BENCHMARK, []))
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

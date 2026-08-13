from __future__ import annotations

import json
import sqlite3
from bisect import bisect_left
from datetime import date, datetime, timedelta
from typing import Callable, Iterable

from .constants import FX_TICKERS
from .corporate_actions import (
    dedupe_dividend_event_rows,
    entitlement_date,
    split_adjusted_amount,
)
from .dates import parse_iso_date, positive_float
from .db import connect, ensure_technical_stats_cache_table
from .indicators import bollinger_pband, recent_performance, resample_last, rsi_series, rsi_value
from .paths import KST
from .tickers import ticker_currency

TECHNICAL_CACHE_VERSION = 6  # 6: 기간별 가격 성과에 1주·10년 추가
TECHNICAL_LOOKBACK_DAYS = 11 * 366
PRICE_ADJUSTED_LOOKBACK_DAYS = 6 * 366
BETA_BENCHMARK = "SP500"
BETA_WINDOW = 180

# 손익비 점수용 총수익 기간(거래일). 가용 판정은 95% 이상 데이터.
TOTAL_RETURN_PERIODS = (("5y", 1260), ("3y", 756), ("1y", 252))
DIVIDEND_MAP_MAX_DAYS = 5   # 휴장일 이월 한도 — 초과 배당은 반영하지 않고 품질 P
FX_LOOKUP_MAX_DAYS = 14


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


def build_fx_lookup(fx_series: dict[str, list[tuple[str, float]]]) -> Callable:
    """(from_ccy, to_ccy, date) → 환산 배율. 시계열은 {CCY}KRW(원화 크로스).
    해당 일자 이전 최근 환율(14일 이내)만 사용, 없으면 None."""
    def rate_krw(ccy: str, on: date) -> float | None:
        if ccy == "KRW":
            return 1.0
        rows = fx_series.get(f"{ccy}KRW")
        if not rows:
            return None
        target = on.isoformat()
        index = bisect_left(rows, (target, float("inf")))
        if index == 0:
            return None
        row_date, value = rows[index - 1]
        parsed = parse_iso_date(row_date)
        if parsed is None or (on - parsed).days > FX_LOOKUP_MAX_DAYS:
            return None
        return value

    def lookup(from_ccy: str, to_ccy: str, on: date) -> float | None:
        if from_ccy == to_ccy:
            return 1.0
        from_rate = rate_krw(from_ccy, on)
        to_rate = rate_krw(to_ccy, on)
        if from_rate is None or to_rate is None or to_rate == 0:
            return None
        return from_rate / to_rate

    return lookup


def total_return_periods(
    price_rows: list,
    dividend_rows: list,
    splits: list[dict],
    currency: str,
    fx_lookup: Callable | None = None,
    dividend_yield: float | None = None,
) -> dict[str, dict | None]:
    """기간별(5y/3y/1y) 총수익 CAGR·연율 변동성·품질(TR/P).

    일간 총수익률 r(t) = (P(t) + 분할·통화보정 배당(t)) / P(t-1) - 1.
    배당은 배당락일(ex_date) 이후 첫 거래일에 가산하되 5일 초과 이월은
    반영하지 않고 품질을 P로 낮춘다. 통화가 다른 배당은 FX 크로스 환산,
    불가하면 미반영+P. 배당수익률이 있는데 기간 내 반영된 배당이 없으면
    가격수익률 폴백으로 보고 P."""
    dates = [row["date"] for row in price_rows]
    closes = [float(row["close"]) for row in price_rows]
    result: dict[str, dict | None] = {key: None for key, _days in TOTAL_RETURN_PERIODS}
    if len(closes) < 2:
        return result

    last_price_date = parse_iso_date(dates[-1])
    dividend_by_index: dict[int, float] = {}
    unmapped_dates: list[str] = []
    for event in dedupe_dividend_event_rows(dividend_rows, splits):
        event_date = parse_iso_date(event["ex_date"]) or entitlement_date(event)
        amount = positive_float(event["amount"])
        if event_date is None or not amount:
            continue
        if last_price_date is not None and event_date > last_price_date:
            # 마지막 가격일 이후 배당락 = 아직 대응 가격이 없는 미래 이벤트
            # (미국 종목은 KST 기준 하루 늦게 가격이 온다) — 다음 배치에서
            # 가격과 함께 반영되므로 실패로 세지 않는다.
            continue
        adjusted, _factor = split_adjusted_amount(amount, event_date, event["source"], splits)
        event_currency = str(event["currency"] or "").upper() or currency
        if event_currency != currency:
            ratio = fx_lookup(event_currency, currency, event_date) if fx_lookup else None
            if ratio is None:
                unmapped_dates.append(event_date.isoformat())
                continue
            adjusted *= ratio
        index = bisect_left(dates, event_date.isoformat())
        mapped_date = parse_iso_date(dates[index]) if index < len(dates) else None
        if (
            index == 0
            or mapped_date is None
            or (mapped_date - event_date).days > DIVIDEND_MAP_MAX_DAYS
        ):
            unmapped_dates.append(event_date.isoformat())
            continue
        dividend_by_index[index] = dividend_by_index.get(index, 0.0) + adjusted

    total_returns: list[float] = []
    price_returns: list[float] = []
    for index in range(1, len(closes)):
        previous = closes[index - 1]
        if previous <= 0:
            total_returns.append(0.0)
            price_returns.append(0.0)
            continue
        price_return = closes[index] / previous - 1
        price_returns.append(price_return)
        total_returns.append(price_return + dividend_by_index.get(index, 0.0) / previous)

    for key, period_days in TOTAL_RETURN_PERIODS:
        if len(total_returns) < period_days * 0.95:
            continue
        count = min(period_days, len(total_returns))
        window_start = dates[len(dates) - count - 1]
        has_dividend = any(
            index >= len(closes) - count for index in dividend_by_index
        )
        has_unmapped = any(day >= window_start for day in unmapped_dates)
        # 매핑 실패가 하나라도 있으면 '부분 총수익'이 되므로 그 기간은
        # 순수 가격수익률로 통째 재계산 — P 라벨(가격 폴백)과 실체를 일치.
        series = price_returns if has_unmapped else total_returns
        window = series[-count:]
        growth = 1.0
        for value in window:
            growth *= 1 + value
        if growth <= 0:
            cagr = -100.0
        else:
            cagr = (growth ** (252 / count) - 1) * 100
        mean = sum(window) / count
        variance = sum((value - mean) ** 2 for value in window) / count
        vol = (variance ** 0.5) * (252 ** 0.5) * 100
        quality = "TR"
        if has_unmapped or (not has_dividend and (dividend_yield or 0) > 0.5):
            quality = "P"
        result[key] = {"cagr": round(cagr, 2), "vol": round(vol, 2), "quality": quality}
    return result


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

        # 총수익(배당 재투자) 시계열 재료 — 배당·분할·FX·배당수익률 일괄 로딩
        ticker_placeholders = placeholders(clean_tickers)
        today_text = datetime.now(KST).date().isoformat()
        dividend_rows_by_ticker: dict[str, list] = {ticker: [] for ticker in clean_tickers}
        for row in conn.execute(
            f"""
            SELECT ticker, ex_date, record_date, pay_date, declaration_date, amount, currency, source
            FROM dividend_events
            WHERE ticker IN ({ticker_placeholders})
              AND amount IS NOT NULL AND amount > 0
              AND date(COALESCE(ex_date, record_date, pay_date)) <= ?
            ORDER BY ticker, date(COALESCE(record_date, ex_date, pay_date))
            """,
            [*clean_tickers, today_text],
        ).fetchall():
            dividend_rows_by_ticker[row["ticker"]].append(row)
        splits_by_ticker: dict[str, list[dict]] = {ticker: [] for ticker in clean_tickers}
        for row in conn.execute(
            f"""
            SELECT ticker, split_date, ratio, source
            FROM stock_splits
            WHERE ticker IN ({ticker_placeholders})
            ORDER BY ticker, split_date
            """,
            clean_tickers,
        ).fetchall():
            splits_by_ticker[row["ticker"]].append(dict(row))
        fx_series: dict[str, list[tuple[str, float]]] = {}
        for row in conn.execute(
            f"""
            SELECT ticker, date, close
            FROM daily_prices
            WHERE ticker IN ({placeholders(list(FX_TICKERS))})
              AND date >= ? AND close IS NOT NULL
            ORDER BY ticker, date
            """,
            [*FX_TICKERS, cutoff],
        ).fetchall():
            fx_series.setdefault(row["ticker"], []).append((row["date"], float(row["close"])))
        fx_lookup = build_fx_lookup(fx_series)
        yield_by_ticker = {
            row["ticker"]: positive_float(row["dividend_yield"])
            for row in conn.execute(
                f"SELECT ticker, dividend_yield FROM ticker_stats_cache WHERE ticker IN ({ticker_placeholders})",
                clean_tickers,
            ).fetchall()
        }
        currency_by_ticker = {
            row["ticker"]: row["currency"] or ticker_currency(row["ticker"])
            for row in conn.execute(
                f"SELECT ticker, currency FROM tickers WHERE ticker IN ({ticker_placeholders})",
                clean_tickers,
            ).fetchall()
        }

        now_text = datetime.now(KST).isoformat(timespec="seconds")
        updated = 0
        for ticker in clean_tickers:
            price_rows = grouped.get(ticker, [])
            daily_rsi = rsi_series([float(row["close"]) for row in price_rows])
            payload = calculate_technical_stats(price_rows, daily_rsi, grouped.get(BETA_BENCHMARK, []))
            payload["risk_reward"] = total_return_periods(
                price_rows,
                dividend_rows_by_ticker.get(ticker, []),
                splits_by_ticker.get(ticker, []),
                currency_by_ticker.get(ticker) or ticker_currency(ticker),
                fx_lookup,
                yield_by_ticker.get(ticker),
            )
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

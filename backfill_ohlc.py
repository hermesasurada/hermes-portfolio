#!/usr/bin/env python3
"""종가만 저장된 과거 일봉에 시·고·저를 채운다 (캔들 차트의 빈 구간 복구).

장중 스냅샷이 오랫동안 종가만 저장했던 탓에, 그 시절 일봉은 캔들 차트에서
봉 없이 비어 보인다. 이 스크립트는 원본 소스에서 그 구간 이력을 다시 받아
**시·고·저·거래량만** 채운다.

종가는 절대 건드리지 않는다 — 분할 보정(repair_split_adjusted_daily_prices)과
스파이크 가드가 이미 정리해 둔 정본이기 때문이다. 같은 이유로, 받아온 종가가
저장된 종가와 tolerance 이상 어긋나면(분할 기준이 다른 이력 등) 그 행은 건너뛴다.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import date, timedelta

from portfolio_core.collect_common import collector_lock
from portfolio_core.collectors import fetch_history_rows
from portfolio_core.db import connect
from portfolio_core.price_store import _coherent_candle_bounds, infer_category


def _number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number > 0 else None


def missing_targets(conn, since: str, tickers: list[str] | None) -> list[tuple[str, str, int]]:
    """(ticker, category, 결측 행 수) — 결측이 많은 종목부터."""
    clause = ""
    params: list = [since]
    if tickers:
        clause = f" AND d.ticker IN ({','.join('?' for _ in tickers)})"
        params.extend(tickers)
    # 상장폐지·추적해제 종목은 tickers 행이 없어도 가격 이력은 남는다 → 티커로 추론.
    return [
        (row["ticker"], infer_category(row["ticker"], row["category"]), row["n"])
        for row in conn.execute(
            f"""
            SELECT d.ticker, t.category, COUNT(*) AS n
            FROM daily_prices d
            LEFT JOIN tickers t ON t.ticker = d.ticker
            WHERE d.open IS NULL AND d.close IS NOT NULL AND d.date >= ?{clause}
            GROUP BY d.ticker, t.category
            ORDER BY n DESC
            """,
            params,
        ).fetchall()
    ]


def fill_ticker(conn, ticker: str, category: str, since: str, period: str, tolerance_pct: float) -> tuple[int, int]:
    """(채운 행, 종가 불일치로 건너뛴 행)."""
    try:
        history = fetch_history_rows(category, ticker, period=period)
    except Exception as exc:  # noqa: BLE001 — 종목 하나가 죽어도 전체는 계속
        print(f"  x {ticker}: {type(exc).__name__}: {exc}")
        return 0, 0
    by_date = {str(row.get("date")): row for row in history if row.get("date")}
    if not by_date:
        return 0, 0

    stored = conn.execute(
        "SELECT date, close FROM daily_prices WHERE ticker = ? AND open IS NULL AND close IS NOT NULL AND date >= ?",
        (ticker, since),
    ).fetchall()

    updates: list[tuple] = []
    mismatched = 0
    for row in stored:
        source = by_date.get(str(row["date"]))
        if not source:
            continue
        stored_close = float(row["close"])
        source_close = _number(source.get("close"))
        if source_close is None:
            continue
        # 분할 기준이 다른 이력을 섞으면 봉과 종가가 어긋난다 — 그런 행은 손대지 않는다.
        if abs(source_close - stored_close) / stored_close * 100 > tolerance_pct:
            mismatched += 1
            continue
        open_value = _number(source.get("open"))
        high = _number(source.get("high"))
        low = _number(source.get("low"))
        if open_value is None or high is None or low is None:
            continue
        # 저장된 종가를 기준으로 꼬리를 넓혀 봉이 자기 종가를 뚫지 않게 한다.
        high, low = _coherent_candle_bounds(open_value, high, low, stored_close)
        updates.append((open_value, high, low, _number(source.get("volume")), ticker, row["date"]))

    if updates:
        conn.executemany(
            """
            UPDATE daily_prices
            SET open = ?, high = ?, low = ?, volume = COALESCE(?, volume)
            WHERE ticker = ? AND date = ? AND open IS NULL
            """,
            updates,
        )
        conn.commit()
    return len(updates), mismatched


@contextmanager
def _noop_lock():
    yield True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", help="이 날짜부터 채운다 (기본: 180일 전).")
    parser.add_argument("--days", type=int, default=180, help="--since 미지정 시 거슬러 올라갈 일수.")
    parser.add_argument("--ticker", action="append", help="특정 종목만. 반복 지정 가능.")
    parser.add_argument("--period", default="10y", help="원본에서 받아올 이력 기간 (기본 10y).")
    parser.add_argument("--tolerance-pct", type=float, default=1.0, help="종가 허용 오차(%%). 넘으면 건너뜀.")
    parser.add_argument("--limit", type=int, help="처리할 종목 수 상한(결측 많은 순).")
    parser.add_argument("--no-lock", action="store_true", help="수집기 락 없이 실행(디버그).")
    args = parser.parse_args()

    since = args.since or (date.today() - timedelta(days=args.days)).isoformat()
    lock = _noop_lock() if args.no_lock else collector_lock("prices")
    with lock as acquired:
        if not acquired:
            return 0
        with connect() as conn:
            targets = missing_targets(conn, since, args.ticker)
            if args.limit:
                targets = targets[: args.limit]
            print(f"{since} 이후 종가만 남은 종목 {len(targets)}개")
            filled_total = 0
            skipped_total = 0
            for ticker, category, count in targets:
                if not category:
                    print(f"  - {ticker}: 카테고리 없음 — 건너뜀")
                    continue
                filled, mismatched = fill_ticker(conn, ticker, category, since, args.period, args.tolerance_pct)
                filled_total += filled
                skipped_total += mismatched
                note = f" (종가 불일치 {mismatched}건 보존)" if mismatched else ""
                print(f"  + {ticker}: {filled}/{count}행 채움{note}")
            print(f"\n총 {filled_total}행 채움, {skipped_total}행은 종가 불일치로 보존")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

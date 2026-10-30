#!/usr/bin/env python3
"""분할 전후 가격 단위가 끊긴 종목의 가격 이력을 잇는다.

yfinance가 같은 분할을 두 번 기록했거나(MUD 0.1×2, NVDS 0.2×2) 과잉 조정한(1321.T) 종목은
분할일 전 구간이 10배·5배·1/100로 어긋나 있다. 분할표(stock_splits, 중복 제거 후)와 가격의
실제 점프를 비교해, 분할 전 구간을 '가격이 연속되도록' 한 번에 곱한다(OHLC·adj_close 전부).
백필은 종목당 한 번만 돌아(price_store.history_backfill_status) 이후 일봉은 원 단위로 붙으므로
한 번 고치면 유지된다. 2026-10-30 점검 후속.

사용: python3 scripts/repair_split_prices.py TICKER [TICKER ...] [--apply]
      (기본은 dry-run — 바꿀 배율과 행 수만 보여 준다)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portfolio_core.db import connect  # noqa: E402

TOLERANCE = 0.25   # 관측 점프가 기대 배율과 25% 안이면 '분할 그대로 보임', 1.0 근처면 '이미 조정'


def _nearest_power(ratio: float, target: float) -> float | None:
    """target(분할 전 구간에 곱할 배율)에 가장 가까운 ratio의 정수 거듭제곱(±1, ±2). 25% 밖이면 None."""
    import math
    best = None
    for k in (-2, -1, 1, 2):
        candidate = ratio ** k
        if best is None or abs(math.log(candidate / target)) < abs(math.log(best / target)):
            best = candidate
    return best if best is not None and abs(math.log(best / target)) <= math.log(1 + TOLERANCE) else None


def plan(conn, ticker: str) -> list[tuple[str, float, float, float]]:
    """(끊긴 날, 분할비, 관측 before/after, 끊긴 날 이전 구간에 곱할 배율).

    야후 이력은 분할일과 하루이틀 어긋난 곳에서 단위가 바뀌기도 해서(1321.T: 10-05 분할, 10-07 점프)
    분할일 앞뒤 7일 안에서 가장 큰 연속 종가 점프를 찾는다."""
    out = []
    for split_date, ratio in conn.execute(
        "SELECT split_date, ratio FROM stock_splits WHERE ticker = ? ORDER BY split_date", (ticker,)
    ).fetchall():
        rows = conn.execute(
            "SELECT date, close FROM daily_prices WHERE ticker = ? AND close > 0 AND date BETWEEN date(?, '-7 days') AND date(?, '+7 days') ORDER BY date",
            (ticker, split_date, split_date),
        ).fetchall()
        jump = None
        for prev, cur in zip(rows, rows[1:]):
            observed = prev[1] / cur[1]
            if abs(observed - 1.0) <= TOLERANCE:
                continue
            if jump is None or abs(observed - 1.0) > abs(jump[1] - 1.0):
                jump = (cur[0], observed)
        if jump is None:
            continue            # 이미 조정된 연속 시계열
        scale = _nearest_power(float(ratio), 1.0 / jump[1])
        if scale is None:
            print(f"{ticker}: {split_date} 점프 {jump[1]:.3f}이 분할비 {ratio:g}의 거듭제곱과 안 맞음 — 건너뜀")
            continue
        out.append((jump[0], float(ratio), jump[1], scale))
    return out


def apply(conn, ticker: str, split_date: str, scale: float) -> int:
    cur = conn.execute(
        """
        UPDATE daily_prices
        SET open = open * ?, high = high * ?, low = low * ?, close = close * ?,
            adj_close = CASE WHEN adj_close IS NULL THEN NULL ELSE adj_close * ? END
        WHERE ticker = ? AND date < ?
        """,
        (scale, scale, scale, scale, scale, ticker, split_date),
    )
    return cur.rowcount


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", nargs="+")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    with connect() as conn:
        for ticker in args.tickers:
            steps = plan(conn, ticker.upper())
            if not steps:
                print(f"{ticker}: 가격 이력이 이미 연속 — 손대지 않음")
                continue
            for split_date, ratio, observed, scale in steps:
                print(f"{ticker}: {split_date} 분할비 {ratio:g} · 관측 before/after {observed:.3f} → 분할 전 구간 ×{scale:.6g}")
                if args.apply:
                    print(f"   {apply(conn, ticker.upper(), split_date, scale)}행 수정")
        if args.apply:
            conn.commit()


if __name__ == "__main__":
    main()

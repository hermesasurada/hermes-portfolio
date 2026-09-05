"""과거 시점의 진입 손익비 재구성.

거래내역의 '거래 실행 시점 진입 손익비' 컬럼용. 그 날짜까지의 일봉으로
현행 산식의 입력(볼린저 일·주, ATR, RSI 일·주, 60일선)을 다시 만들어
entry_risk_reward_score를 계산한다. 과거 시점 값은 불변이므로 거래 저장
시 1회 계산해 transactions.entry_score에 캐시한다.

주의: '당시 산식'의 재현이 아니라 '현행 산식을 당시 데이터에 적용'한 값.
산식이 바뀌면 backfill_transaction_entry_scores(force=True)로 재계산한다.
"""

from __future__ import annotations

import sqlite3

from .db import connect, ensure_transaction_columns
from .entry_reward import entry_risk_reward_score, is_leveraged_product
from .indicators import (
    atr_percent,
    bollinger_distance_pct,
    ma_pct,
    resample_last,
    rolling_atr_percent,
    rsi_series,
)

MIN_HISTORY_ROWS = 80  # 60일선 + ATR(60행 창)이 서려면 이 정도는 있어야 한다


def entry_score_on(conn: sqlite3.Connection, ticker: str, trade_date: str) -> float | None:
    """trade_date(포함) 이전 일봉만으로 계산한 진입 손익비. 이력 부족이면 None."""
    clean = (ticker or "").strip().upper()
    if not clean or not trade_date:
        return None
    try:
        named = conn.execute("SELECT name FROM tickers WHERE ticker = ?", (clean,)).fetchone()
    except sqlite3.OperationalError:
        named = None  # tickers 테이블이 없는 픽스처 — 레버리지 판정만 건너뛴다
    if named and is_leveraged_product(named["name"]):
        return None  # 레버리지·인버스는 점수 대상이 아니다
    try:
        rows = conn.execute(
            """
            SELECT date, open, high, low, close FROM daily_prices
            WHERE ticker = ? AND close IS NOT NULL AND date <= ?
            ORDER BY date
            """,
            (clean, str(trade_date)),
        ).fetchall()
    except sqlite3.OperationalError:
        # 가격 테이블이 없는 환경(테스트 픽스처) — 점수 없이 저장을 막지 않는다.
        return None
    if len(rows) < MIN_HISTORY_ROWS:
        return None
    closes = [float(row["close"]) for row in rows]
    distance = bollinger_distance_pct(closes)
    atr = atr_percent(rows[-61:])
    rsi_day = rsi_series(closes)[-1]
    weekly = resample_last(rows, "week")
    rsi_week = rsi_series(weekly)[-1] if len(weekly) > 20 else None
    weekly_distance = bollinger_distance_pct(weekly) if len(weekly) >= 20 else None
    return entry_risk_reward_score(
        distance[0] if distance else None,
        atr,
        rsi_day,
        rsi_week,
        ma_pct(closes, 60),
        weekly_distance[0] if weekly_distance else None,
    )


def entry_score_series(rows) -> list[float | None]:
    """일봉 행마다 '그날 종가 기준' 진입 점수. 차트 RSI 패널용.

    완결된 주의 RSI 상태만 누적하고 진행 중인 주는 당일 종가로 임시 계산한다.
    ATR은 OHLC 전처리를 공유하되 기존 61행 창의 초기화 규칙을 보존한다.
    """
    from datetime import date as _date

    closes = [float(row["close"]) for row in rows]
    count = len(closes)
    series: list[float | None] = [None] * count
    if count < MIN_HISTORY_ROWS:
        return series
    rsi_day = rsi_series(closes)
    atr_values = rolling_atr_percent(rows)
    week_keys = [_date.fromisoformat(str(row["date"])).isocalendar()[:2] for row in rows]
    completed: list[float] = []
    alpha = 1.0 / 14
    week_gain = week_loss = 0.0
    for index in range(count):
        if index and week_keys[index] != week_keys[index - 1]:
            if completed:
                change = closes[index - 1] - completed[-1]
                week_gain = (1.0 - alpha) * week_gain + alpha * max(change, 0.0)
                week_loss = (1.0 - alpha) * week_loss + alpha * max(-change, 0.0)
            completed.append(closes[index - 1])
        if index < MIN_HISTORY_ROWS - 1 or len(completed) < 20:
            continue
        weekly = completed[-19:] + [closes[index]]
        distance = bollinger_distance_pct(closes[index - 19:index + 1])
        weekly_distance = bollinger_distance_pct(weekly)
        if not distance or not weekly_distance:
            continue
        change = closes[index] - completed[-1]
        gain = (1.0 - alpha) * week_gain + alpha * max(change, 0.0)
        loss = (1.0 - alpha) * week_loss + alpha * max(-change, 0.0)
        rsi_week = 100.0 if loss == 0 else 100.0 - 100.0 / (1.0 + gain / loss)
        series[index] = entry_risk_reward_score(
            distance[0],
            atr_values[index],
            rsi_day[index],
            rsi_week,
            ma_pct(closes[max(0, index - 59):index + 1], 60),
            weekly_distance[0],
        )
    return series


def backfill_transaction_entry_scores(force: bool = False) -> int:
    """entry_score가 빈 거래(force면 전체)를 채운다. 갱신 건수 반환."""
    with connect() as conn:
        ensure_transaction_columns(conn)
        where = "" if force else "WHERE entry_score IS NULL"
        targets = conn.execute(
            f"SELECT id, ticker, trade_date FROM transactions {where} ORDER BY ticker, trade_date"
        ).fetchall()
        updated = 0
        for row in targets:
            score = entry_score_on(conn, row["ticker"], row["trade_date"])
            if score is None and not force:
                continue
            conn.execute(
                "UPDATE transactions SET entry_score = ? WHERE id = ?",
                (score, row["id"]),
            )
            updated += 1
        conn.commit()
    return updated

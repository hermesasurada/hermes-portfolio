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
from .entry_reward import entry_risk_reward_score
from .indicators import (
    atr_percent,
    bollinger_distance_pct,
    ma_pct,
    resample_last,
    rsi_series,
)

MIN_HISTORY_ROWS = 80  # 60일선 + ATR(60행 창)이 서려면 이 정도는 있어야 한다


def entry_score_on(conn: sqlite3.Connection, ticker: str, trade_date: str) -> float | None:
    """trade_date(포함) 이전 일봉만으로 계산한 진입 손익비. 이력 부족이면 None."""
    clean = (ticker or "").strip().upper()
    if not clean or not trade_date:
        return None
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

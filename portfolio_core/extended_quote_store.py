"""세션이 끝난 뒤에도 마지막 연장가를 보여주기 위한 저장·복원.

라이브 조회는 프리·애프터 세션 중에만 가능하지만, 화면에서는 장이 닫힌 뒤에도
그 세션의 최종 연장가가 남아 있어야 한다(미국 장외·한국 NXT 공통).

되살리는 조건은 하나뿐이다 — 저장된 session_date가 그 종목의 **현재 정규장
가격 날짜와 같을 것**. 새 거래일 종가가 들어오면 옛 연장가는 자동으로 버려지고,
주말·휴장 동안에는 직전 세션 값이 그대로 유지된다.

가격(평가액)은 건드리지 않는다 — 표시 전용이다.
"""

from __future__ import annotations

import sqlite3

from .dates import now_kst_text
from .db import connect, ensure_extended_quote_cache_table

EXTENDED_FIELDS = (
    "extended_price",
    "extended_base_price",
    "extended_change",
    "extended_change_pct",
    "extended_source",
    "extended_market_state",
)


def _rows_to_params(prices: dict[str, dict], tickers: list[str]) -> list[tuple]:
    now_text = now_kst_text()
    params: list[tuple] = []
    for ticker in tickers:
        record = prices.get(ticker) or {}
        price = record.get("extended_price")
        session_date = record.get("date")
        if price is None or not session_date:
            continue
        params.append((
            ticker,
            str(session_date),
            float(price),
            record.get("extended_base_price"),
            record.get("extended_change"),
            record.get("extended_change_pct"),
            record.get("extended_source"),
            record.get("extended_market_state"),
            now_text,
        ))
    return params


def save_extended_quotes(prices: dict[str, dict], tickers: list[str]) -> int:
    """이번 라이브 조회로 채워진 연장가를 보존한다."""
    params = _rows_to_params(prices, tickers)
    if not params:
        return 0
    try:
        with connect() as conn:
            ensure_extended_quote_cache_table(conn)
            conn.executemany(
                """
                INSERT INTO ticker_extended_quotes
                  (ticker, session_date, price, base_price, change, change_pct,
                   source, market_state, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                  session_date = excluded.session_date,
                  price = excluded.price,
                  base_price = excluded.base_price,
                  change = excluded.change,
                  change_pct = excluded.change_pct,
                  source = excluded.source,
                  market_state = excluded.market_state,
                  updated_at = excluded.updated_at
                """,
                params,
            )
            conn.commit()
    except sqlite3.Error as exc:
        print(f"[extended-store] save failed: {type(exc).__name__}: {exc}")
        return 0
    return len(params)


def restore_extended_quotes(prices: dict[str, dict], tickers: list[str]) -> int:
    """세션이 닫혔을 때 마지막 연장가를 되살린다(이미 값이 있으면 건드리지 않음)."""
    targets = [
        ticker for ticker in tickers
        if prices.get(ticker) and prices[ticker].get("extended_price") is None
    ]
    if not targets:
        return 0
    placeholders = ",".join("?" for _ in targets)
    try:
        with connect() as conn:
            ensure_extended_quote_cache_table(conn)
            rows = conn.execute(
                f"""
                SELECT ticker, session_date, price, base_price, change, change_pct,
                       source, market_state
                FROM ticker_extended_quotes
                WHERE ticker IN ({placeholders})
                """,
                targets,
            ).fetchall()
    except sqlite3.Error as exc:
        print(f"[extended-store] restore failed: {type(exc).__name__}: {exc}")
        return 0

    restored = 0
    for row in rows:
        record = prices.get(row["ticker"])
        if not record:
            continue
        # 저장된 세션이 지금 보이는 정규장 종가와 같은 날짜일 때만 되살린다.
        if str(record.get("date") or "") != str(row["session_date"]):
            continue
        record["extended_price"] = row["price"]
        record["extended_base_price"] = row["base_price"]
        record["extended_change"] = row["change"]
        record["extended_change_pct"] = row["change_pct"]
        record["extended_source"] = row["source"]
        record["extended_market_state"] = row["market_state"]
        record["extended_session_closed"] = True   # 표시용 — 이미 끝난 세션의 확정값
        restored += 1
    return restored

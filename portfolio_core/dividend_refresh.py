from __future__ import annotations

from .db import connect, ensure_dividend_tables
from .dividend_sources import (
    _cache_due,
    _dividendmax_attempt_due,
    _fetch_dividends,
    _kr_history_attempt_due,
    _nasdaq_attempt_due,
    _now_text,
    _polygon_attempt_due,
    _seibro_attempt_due,
    _seibro_candidate,
    _stockanalysis_attempt_due,
)
from .tickers import ticker_currency

def refresh_dividend_events(tickers: list[str]) -> None:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return
    now = _now_text()
    with connect() as conn:
        ensure_dividend_tables(conn)
        placeholders = ",".join("?" for _ in clean_tickers)
        rows = conn.execute(
            f"""
            SELECT c.ticker, c.fetched_at, c.status, tk.name
            FROM ticker_dividend_cache c
            LEFT JOIN tickers tk ON tk.ticker = c.ticker
            WHERE c.ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall()
        fetched = {row["ticker"]: row["fetched_at"] for row in rows}
        statuses = {row["ticker"]: row["status"] for row in rows}
        names = {row["ticker"]: row["name"] for row in rows}
        for row in conn.execute(
            f"""
            SELECT ticker, name
            FROM tickers
            WHERE ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall():
            names[row["ticker"]] = row["name"]
        due = [
            ticker for ticker in clean_tickers
            if (
                _cache_due(fetched.get(ticker))
                or _stockanalysis_attempt_due(ticker, statuses.get(ticker))
                or _nasdaq_attempt_due(ticker, statuses.get(ticker))
                or _dividendmax_attempt_due(ticker, statuses.get(ticker))
                or _seibro_attempt_due(ticker, statuses.get(ticker))
                or _kr_history_attempt_due(ticker, statuses.get(ticker))
                or _polygon_attempt_due(ticker, statuses.get(ticker))
            )
        ]
        conn.commit()

    if not due:
        return

    with connect() as conn:
        ensure_dividend_tables(conn)
        for ticker in due:
            events, status = _fetch_dividends(ticker, names.get(ticker))
            if _seibro_candidate(ticker):
                conn.execute(
                    "DELETE FROM dividend_events WHERE ticker = ? AND source NOT IN ('seibro', 'kr-history')",
                    (ticker,),
                )
            for event in events:
                if not event.get("ex_date"):
                    continue
                conn.execute(
                    """
                    INSERT INTO dividend_events
                      (ticker, ex_date, pay_date, amount, currency, source, fetched_at,
                       declaration_date, record_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(ticker, ex_date) DO UPDATE SET
                        pay_date = COALESCE(excluded.pay_date, dividend_events.pay_date),
                        amount = COALESCE(excluded.amount, dividend_events.amount),
                        currency = COALESCE(excluded.currency, dividend_events.currency),
                        declaration_date = COALESCE(excluded.declaration_date, dividend_events.declaration_date),
                        record_date = COALESCE(excluded.record_date, dividend_events.record_date),
                        source = excluded.source,
                        fetched_at = excluded.fetched_at
                    """,
                    (
                        ticker,
                        event["ex_date"],
                        event.get("pay_date"),
                        event.get("amount"),
                        event.get("currency") or ticker_currency(ticker),
                        event.get("source") or "yf",
                        now,
                        event.get("declaration_date"),
                        event.get("record_date"),
                    ),
                )
            conn.execute(
                """
                INSERT INTO ticker_dividend_cache (ticker, fetched_at, status)
                VALUES (?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    fetched_at = excluded.fetched_at,
                    status = excluded.status
                """,
                (ticker, now, status),
            )
        conn.commit()


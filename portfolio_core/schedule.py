from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta

from .dates import today_kst
from .db import connect
from .dividend_schedule import add_months, consolidated_dividend_events, event_schedule_date
from .earnings_history import collapse_near_earnings_events
from .tickers import ticker_scope


def _default_logo(ticker: str, _name: str) -> dict[str, str | None]:
    return {"text": ticker[:2].upper(), "url": None}


def _include_schedule_ticker(ticker: str, name: str, category: str | None, currency: str | None) -> bool:
    return ticker_scope(ticker, name, category, currency) != "kr_etf"


def load_schedule(
    logo_hint_fn: Callable[[str, str], dict] | None = None,
) -> dict:
    """Return DB-backed earnings and dividend dates for the calendar modal."""
    logo_hint = logo_hint_fn or _default_logo
    today = today_kst()
    first_of_month = today.replace(day=1)
    start = add_months(first_of_month, -12)
    end = add_months(first_of_month, 13) - timedelta(days=1)

    with connect() as conn:
        # Schema/backfill run at startup and when earnings are collected. A GET
        # must not acquire the SQLite writer lock, even for INSERT OR IGNORE.
        ticker_rows = conn.execute(
            """
            SELECT t.ticker,
                   COALESCE(NULLIF(t.display_name, ''), t.name, t.ticker) AS name,
                   t.category,
                   t.currency,
                   t.next_earnings_date,
                   s.market_cap
            FROM tickers t
            LEFT JOIN ticker_stats_cache s ON s.ticker = t.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND t.ticker IS NOT NULL
              AND TRIM(t.ticker) <> ''
            ORDER BY t.ticker
            """
        ).fetchall()
        ticker_rows = [
            row
            for row in ticker_rows
            if _include_schedule_ticker(row["ticker"], row["name"], row["category"], row["currency"])
        ]
        owned = {
            str(row["ticker"]).upper()
            for row in conn.execute(
                """
                SELECT DISTINCT ticker
                FROM holdings
                WHERE COALESCE(qty, 0) > 0
                  AND ticker IS NOT NULL
                """
            ).fetchall()
        }
        earnings_rows = conn.execute(
            """
            SELECT e.ticker, e.earnings_date, e.source, e.observed_at
            FROM earnings_events e
            JOIN tickers t ON t.ticker = e.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND date(e.earnings_date) BETWEEN ? AND ?
            ORDER BY date(e.earnings_date), e.ticker
            """,
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        actual_rows = conn.execute(
            """
            SELECT d.ticker, d.ex_date, d.pay_date, d.amount, d.currency,
                   d.source, d.fetched_at, d.declaration_date, d.record_date
            FROM dividend_events d
            JOIN tickers t ON t.ticker = d.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND date(COALESCE(d.pay_date, d.ex_date)) BETWEEN ? AND ?
            ORDER BY date(COALESCE(d.pay_date, d.ex_date)), d.ticker
            """,
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        history_rows = conn.execute(
            """
            SELECT d.ticker, d.ex_date, d.pay_date, d.amount, d.currency,
                   d.source, d.fetched_at, d.declaration_date, d.record_date
            FROM dividend_events d
            JOIN tickers t ON t.ticker = d.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND d.amount IS NOT NULL
              AND d.amount > 0
            ORDER BY d.ticker, date(COALESCE(d.pay_date, d.ex_date))
            """
        ).fetchall()

    ticker_meta = {
        str(row["ticker"]).upper(): {
            "ticker": str(row["ticker"]).upper(),
            "name": row["name"] or row["ticker"],
            "currency": row["currency"],
            "market_cap_currency": row["currency"],
            "market_cap": row["market_cap"],
            "earnings_date": row["next_earnings_date"],
        }
        for row in ticker_rows
    }
    earnings_rows = collapse_near_earnings_events(
        [dict(row) for row in earnings_rows],
        {
            ticker: meta["earnings_date"]
            for ticker, meta in ticker_meta.items()
            if meta.get("earnings_date")
        },
    )
    earnings = []
    for event in earnings_rows:
        ticker = str(event["ticker"]).upper()
        meta = ticker_meta.get(ticker)
        if not meta:
            continue
        earnings.append(
            {
                **meta,
                "earnings_date": str(event["earnings_date"])[:10],
                "source": event["source"],
                "owned": ticker in owned,
                "logo": logo_hint(ticker, meta["name"]),
            }
        )
    earnings.sort(key=lambda row: (row["earnings_date"], row["ticker"]))

    dividends = []
    for event in consolidated_dividend_events(actual_rows, history_rows):
        schedule_date = event_schedule_date(event)
        if not schedule_date or schedule_date < start or schedule_date > end:
            continue
        ticker = str(event["ticker"]).upper()
        meta = ticker_meta.get(ticker)
        if not meta:
            continue
        dividends.append(
            {
                "date": schedule_date.isoformat(),
                "ticker": ticker,
                "name": meta["name"],
                "market_cap_currency": meta["market_cap_currency"],
                "market_cap": meta["market_cap"],
                "owned": ticker in owned,
                "estimated": bool(event.get("pay_date_estimated")),
                "amount": event.get("amount"),
                "currency": event.get("currency"),
                "logo": logo_hint(ticker, meta["name"]),
            }
        )

    dividends.sort(key=lambda row: (row["date"], row["ticker"]))
    return {
        "today": today.isoformat(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "earnings": earnings,
        "dividends": dividends,
    }

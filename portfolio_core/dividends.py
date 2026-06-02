from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from .constants import FX_DEFAULT_RATES
from .db import connect, ensure_dividend_tables
from .dividend_refresh import refresh_dividend_events
from .dividend_schedule import consolidated_dividend_events, event_schedule_date
from .paths import KST
from .prices import latest_prices
from .queries import clean_account_ids, load_holding_rows
from .tickers import account_label, ticker_currency

DIVIDEND_LOOKBACK_DAYS = 30
DIVIDEND_LOOKAHEAD_DAYS = 365


def _today():
    return datetime.now(KST).date()


def _float_value(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _tax_rate(currency: str) -> float:
    if currency == "KRW":
        return 15.4
    if currency == "JPY":
        return 15.315
    return 15.0


def load_dividends(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = clean_account_ids(account_ids)

    start = _today() - timedelta(days=DIVIDEND_LOOKBACK_DAYS)
    end = _today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS)

    with connect() as conn:
        ensure_dividend_tables(conn)
        holding_rows = load_holding_rows(conn, cleaned_account_ids, positive_only=True)

    holdings = [
        {
            "account_id": str(row["account_id"]),
            "member": row["member"],
            "account_type": row["account_type"],
            "account_name": row["account_name"],
            "ticker": row["ticker"],
            "name": row["name"] or row["ticker"],
            "qty": float(row["qty"] or 0),
            "currency": row["currency"] or ticker_currency(row["ticker"]),
        }
        for row in holding_rows
        if row["ticker"] and float(row["qty"] or 0) > 0
    ]
    tickers = sorted({row["ticker"] for row in holdings})

    with connect() as conn:
        ensure_dividend_tables(conn)
        prices = latest_prices(conn)
        placeholders = ",".join("?" for _ in tickers) if tickers else "''"
        event_rows = conn.execute(
            f"""
            SELECT ticker, ex_date, pay_date, amount, currency, source, fetched_at
            FROM dividend_events
            WHERE ticker IN ({placeholders})
              AND date(COALESCE(pay_date, ex_date)) BETWEEN ? AND ?
            ORDER BY date(COALESCE(pay_date, ex_date)), ticker
            """,
            [*tickers, start.isoformat(), end.isoformat()] if tickers else [start.isoformat(), end.isoformat()],
        ).fetchall()
        history_rows = conn.execute(
            f"""
            SELECT ticker, ex_date, pay_date, amount, currency, source, fetched_at
            FROM dividend_events
            WHERE ticker IN ({placeholders})
              AND amount IS NOT NULL
            ORDER BY ticker, date(COALESCE(pay_date, ex_date))
            """,
            tickers if tickers else [],
        ).fetchall()
        cache_rows = conn.execute(
            f"""
            SELECT ticker, fetched_at, status
            FROM ticker_dividend_cache
            WHERE ticker IN ({placeholders})
            """,
            tickers if tickers else [],
        ).fetchall()

    holdings_by_ticker: dict[str, list[dict]] = {}
    for holding in holdings:
        holdings_by_ticker.setdefault(holding["ticker"], []).append(holding)

    rates = {
        "KRW": 1.0,
        "USD": float(prices.get("USDKRW", {}).get("price") or FX_DEFAULT_RATES["USD"]),
        "EUR": float(prices.get("EURKRW", {}).get("price") or FX_DEFAULT_RATES["EUR"]),
        "JPY": float(prices.get("JPYKRW", {}).get("price") or FX_DEFAULT_RATES["JPY"]),
    }
    rows = []
    dividend_events = [
        event for event in consolidated_dividend_events(event_rows, history_rows)
        if start <= (event_schedule_date(event) or start) <= end
    ]
    for event in dividend_events:
        currency = event["currency"] or ticker_currency(event["ticker"])
        amount = _float_value(event["amount"])
        rate = rates.get(currency, 1.0)
        tax_rate = _tax_rate(currency)
        for holding in holdings_by_ticker.get(event["ticker"], []):
            qty = holding["qty"]
            gross = amount * qty if amount is not None else None
            tax = gross * tax_rate / 100 if gross is not None else None
            net = gross - tax if gross is not None and tax is not None else None
            net_krw = net * rate if net is not None else None
            rows.append(
                {
                    "pay_date": event["pay_date"],
                    "ex_date": event["ex_date"],
                    "pay_date_estimated": bool(event.get("pay_date_estimated")),
                    "ex_date_estimated": bool(event.get("ex_date_estimated")),
                    "member": holding["member"],
                    "target": f"{holding['member']} {account_label(holding['member'], holding['account_type'], holding['account_name'])}",
                    "account_id": holding["account_id"],
                    "ticker": event["ticker"],
                    "currency": currency,
                    "name": holding["name"],
                    "amount": amount,
                    "qty": qty,
                    "gross": gross,
                    "tax_rate": tax_rate,
                    "net": net,
                    "fx_rate": rate if currency != "KRW" else None,
                    "net_krw": net_krw,
                    "source": event["source"],
                }
            )
    rows.sort(key=lambda row: (row["pay_date"] or "", row["ex_date"] or "", row["ticker"], row["account_id"]))
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "updated_at": max((row["fetched_at"] for row in cache_rows), default=None),
        "rows": rows,
    }

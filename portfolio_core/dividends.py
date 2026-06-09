from __future__ import annotations

from datetime import date, datetime, timedelta
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
DIVIDEND_HISTORY_START_YEAR = 2010


def _today():
    return datetime.now(KST).date()


def _float_value(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


TAX_FREE_ACCOUNT_TYPES = {"pension_kr", "retirement_kr"}


def _tax_rate(currency: str, account_type: str | None = None) -> float:
    if account_type in TAX_FREE_ACCOUNT_TYPES:
        return 0.0
    if currency == "KRW":
        return 15.4
    if currency == "JPY":
        return 15.315
    return 15.0


def _annual_growth(current: float, previous: float | None) -> float | None:
    if previous is None or previous <= 0:
        return None
    return (current / previous - 1) * 100


def _annual_cagr(
    totals: dict[int, float],
    payment_counts: dict[int, int],
    end_year: int,
    years: int,
) -> float | None:
    start_value = totals.get(end_year - years)
    end_value = totals.get(end_year)
    if (
        start_value is None
        or end_value is None
        or start_value <= 0
        or end_value <= 0
        or payment_counts.get(end_year - years) != payment_counts.get(end_year)
    ):
        return None
    return ((end_value / start_value) ** (1 / years) - 1) * 100


def load_dividend_history(ticker: str) -> dict:
    clean_ticker = str(ticker or "").strip().upper()
    if not clean_ticker:
        raise ValueError("ticker is required")

    today = _today()
    with connect() as conn:
        ensure_dividend_tables(conn)
        ticker_row = conn.execute(
            "SELECT ticker, name, currency FROM tickers WHERE UPPER(ticker) = ?",
            (clean_ticker,),
        ).fetchone()
        if not ticker_row:
            raise ValueError("unknown ticker")
        event_rows = conn.execute(
            """
            SELECT ex_date, pay_date, amount, currency, source
            FROM dividend_events
            WHERE ticker = ?
              AND amount IS NOT NULL
              AND amount > 0
              AND date(COALESCE(pay_date, ex_date)) >= ?
              AND date(COALESCE(pay_date, ex_date)) <= ?
            ORDER BY date(COALESCE(pay_date, ex_date))
            """,
            (ticker_row["ticker"], f"{DIVIDEND_HISTORY_START_YEAR}-01-01", today.isoformat()),
        ).fetchall()

    annual: dict[int, dict] = {}
    for event in event_rows:
        schedule_text = event["pay_date"] or event["ex_date"]
        try:
            schedule_date = date.fromisoformat(schedule_text)
        except (TypeError, ValueError):
            continue
        year_row = annual.setdefault(
            schedule_date.year,
            {"amount": 0.0, "payments": 0, "last_date": schedule_text, "sources": set()},
        )
        year_row["amount"] += float(event["amount"])
        year_row["payments"] += 1
        year_row["last_date"] = max(year_row["last_date"], schedule_text)
        if event["source"]:
            year_row["sources"].add(event["source"])

    totals = {year: row["amount"] for year, row in annual.items()}
    payment_counts = {year: row["payments"] for year, row in annual.items()}
    rows = []
    for year in sorted(annual, reverse=True):
        row = annual[year]
        rows.append(
            {
                "year": year,
                "amount": row["amount"],
                "growth_pct": (
                    None
                    if year == today.year or payment_counts.get(year) != payment_counts.get(year - 1)
                    else _annual_growth(row["amount"], totals.get(year - 1))
                ),
                "payments": row["payments"],
                "last_date": row["last_date"],
                "current_ytd": year == today.year,
                "sources": sorted(row["sources"]),
            }
        )

    completed_years = sorted(year for year in totals if year < today.year)
    latest_completed = completed_years[-1] if completed_years else None
    latest_growth = (
        _annual_growth(totals[latest_completed], totals.get(latest_completed - 1))
        if (
            latest_completed is not None
            and payment_counts.get(latest_completed) == payment_counts.get(latest_completed - 1)
        )
        else None
    )
    cagr_3y = _annual_cagr(totals, payment_counts, latest_completed, 3) if latest_completed is not None else None
    cagr_5y = _annual_cagr(totals, payment_counts, latest_completed, 5) if latest_completed is not None else None
    estimate_rate = cagr_3y if cagr_3y is not None else latest_growth
    next_estimate = (
        totals[latest_completed] * (1 + estimate_rate / 100)
        if latest_completed is not None and estimate_rate is not None and estimate_rate > -100
        else None
    )
    return {
        "ticker": ticker_row["ticker"],
        "name": ticker_row["name"] or ticker_row["ticker"],
        "currency": ticker_row["currency"] or ticker_currency(ticker_row["ticker"]),
        "start_year": DIVIDEND_HISTORY_START_YEAR,
        "rows": rows,
        "summary": {
            "latest_completed_year": latest_completed,
            "latest_growth_pct": latest_growth,
            "cagr_3y": cagr_3y,
            "cagr_5y": cagr_5y,
            "next_year": latest_completed + 1 if latest_completed is not None else None,
            "next_estimate": next_estimate,
        },
    }


def load_dividends(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = clean_account_ids(account_ids)

    start = _today().replace(day=1)   # 이번 달 1일부터
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
        for holding in holdings_by_ticker.get(event["ticker"], []):
            tax_rate = _tax_rate(currency, holding["account_type"])
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

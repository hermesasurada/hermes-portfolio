from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from .constants import FX_DEFAULT_RATES, KOREAN_SUFFIXES
from .db import connect, ensure_dividend_tables
from .paths import KST
from .prices import latest_prices
from .tickers import normalize_yfinance_symbol, ticker_currency

DIVIDEND_CACHE_HOURS = 24
DIVIDEND_LOOKBACK_DAYS = 30
DIVIDEND_LOOKAHEAD_DAYS = 365


def _today() -> date:
    return datetime.now(KST).date()


def _now_text() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


def _date_text(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "date") and not isinstance(value, date):
        value = value.date()
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    text = str(value)
    return text[:10] if len(text) >= 10 else None


def _float_value(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _cache_due(fetched_at: str | None) -> bool:
    if not fetched_at:
        return True
    try:
        fetched = datetime.strptime(fetched_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)
    except ValueError:
        return True
    return datetime.now(KST) - fetched > timedelta(hours=DIVIDEND_CACHE_HOURS)


def _fetch_yahoo_dividends(ticker: str) -> list[dict]:
    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker) or ticker
    stock = yf.Ticker(symbol)
    currency = ticker_currency(ticker)
    events: dict[str, dict] = {}

    hist = stock.history(period="18mo", actions=True)
    if hist is not None and not hist.empty and "Dividends" in hist:
        dividends = hist[hist["Dividends"].fillna(0) > 0]["Dividends"]
        for idx, amount in dividends.items():
            ex_date = _date_text(idx)
            amount_value = _float_value(amount)
            if ex_date and amount_value:
                events[ex_date] = {
                    "ticker": ticker,
                    "ex_date": ex_date,
                    "pay_date": None,
                    "amount": amount_value,
                    "currency": currency,
                    "source": "yf-history",
                }

    try:
        calendar = stock.calendar or {}
    except Exception:
        calendar = {}
    ex_date = _date_text(calendar.get("Ex-Dividend Date"))
    pay_date = _date_text(calendar.get("Dividend Date"))
    if ex_date:
        last_amount = None
        if events:
            last_amount = events[sorted(events)[-1]].get("amount")
        event = events.get(ex_date) or {
            "ticker": ticker,
            "ex_date": ex_date,
            "amount": last_amount,
            "currency": currency,
            "source": "yf-calendar",
        }
        event["pay_date"] = pay_date or event.get("pay_date")
        event["source"] = "yf-calendar"
        events[ex_date] = event

    return list(events.values())


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
            SELECT ticker, fetched_at
            FROM ticker_dividend_cache
            WHERE ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall()
        fetched = {row["ticker"]: row["fetched_at"] for row in rows}
        due = [ticker for ticker in clean_tickers if _cache_due(fetched.get(ticker))]
        conn.commit()

    if not due:
        return

    with connect() as conn:
        ensure_dividend_tables(conn)
        for ticker in due:
            status = "ok"
            try:
                events = _fetch_yahoo_dividends(ticker)
            except Exception as exc:
                events = []
                status = f"error:{type(exc).__name__}"
            for event in events:
                if not event.get("ex_date"):
                    continue
                conn.execute(
                    """
                    INSERT INTO dividend_events
                      (ticker, ex_date, pay_date, amount, currency, source, fetched_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(ticker, ex_date) DO UPDATE SET
                        pay_date = COALESCE(excluded.pay_date, dividend_events.pay_date),
                        amount = COALESCE(excluded.amount, dividend_events.amount),
                        currency = COALESCE(excluded.currency, dividend_events.currency),
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


def _tax_rate(currency: str) -> float:
    if currency == "KRW":
        return 15.4
    if currency == "JPY":
        return 15.315
    return 15.0


def load_dividends(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = [int(value) for value in (account_ids or []) if str(value).strip()]
    account_filter = ""
    params: list[object] = []
    if cleaned_account_ids:
        placeholders = ",".join("?" for _ in cleaned_account_ids)
        account_filter = f"WHERE a.id IN ({placeholders})"
        params.extend(cleaned_account_ids)

    start = _today() - timedelta(days=DIVIDEND_LOOKBACK_DAYS)
    end = _today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS)

    with connect() as conn:
        ensure_dividend_tables(conn)
        holding_rows = conn.execute(
            f"""
            SELECT
                h.account_id,
                a.member,
                a.account_type,
                a.name AS account_name,
                h.ticker,
                h.qty,
                COALESCE(h.currency, tk.currency, '') AS currency,
                COALESCE(tk.name, h.name, h.ticker) AS name
            FROM holdings h
            JOIN accounts a ON a.id = h.account_id
            LEFT JOIN tickers tk ON tk.ticker = h.ticker
            {account_filter}
            ORDER BY a.id, h.ticker
            """,
            params,
        ).fetchall()

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
        if row["ticker"] and float(row["qty"] or 0) > 0 and not str(row["ticker"]).upper().endswith(KOREAN_SUFFIXES)
    ]
    tickers = sorted({row["ticker"] for row in holdings})
    refresh_dividend_events(tickers)

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
    for event in event_rows:
        currency = event["currency"] or ticker_currency(event["ticker"])
        amount = _float_value(event["amount"])
        if amount is None:
            continue
        rate = rates.get(currency, 1.0)
        tax_rate = _tax_rate(currency)
        for holding in holdings_by_ticker.get(event["ticker"], []):
            qty = holding["qty"]
            gross = amount * qty
            tax = gross * tax_rate / 100
            net = gross - tax
            net_krw = net * rate
            rows.append(
                {
                    "pay_date": event["pay_date"] or event["ex_date"],
                    "ex_date": event["ex_date"],
                    "member": holding["member"],
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

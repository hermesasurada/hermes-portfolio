from __future__ import annotations

from itertools import groupby

from .constants import FX_DEFAULT_RATES, MARKET_INDEXES
from .db import connect
from .prices import latest_prices
from .tickers import account_label, ticker_currency


def load_price_chart(ticker: str) -> dict:
    clean_ticker = (ticker or "").strip().upper()
    if not clean_ticker:
        raise ValueError("ticker is required")

    with connect() as conn:
        meta = conn.execute(
            """
            SELECT ticker, name, currency, category
            FROM tickers
            WHERE ticker = ?
            """,
            (clean_ticker,),
        ).fetchone()
        rows = conn.execute(
            """
            SELECT date, close
            FROM daily_prices
            WHERE ticker = ? AND close IS NOT NULL
            ORDER BY date
            """,
            (clean_ticker,),
        ).fetchall()
        transaction_rows = conn.execute(
            """
            SELECT
                t.trade_date,
                t.side,
                t.qty,
                t.price,
                COALESCE(t.currency, tk.currency, '') AS currency,
                COALESCE(t.member, a.member, '') AS member,
                a.account_type,
                a.name AS account_name
            FROM transactions t
            LEFT JOIN accounts a ON a.id = t.account_id
            LEFT JOIN tickers tk ON tk.ticker = t.ticker
            WHERE upper(t.ticker) = ?
            ORDER BY t.trade_date, t.id
            """,
            (clean_ticker,),
        ).fetchall()

    return {
        "ticker": clean_ticker,
        "name": (meta["name"] if meta and meta["name"] else clean_ticker),
        "currency": (meta["currency"] if meta and meta["currency"] else ticker_currency(clean_ticker)),
        "category": (meta["category"] if meta else None),
        "points": [
            {"date": row["date"], "close": float(row["close"])}
            for row in rows
            if row["date"] and row["close"] is not None
        ],
        "transactions": [
            {
                "date": row["trade_date"],
                "side": row["side"],
                "qty": float(row["qty"]),
                "price": float(row["price"]),
                "currency": row["currency"] or (meta["currency"] if meta and meta["currency"] else ticker_currency(clean_ticker)),
                "member": row["member"],
                "account": account_label(row["member"], row["account_type"] or "", row["account_name"]),
            }
            for row in transaction_rows
            if row["trade_date"] and row["side"] in {"BUY", "SELL"}
        ],
    }


def load_account_performance(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = [int(value) for value in (account_ids or []) if str(value).strip()]
    account_filter = ""
    params: list[object] = []
    if cleaned_account_ids:
        placeholders = ",".join("?" for _ in cleaned_account_ids)
        account_filter = f"WHERE a.id IN ({placeholders})"
        params.extend(cleaned_account_ids)

    with connect() as conn:
        prices = latest_prices(conn)
        account_rows = conn.execute(
            f"""
            SELECT a.id, a.member, a.account_type, a.name
            FROM accounts a
            {account_filter}
            ORDER BY a.id
            """,
            params,
        ).fetchall()
        holding_rows = conn.execute(
            f"""
            SELECT h.account_id, h.ticker, h.qty, COALESCE(h.currency, tk.currency, '') AS currency
            FROM holdings h
            JOIN accounts a ON a.id = h.account_id
            LEFT JOIN tickers tk ON tk.ticker = h.ticker
            {account_filter}
            ORDER BY h.account_id, h.ticker
            """,
            params,
        ).fetchall()

        holdings = [
            {
                "ticker": row["ticker"],
                "qty": float(row["qty"] or 0),
                "currency": row["currency"] or ticker_currency(row["ticker"]),
            }
            for row in holding_rows
            if row["ticker"] and float(row["qty"] or 0) > 0
        ]
        tickers = sorted({row["ticker"] for row in holdings})
        price_rows = []
        if tickers:
            placeholders = ",".join("?" for _ in tickers)
            price_rows = conn.execute(
                f"""
                SELECT date, ticker, close
                FROM daily_prices
                WHERE ticker IN ({placeholders})
                  AND close IS NOT NULL
                ORDER BY date, ticker
                """,
                tickers,
            ).fetchall()

        index_tickers = list(MARKET_INDEXES.keys())
        placeholders = ",".join("?" for _ in index_tickers)
        index_rows = conn.execute(
            f"""
            SELECT date, ticker, close
            FROM daily_prices
            WHERE ticker IN ({placeholders})
              AND close IS NOT NULL
            ORDER BY ticker, date
            """,
            index_tickers,
        ).fetchall()

    rates = {
        "KRW": 1.0,
        "USD": float(prices.get("USDKRW", {}).get("price") or FX_DEFAULT_RATES["USD"]),
        "EUR": float(prices.get("EURKRW", {}).get("price") or FX_DEFAULT_RATES["EUR"]),
        "JPY": float(prices.get("JPYKRW", {}).get("price") or FX_DEFAULT_RATES["JPY"]),
    }
    first_prices: dict[str, float] = {}
    for row in price_rows:
        first_prices.setdefault(row["ticker"], float(row["close"]))
    priced_tickers = set(first_prices)
    holding_specs = [
        {
            **holding,
            "rate": rates.get(holding["currency"], 1.0),
        }
        for holding in holdings
        if holding["ticker"] in priced_tickers
    ]
    tickers = sorted({holding["ticker"] for holding in holding_specs})

    latest_by_ticker: dict[str, float] = dict(first_prices)
    points = []
    for date, rows_iter in groupby(price_rows, key=lambda row: row["date"]):
        for row in rows_iter:
            latest_by_ticker[row["ticker"]] = float(row["close"])
        if tickers and all(ticker in latest_by_ticker for ticker in tickers):
            value = sum(
                holding["qty"] * latest_by_ticker[holding["ticker"]] * holding["rate"]
                for holding in holding_specs
            )
            if value > 0:
                points.append({"date": date, "value": value})

    indexes: dict[str, dict] = {}
    for ticker, rows_iter in groupby(index_rows, key=lambda row: row["ticker"]):
        indexes[ticker] = {
            "ticker": ticker,
            "name": MARKET_INDEXES.get(ticker, {}).get("name", ticker),
            "points": [
                {"date": row["date"], "value": float(row["close"])}
                for row in rows_iter
            ],
        }

    return {
        "accounts": [
            {
                "id": str(row["id"]),
                "member": row["member"],
                "name": account_label(row["member"], row["account_type"], row["name"]),
            }
            for row in account_rows
        ],
        "holdings_count": len(holding_specs),
        "points": points,
        "indexes": indexes,
    }

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from .db import connect
from .paths import DB_PATH, KST
from .prices import (
    apply_us_live_prices,
    fx_previous_rates,
    fx_rates,
    fx_updated_at,
    latest_prices,
    price_cache_updated_at,
    price_updated_at,
    us_market_status,
)
from .tickers import account_kind, account_label, account_scope, asset_class, ticker_currency, ticker_scope


def default_logo_hint(ticker: str, name: str) -> dict[str, str | None]:
    return {"kind": asset_class(ticker, name), "text": ticker[:2].upper(), "url": None}


def ensure_account(members: dict[str, dict], row) -> dict:
    member = row["member"]
    account_id = str(row["account_id"])
    member_obj = members.setdefault(
        member,
        {"name": member, "value_krw": 0.0, "accounts": {}},
    )
    return member_obj["accounts"].setdefault(
        account_id,
        {
            "id": account_id,
            "member": member,
            "type": row["account_type"],
            "kind": account_kind(row["account_type"]),
            "scope": account_scope(row["account_type"]),
            "name": account_label(member, row["account_type"], row["account_name"]),
            "region": row["region"],
            "value_krw": 0.0,
            "holdings": [],
        },
    )


def load_portfolio(us_extended: bool = False, logo_hint_fn: Callable[[str, str], dict[str, str | None]] | None = None) -> dict:
    logo_hint = logo_hint_fn or default_logo_hint
    with connect() as conn:
        prices = latest_prices(conn)
        rates = fx_rates(prices)
        previous_rates = fx_previous_rates(prices)
        account_rows = conn.execute(
            """
            SELECT
                a.member AS member,
                a.id AS account_id,
                a.account_type,
                a.name AS account_name,
                a.region
            FROM accounts a
            ORDER BY a.id
            """
        ).fetchall()
        rows = conn.execute(
            """
            SELECT
                COALESCE(h.member, a.member) AS member,
                a.id AS account_id,
                a.account_type,
                a.name AS account_name,
                a.region,
                h.ticker,
                h.name AS holding_name,
                h.qty,
                h.avg_price,
                h.invested,
                h.currency,
                h.updated_at,
                tk.next_earnings_date
            FROM holdings h
            JOIN accounts a ON h.account_id = a.id
            LEFT JOIN tickers tk ON tk.ticker = h.ticker
            ORDER BY h.account_id, h.ticker
            """
        ).fetchall()
        ticker_rows = conn.execute(
            """
            SELECT ticker, name, currency, category, next_earnings_date, earnings_updated_at
            FROM tickers
            WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''
            ORDER BY ticker
            """
        ).fetchall()

    market_status = us_market_status()
    us_market_meta = apply_us_live_prices(prices, ticker_rows, us_extended, market_status["is_regular"])

    members: dict[str, dict] = {}
    totals = {"value_krw": 0.0}

    for row in account_rows:
        ensure_account(members, row)

    for row in rows:
        currency = row["currency"] or ticker_currency(row["ticker"])
        current = prices.get(row["ticker"], {})
        current_price = current.get("price")
        previous_price = current.get("previous_price")
        change = None
        change_pct = None
        change_krw_pct = None
        if current_price is not None and previous_price not in (None, 0):
            change = float(current_price) - float(previous_price)
            change_pct = change / float(previous_price) * 100
        qty = float(row["qty"] or 0)
        value = qty * float(current_price) if current_price is not None else None
        rate = rates.get(currency, 1.0)
        previous_rate = previous_rates.get(currency, rate)
        if current_price is not None and previous_price not in (None, 0) and previous_rate not in (None, 0):
            previous_krw_price = float(previous_price) * float(previous_rate)
            current_krw_price = float(current_price) * float(rate)
            if currency != "KRW" and previous_krw_price:
                change_krw_pct = (current_krw_price - previous_krw_price) / previous_krw_price * 100
        value_krw = value * rate if value is not None else None
        name = row["holding_name"] or row["ticker"]

        account_obj = ensure_account(members, row)
        member_obj = members[row["member"]]

        holding = {
            "ticker": row["ticker"],
            "name": name,
            "qty": qty,
            "avg_price": row["avg_price"],
            "invested": row["invested"],
            "currency": currency,
            "account_kind": account_obj["kind"],
            "asset_class": asset_class(row["ticker"], name),
            "logo": logo_hint(row["ticker"], name),
            "current_price": current_price,
            "previous_price": previous_price,
            "previous_date": current.get("previous_date"),
            "change": change,
            "change_pct": change_pct,
            "change_krw_pct": change_krw_pct,
            "extended_price": current.get("extended_price"),
            "extended_base_price": current.get("extended_base_price"),
            "extended_change": current.get("extended_change"),
            "extended_change_pct": current.get("extended_change_pct"),
            "extended_source": current.get("extended_source"),
            "extended_market_state": current.get("extended_market_state"),
            "fx_rate": rate,
            "previous_fx_rate": previous_rate,
            "price_source": current.get("source"),
            "value": value,
            "value_krw": value_krw,
            "updated_at": row["updated_at"],
            "next_earnings_date": row["next_earnings_date"],
        }
        account_obj["holdings"].append(holding)

        if value_krw is not None:
            account_obj["value_krw"] += value_krw
            member_obj["value_krw"] += value_krw
            totals["value_krw"] += value_krw

    for member in members.values():
        member["accounts"] = list(member["accounts"].values())

    return {
        "as_of": datetime.now(KST).isoformat(timespec="seconds"),
        "db": str(DB_PATH),
        "fx": rates,
        "fx_updated": fx_updated_at(prices),
        "price_updated": price_updated_at(prices),
        "price_updated_at": price_cache_updated_at(),
        "us_market": {**market_status, **us_market_meta},
        "totals": totals,
        "members": list(members.values()),
        "tickers": [
            {
                "ticker": row["ticker"],
                "name": row["name"] or row["ticker"],
                "currency": row["currency"] or ticker_currency(row["ticker"]),
                "category": row["category"],
                "scope": ticker_scope(
                    row["ticker"],
                    row["name"] or row["ticker"],
                    row["category"],
                    row["currency"] or ticker_currency(row["ticker"]),
                ),
                "current_price": prices.get(row["ticker"], {}).get("price"),
                "previous_price": prices.get(row["ticker"], {}).get("previous_price"),
                "previous_date": prices.get(row["ticker"], {}).get("previous_date"),
                "change": (
                    float(prices[row["ticker"]]["price"]) - float(prices[row["ticker"]]["previous_price"])
                    if row["ticker"] in prices
                    and prices[row["ticker"]].get("price") is not None
                    and prices[row["ticker"]].get("previous_price") not in (None, 0)
                    else None
                ),
                "change_pct": (
                    (
                        float(prices[row["ticker"]]["price"])
                        - float(prices[row["ticker"]]["previous_price"])
                    )
                    / float(prices[row["ticker"]]["previous_price"])
                    * 100
                    if row["ticker"] in prices
                    and prices[row["ticker"]].get("price") is not None
                    and prices[row["ticker"]].get("previous_price") not in (None, 0)
                    else None
                ),
                "extended_change_pct": prices.get(row["ticker"], {}).get("extended_change_pct"),
                "next_earnings_date": row["next_earnings_date"],
                "earnings_updated_at": row["earnings_updated_at"],
                "logo": logo_hint(row["ticker"], row["name"] or row["ticker"]),
            }
            for row in ticker_rows
        ],
    }

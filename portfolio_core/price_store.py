from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable

from .constants import FX_TICKERS, MARKET_INDEXES
from .db import connect, ensure_collector_runs_table, ensure_ticker_metadata_columns
from .paths import KST
from .tickers import ticker_currency

CATEGORIES = ("fx", "crypto", "overseas", "kr", "index")


def infer_category(ticker: str, category: str | None = None) -> str:
    if category in CATEGORIES:
        return category
    if ticker in MARKET_INDEXES:
        return "index"
    if ticker == "BTC":
        return "crypto"
    if ticker in FX_TICKERS:
        return "fx"
    if ticker_currency(ticker) == "KRW":
        return "kr"
    return "overseas"


def load_watch(
    categories: Iterable[str] | None = None,
    tickers: Iterable[str] | None = None,
) -> dict[str, list[str]]:
    selected = set(categories or CATEGORIES)
    wanted_tickers = {ticker.strip().upper() for ticker in tickers or [] if ticker.strip()}
    result = {category: [] for category in CATEGORIES}

    with connect() as conn:
        rows = conn.execute("SELECT ticker, category FROM tickers ORDER BY ticker").fetchall()

    db_tickers = set()
    for row in rows:
        ticker = row["ticker"]
        db_tickers.add(ticker.upper())
        if wanted_tickers and ticker.upper() not in wanted_tickers:
            continue
        category = infer_category(ticker, row["category"])
        if category in selected:
            result[category].append(ticker)

    for ticker in sorted(wanted_tickers - db_tickers):
        category = infer_category(ticker)
        if category in selected:
            result[category].append(ticker)

    if "index" in selected:
        result["index"].extend(ticker for ticker in MARKET_INDEXES if not wanted_tickers or ticker in wanted_tickers)

    return {category: sorted(set(items)) for category, items in result.items()}


def load_ticker_profiles(tickers: Iterable[str]) -> dict[str, dict[str, str | None]]:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return {}
    placeholders = ",".join("?" for _ in clean_tickers)
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT ticker, name, category, currency
            FROM tickers
            WHERE ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall()
    return {
        row["ticker"].upper(): {
            "name": row["name"],
            "category": row["category"],
            "currency": row["currency"],
        }
        for row in rows
    }


def save_daily_prices(ticker: str, rows: Iterable[tuple[str, float]], source: str) -> int:
    clean_rows = [
        (date_str, ticker, float(price), source)
        for date_str, price in rows
        if date_str and price is not None
    ]
    if not clean_rows:
        return 0
    with connect() as conn:
        conn.executemany(
            """
            INSERT OR REPLACE INTO daily_prices (date, ticker, close, source)
            VALUES (?, ?, ?, ?)
            """,
            clean_rows,
        )
        conn.commit()
    return len(clean_rows)


def update_price_cache(entries: Iterable[tuple[str, float, str, str]]) -> None:
    clean_entries = list(entries)
    with connect() as conn:
        ensure_collector_runs_table(conn)
        conn.execute(
            """
            INSERT INTO collector_runs (name, updated_at, item_count, meta_json)
            VALUES ('price', ?, ?, NULL)
            ON CONFLICT(name) DO UPDATE SET
                updated_at = excluded.updated_at,
                item_count = excluded.item_count,
                meta_json = excluded.meta_json
            """,
            (datetime.now(timezone.utc).isoformat(), len(clean_entries)),
        )
        conn.commit()


def update_earnings_dates(entries: Iterable[tuple[str, str | None]]) -> int:
    clean_entries = [(ticker, date_text) for ticker, date_text in entries if ticker]
    if not clean_entries:
        return 0
    updated_at = datetime.now(KST).isoformat(timespec="seconds")
    with connect() as conn:
        ensure_ticker_metadata_columns(conn)
        conn.executemany(
            """
            UPDATE tickers
            SET next_earnings_date = ?, earnings_updated_at = ?
            WHERE ticker = ?
            """,
            [(date_text, updated_at, ticker) for ticker, date_text in clean_entries],
        )
        conn.commit()
    return len(clean_entries)


def earnings_update_due_tickers(tickers: Iterable[str], max_age_hours: float = 24) -> list[str]:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return []
    cutoff = datetime.now(KST) - timedelta(hours=max_age_hours)
    placeholders = ",".join("?" for _ in clean_tickers)
    with connect() as conn:
        ensure_ticker_metadata_columns(conn)
        rows = conn.execute(
            f"""
            SELECT ticker, earnings_updated_at
            FROM tickers
            WHERE ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall()
        conn.commit()

    metadata = {row["ticker"].upper(): row["earnings_updated_at"] for row in rows}
    due: list[str] = []
    for ticker in clean_tickers:
        updated_at = metadata.get(ticker)
        if not updated_at:
            due.append(ticker)
            continue
        try:
            updated_dt = datetime.fromisoformat(updated_at)
        except ValueError:
            due.append(ticker)
            continue
        if updated_dt.tzinfo is None:
            updated_dt = updated_dt.replace(tzinfo=KST)
        if updated_dt <= cutoff:
            due.append(ticker)
    return due

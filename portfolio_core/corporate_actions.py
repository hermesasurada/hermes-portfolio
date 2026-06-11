from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable

from .db import connect, ensure_stock_split_tables
from .dates import now_kst_text
from .paths import KST
from .tickers import normalize_yfinance_symbol

SPLIT_CACHE_HOURS = 24


def _split_cache_due(fetched_at: str | None) -> bool:
    if not fetched_at:
        return True
    try:
        fetched = datetime.strptime(fetched_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)
    except ValueError:
        return True
    return datetime.now(KST) - fetched > timedelta(hours=SPLIT_CACHE_HOURS)


def fetch_yahoo_stock_splits(ticker: str) -> list[tuple[str, float]]:
    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker)
    if not symbol:
        return []
    series = yf.Ticker(symbol).get_splits(period="max")
    if series is None or series.empty:
        return []
    return [
        (index.strftime("%Y-%m-%d"), float(ratio))
        for index, ratio in series.items()
        if ratio is not None and float(ratio) > 0 and abs(float(ratio) - 1.0) > 1e-12
    ]


def refresh_stock_splits(tickers: Iterable[str], force: bool = False) -> dict[str, int]:
    clean_tickers = sorted({str(ticker).strip().upper() for ticker in tickers if str(ticker).strip()})
    if not clean_tickers:
        return {}

    with connect() as conn:
        ensure_stock_split_tables(conn)
        placeholders = ",".join("?" for _ in clean_tickers)
        cache_rows = conn.execute(
            f"""
            SELECT ticker, fetched_at
            FROM ticker_split_cache
            WHERE ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall()
        fetched_at = {row["ticker"]: row["fetched_at"] for row in cache_rows}

    due = [
        ticker for ticker in clean_tickers
        if force or _split_cache_due(fetched_at.get(ticker))
    ]
    results: dict[str, int] = {}
    for ticker in due:
        now = now_kst_text()
        try:
            splits = fetch_yahoo_stock_splits(ticker)
            with connect() as conn:
                ensure_stock_split_tables(conn)
                existing_count = conn.execute(
                    "SELECT COUNT(*) FROM stock_splits WHERE ticker = ?", (ticker,)
                ).fetchone()[0]
                if splits or not existing_count:
                    conn.execute("DELETE FROM stock_splits WHERE ticker = ?", (ticker,))
                    conn.executemany(
                        """
                        INSERT INTO stock_splits
                          (ticker, split_date, ratio, source, fetched_at)
                        VALUES (?, ?, ?, 'yfinance', ?)
                        """,
                        [(ticker, split_date, ratio, now) for split_date, ratio in splits],
                    )
                conn.execute(
                    """
                    INSERT INTO ticker_split_cache (ticker, fetched_at, status)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ticker) DO UPDATE SET
                        fetched_at = excluded.fetched_at,
                        status = excluded.status
                    """,
                    (ticker, now, f"ok:{len(splits)}"),
                )
                conn.commit()
            results[ticker] = len(splits)
        except Exception as exc:
            with connect() as conn:
                ensure_stock_split_tables(conn)
                conn.execute(
                    """
                    INSERT INTO ticker_split_cache (ticker, fetched_at, status)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ticker) DO UPDATE SET
                        fetched_at = excluded.fetched_at,
                        status = excluded.status
                    """,
                    (ticker, now, f"error:{type(exc).__name__}"),
                )
                conn.commit()
            print(f"[splits] {ticker} failed: {type(exc).__name__}: {exc}")
    return results


from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from .constants import CRYPTO_MARKETS, FX_TICKERS, MARKET_INDEXES
from .db import connect, ensure_collector_runs_table, ensure_stock_split_tables, ensure_ticker_metadata_columns
from .paths import KST
from .tickers import ticker_currency

CATEGORIES = ("fx", "crypto", "overseas", "kr", "index")
SPLIT_REPAIR_TOLERANCE = 0.18
SPLIT_REPAIR_MAX_DATE_DISTANCE_DAYS = 20
SPLIT_REPAIR_MIN_MATERIAL_RATIO = 1.5


def infer_category(ticker: str, category: str | None = None) -> str:
    if category in CATEGORIES:
        return category
    if ticker in MARKET_INDEXES:
        return "index"
    if ticker in CRYPTO_MARKETS:
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
    repair_split_adjusted_daily_prices([ticker])
    return len(clean_rows)


def _date_value(value: str) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _material_split_ratio(ratio: float) -> bool:
    return ratio >= SPLIT_REPAIR_MIN_MATERIAL_RATIO or ratio <= 1.0 / SPLIT_REPAIR_MIN_MATERIAL_RATIO


def _split_break_ratio(price_ratio: float, break_date: str, splits: list[dict]) -> float | None:
    if price_ratio <= 0:
        return None
    parsed_break_date = _date_value(break_date)
    if parsed_break_date is None:
        return None
    for split in sorted(splits, key=lambda item: abs(float(item["ratio"]) - 1), reverse=True):
        ratio = float(split["ratio"])
        if ratio <= 0 or abs(ratio - 1.0) <= 1e-12:
            continue
        if not _material_split_ratio(ratio):
            continue
        split_date = _date_value(split["split_date"])
        if (
            split_date is None
            or abs((parsed_break_date - split_date).days) > SPLIT_REPAIR_MAX_DATE_DISTANCE_DAYS
        ):
            continue
        expected = 1.0 / ratio
        if expected <= 0:
            continue
        if abs(price_ratio - expected) / expected <= SPLIT_REPAIR_TOLERANCE:
            return ratio
    return None


def repair_split_adjusted_daily_prices(tickers: Iterable[str]) -> dict[str, int]:
    """Repair raw-close split discontinuities in `daily_prices`.

    Yahoo's `Close` can briefly mix pre-split and post-split scales during a new
    split window. We keep price performance as pure close-to-close (not dividend
    adjusted), so we only apply stock split ratios already stored in
    `stock_splits`. The repair is idempotent: after previous rows are divided by
    the split ratio, the adjacent split-like break disappears.
    """
    clean_tickers = sorted({str(ticker).strip().upper() for ticker in tickers if str(ticker).strip()})
    if not clean_tickers:
        return {}

    repaired: dict[str, int] = {}
    with connect() as conn:
        ensure_stock_split_tables(conn)
        for ticker in clean_tickers:
            splits = [
                {"split_date": row["split_date"], "ratio": float(row["ratio"])}
                for row in conn.execute(
                    """
                    SELECT split_date, ratio
                    FROM stock_splits
                    WHERE ticker = ?
                      AND ratio IS NOT NULL
                      AND ABS(ratio - 1.0) > 0.000000000001
                    """,
                    (ticker,),
                ).fetchall()
                if row["ratio"] is not None
                and float(row["ratio"]) > 0
                and _material_split_ratio(float(row["ratio"]))
            ]
            if not splits:
                continue

            rows = [
                {"date": row["date"], "close": float(row["close"])}
                for row in conn.execute(
                    """
                    SELECT date, close
                    FROM daily_prices
                    WHERE ticker = ?
                      AND close IS NOT NULL
                      AND close > 0
                    ORDER BY date
                    """,
                    (ticker,),
                ).fetchall()
            ]
            if len(rows) < 2:
                continue

            updates = 0
            for idx in range(1, len(rows)):
                prev = rows[idx - 1]["close"]
                cur = rows[idx]["close"]
                ratio = _split_break_ratio(cur / prev, rows[idx]["date"], splits)
                if ratio is None:
                    continue
                break_date = rows[idx]["date"]
                conn.execute(
                    """
                    UPDATE daily_prices
                    SET close = close / ?
                    WHERE ticker = ?
                      AND date < ?
                    """,
                    (ratio, ticker, break_date),
                )
                for prior in rows[:idx]:
                    prior["close"] /= ratio
                updates += 1
            if updates:
                repaired[ticker] = updates
        conn.commit()
    return repaired


def history_backfill_status(tickers: Iterable[str]) -> dict[str, tuple[int, bool]]:
    """{ticker: (보유 일별 행수, 백필을 이미 시도했는지)}.

    source LIKE '%backfill%' 행이 있으면 이미 1회 백필한 것으로 보고 재백필을 막는다
    (멱등성). 행이 아예 없는 종목은 결과에서 빠지므로 호출부에서 (0, False) 처리.
    """
    clean = [str(t) for t in tickers if t]
    if not clean:
        return {}
    placeholders = ",".join("?" for _ in clean)
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT ticker,
                   COUNT(date) AS n,
                   SUM(CASE WHEN source LIKE '%backfill%' THEN 1 ELSE 0 END) AS backfilled
            FROM daily_prices
            WHERE ticker IN ({placeholders})
            GROUP BY ticker
            """,
            clean,
        ).fetchall()
    return {row["ticker"]: (int(row["n"] or 0), bool(row["backfilled"])) for row in rows}


def update_collector_run(name: str, item_count: int, meta: dict | None = None) -> None:
    with connect() as conn:
        ensure_collector_runs_table(conn)
        conn.execute(
            """
            INSERT INTO collector_runs (name, updated_at, item_count, meta_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                updated_at = excluded.updated_at,
                item_count = excluded.item_count,
                meta_json = excluded.meta_json
            """,
            (
                name,
                datetime.now(timezone.utc).isoformat(),
                item_count,
                json.dumps(meta, ensure_ascii=False) if meta is not None else None,
            ),
        )
        conn.commit()


def collector_run_due(name: str, max_age_seconds: float) -> bool:
    with connect() as conn:
        ensure_collector_runs_table(conn)
        row = conn.execute(
            "SELECT updated_at FROM collector_runs WHERE name = ?",
            (name,),
        ).fetchone()
    if not row or not row["updated_at"]:
        return True
    try:
        updated_at = datetime.fromisoformat(str(row["updated_at"]).replace("Z", "+00:00"))
    except ValueError:
        return True
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - updated_at).total_seconds() >= max_age_seconds


def update_price_cache(entries: Iterable[tuple[str, float, str, str]]) -> None:
    clean_entries = list(entries)
    update_collector_run("price", len(clean_entries))


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

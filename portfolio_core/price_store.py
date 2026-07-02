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

# 야후 원본의 단발 bad tick(스파이크/딥) 정제 기준. 양끝 정상 사이에서
# 가운데 1~N일만 극단으로 튀었다가 곧바로 복귀하는 구간만 오염으로 보고 제거.
# '복귀' 조건 덕에 실제 급락/급등·분할(복귀 안 함)은 보존된다.
SPIKE_EXTREME_LOW = 0.4     # 직전 정상값 대비 -60% 이하로 급락하면 이탈 후보
SPIKE_EXTREME_HIGH = 2.5    # +150% 이상 급등하면 이탈 후보
SPIKE_CONTINUITY_LOW = 0.6  # 오염 구간 양끝(정상↔정상)이 서로 이 범위면 '연속=복귀'로 판정
SPIKE_CONTINUITY_HIGH = 1.7
SPIKE_MAX_RUN_DAYS = 5       # 오염으로 간주할 최대 연속 길이(그 이상은 스케일 변화로 보고 보존)


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
    sanitize_price_spikes([ticker])
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


def sanitize_price_spikes(tickers: Iterable[str]) -> dict[str, int]:
    """야후 원본의 단발 bad tick(스파이크/딥) 제거. 양끝이 정상 스케일로
    이어지는데 가운데 1~SPIKE_MAX_RUN_DAYS일만 극단으로 튀었다가 곧바로
    복귀하고, 그 구간에 stock_splits 기록도 없으면 오염으로 보고 삭제.
    '복귀' 조건 덕에 실제 급락/급등·분할(복귀 안 함)은 보존한다. 멱등."""
    removed: dict[str, int] = {}
    with connect() as conn:
        ensure_stock_split_tables(conn)
        for raw_ticker in tickers:
            ticker = str(raw_ticker or "").strip().upper()
            if not ticker:
                continue
            rows = conn.execute(
                "SELECT date, close FROM daily_prices WHERE ticker = ? AND close > 0 ORDER BY date",
                (ticker,),
            ).fetchall()
            if len(rows) < 3:
                continue
            split_dates = [
                parsed
                for parsed in (
                    _date_value(s["split_date"])
                    for s in conn.execute(
                        "SELECT split_date FROM stock_splits WHERE ticker = ?", (ticker,)
                    ).fetchall()
                )
                if parsed
            ]
            closes = [(r["date"], float(r["close"])) for r in rows]
            n = len(closes)
            to_delete: list[str] = []
            i = 1  # 시작·끝값은 양끝 비교가 불가하므로 건드리지 않는다
            while i < n - 1:
                prev = closes[i - 1][1]
                ratio = closes[i][1] / prev if prev else 1.0
                if SPIKE_EXTREME_LOW <= ratio <= SPIKE_EXTREME_HIGH:
                    i += 1
                    continue
                # prev 대비 극단 이탈이 이어지는 구간[i, j)
                j = i
                while j < n:
                    r = closes[j][1] / prev if prev else 1.0
                    if SPIKE_EXTREME_LOW <= r <= SPIKE_EXTREME_HIGH:
                        break
                    j += 1
                if j >= n:  # 끝까지 극단(복귀 없음) → 스케일 변화/실제로 보고 보존
                    break
                continuity = closes[j][1] / prev if prev else None
                run_dates = [closes[k][0] for k in range(i, j)]
                near_split = any(
                    _date_value(rd) is not None
                    and any(
                        abs((_date_value(rd) - sd).days) <= SPLIT_REPAIR_MAX_DATE_DISTANCE_DAYS
                        for sd in split_dates
                    )
                    for rd in run_dates
                )
                if (
                    (j - i) <= SPIKE_MAX_RUN_DAYS
                    and continuity is not None
                    and SPIKE_CONTINUITY_LOW <= continuity <= SPIKE_CONTINUITY_HIGH
                    and not near_split
                ):
                    to_delete.extend(run_dates)
                i = j
            if to_delete:
                placeholders = ",".join("?" for _ in to_delete)
                conn.execute(
                    f"DELETE FROM daily_prices WHERE ticker = ? AND date IN ({placeholders})",
                    (ticker, *to_delete),
                )
                removed[ticker] = len(to_delete)
        conn.commit()
    return removed


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

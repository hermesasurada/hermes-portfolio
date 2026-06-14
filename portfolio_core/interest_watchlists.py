from __future__ import annotations

from datetime import datetime

from .db import connect, ensure_interest_watchlist_tables
from .paths import KST
from .tickers import asset_class, ticker_currency


INITIAL_GROUPS = (
    ("주요 지수", 10),
    ("환율", 20),
    ("디지털자산", 30),
    ("한국 개별주", 40),
    ("한국 ETF", 50),
    ("미국 개별주", 60),
    ("미국 ETF", 70),
    ("일본 종목", 80),
    ("유럽 종목", 90),
    ("기타 해외", 100),
)


def now_text() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


def initial_group_name(ticker: str, name: str, category: str | None, currency: str | None) -> str:
    category = str(category or "").lower()
    currency = str(currency or ticker_currency(ticker)).upper()
    kind = asset_class(ticker, name)
    if category == "index":
        return "주요 지수"
    if category == "fx":
        return "환율"
    if category == "crypto":
        return "디지털자산"
    if category == "kr" or ticker.endswith((".KS", ".KQ")):
        return "한국 ETF" if kind == "etf" else "한국 개별주"
    if currency == "JPY":
        return "일본 종목"
    if currency == "EUR":
        return "유럽 종목"
    if currency == "USD":
        return "미국 ETF" if kind == "etf" else "미국 개별주"
    return "기타 해외"


def seed_initial_interest_watchlists(conn) -> None:
    ensure_interest_watchlist_tables(conn)
    seeded = conn.execute(
        "SELECT value FROM interest_watchlist_settings WHERE key = 'initial_seeded'"
    ).fetchone()
    if seeded:
        return

    created_at = now_text()
    group_ids: dict[str, int] = {}
    for name, sort_order in INITIAL_GROUPS:
        cursor = conn.execute(
            """
            INSERT INTO interest_watchlist_groups (name, sort_order, created_at)
            VALUES (?, ?, ?)
            """,
            (name, sort_order, created_at),
        )
        group_ids[name] = int(cursor.lastrowid)

    rows = conn.execute(
        """
        SELECT ticker, name, category, currency
        FROM tickers
        WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''
        ORDER BY ticker
        """
    ).fetchall()
    item_orders: dict[int, int] = {}
    for row in rows:
        group_name = initial_group_name(
            row["ticker"],
            row["name"] or row["ticker"],
            row["category"],
            row["currency"],
        )
        group_id = group_ids[group_name]
        item_orders[group_id] = item_orders.get(group_id, 0) + 10
        conn.execute(
            """
            INSERT INTO interest_watchlist_items (group_id, ticker, sort_order, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (group_id, row["ticker"], item_orders[group_id], created_at),
        )

    conn.execute(
        """
        INSERT INTO interest_watchlist_settings (key, value)
        VALUES ('initial_seeded', ?)
        """,
        (created_at,),
    )


def load_interest_watchlists() -> dict:
    with connect() as conn:
        seed_initial_interest_watchlists(conn)
        groups = conn.execute(
            """
            SELECT id, name
            FROM interest_watchlist_groups
            ORDER BY sort_order, id
            """
        ).fetchall()
        items = conn.execute(
            """
            SELECT
                i.group_id,
                i.ticker,
                COALESCE(t.name, i.ticker) AS name,
                COALESCE(t.currency, '') AS currency,
                COALESCE(t.category, '') AS category
            FROM interest_watchlist_items i
            LEFT JOIN tickers t ON t.ticker = i.ticker
            ORDER BY i.group_id, i.sort_order, i.ticker
            """
        ).fetchall()
        conn.commit()

    by_group: dict[int, list[dict]] = {}
    for row in items:
        by_group.setdefault(int(row["group_id"]), []).append(
            {
                "ticker": row["ticker"],
                "name": row["name"],
                "currency": row["currency"] or ticker_currency(row["ticker"]),
                "category": row["category"] or None,
            }
        )
    return {
        "groups": [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "items": by_group.get(int(row["id"]), []),
            }
            for row in groups
        ]
    }


def create_interest_group(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("그룹명을 입력해야 합니다.")
    if len(name) > 40:
        raise ValueError("그룹명은 40자 이내로 입력해야 합니다.")
    with connect() as conn:
        ensure_interest_watchlist_tables(conn)
        duplicate = conn.execute(
            "SELECT 1 FROM interest_watchlist_groups WHERE name = ? COLLATE NOCASE",
            (name,),
        ).fetchone()
        if duplicate:
            raise ValueError("같은 이름의 그룹이 이미 있습니다.")
        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 10 FROM interest_watchlist_groups"
        ).fetchone()[0]
        conn.execute(
            """
            INSERT INTO interest_watchlist_groups (name, sort_order, created_at)
            VALUES (?, ?, ?)
            """,
            (name, next_order, now_text()),
        )
        conn.commit()
    return load_interest_watchlists()


def delete_interest_group(payload: dict) -> dict:
    group_id = int(payload.get("group_id") or 0)
    if group_id <= 0:
        raise ValueError("삭제할 그룹이 올바르지 않습니다.")
    with connect() as conn:
        ensure_interest_watchlist_tables(conn)
        if not conn.execute(
            "SELECT 1 FROM interest_watchlist_groups WHERE id = ?",
            (group_id,),
        ).fetchone():
            raise ValueError("그룹을 찾지 못했습니다.")
        conn.execute("DELETE FROM interest_watchlist_items WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM interest_watchlist_groups WHERE id = ?", (group_id,))
        conn.commit()
    return load_interest_watchlists()


def add_interest_item(payload: dict) -> dict:
    group_id = int(payload.get("group_id") or 0)
    ticker = str(payload.get("ticker") or "").strip().upper()
    if group_id <= 0 or not ticker:
        raise ValueError("그룹과 종목을 선택해야 합니다.")
    with connect() as conn:
        ensure_interest_watchlist_tables(conn)
        if not conn.execute(
            "SELECT 1 FROM interest_watchlist_groups WHERE id = ?",
            (group_id,),
        ).fetchone():
            raise ValueError("그룹을 찾지 못했습니다.")
        if not conn.execute("SELECT 1 FROM tickers WHERE UPPER(ticker) = ?", (ticker,)).fetchone():
            raise ValueError("가격수집 대상에 등록된 종목만 추가할 수 있습니다.")
        if conn.execute(
            "SELECT 1 FROM interest_watchlist_items WHERE group_id = ? AND ticker = ?",
            (group_id, ticker),
        ).fetchone():
            raise ValueError("이미 이 그룹에 포함된 종목입니다.")
        next_order = conn.execute(
            """
            SELECT COALESCE(MAX(sort_order), 0) + 10
            FROM interest_watchlist_items
            WHERE group_id = ?
            """,
            (group_id,),
        ).fetchone()[0]
        conn.execute(
            """
            INSERT INTO interest_watchlist_items (group_id, ticker, sort_order, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (group_id, ticker, next_order, now_text()),
        )
        conn.commit()
    return load_interest_watchlists()


def delete_interest_item(payload: dict) -> dict:
    group_id = int(payload.get("group_id") or 0)
    ticker = str(payload.get("ticker") or "").strip().upper()
    if group_id <= 0 or not ticker:
        raise ValueError("삭제할 종목이 올바르지 않습니다.")
    with connect() as conn:
        ensure_interest_watchlist_tables(conn)
        cursor = conn.execute(
            "DELETE FROM interest_watchlist_items WHERE group_id = ? AND ticker = ?",
            (group_id, ticker),
        )
        if cursor.rowcount == 0:
            raise ValueError("관심목록에서 종목을 찾지 못했습니다.")
        conn.commit()
    return load_interest_watchlists()

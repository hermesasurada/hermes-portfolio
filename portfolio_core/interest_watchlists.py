from __future__ import annotations

from datetime import datetime

from .db import connect
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


# 가상 "기타" 그룹 — 항상 최하위, 삭제·이름변경 불가(실제 DB 행 아님).
# 가격수집 대상(tickers 테이블)인데 어느 그룹에도 없는 종목을 모은다.
# id=0이라 모든 변경 API의 group_id<=0 가드에 자동으로 막힌다.
OTHERS_GROUP_ID = 0
OTHERS_GROUP_NAME = "기타"
SPECIAL_GROUP_BY_CATEGORY = {
    "index": "주요 지수",
    "fx": "환율",
}


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


def ensure_group_by_name(conn, name: str) -> int:
    row = conn.execute(
        "SELECT id FROM interest_watchlist_groups WHERE name = ? COLLATE NOCASE",
        (name,),
    ).fetchone()
    if row:
        return int(row["id"])
    order_map = dict(INITIAL_GROUPS)
    sort_order = order_map.get(name)
    if sort_order is None:
        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 10 FROM interest_watchlist_groups"
        ).fetchone()[0]
    cursor = conn.execute(
        """
        INSERT INTO interest_watchlist_groups (name, sort_order, created_at)
        VALUES (?, ?, ?)
        """,
        (name, sort_order, now_text()),
    )
    return int(cursor.lastrowid)


def insert_interest_item_if_missing(conn, group_id: int, ticker: str) -> bool:
    if conn.execute(
        "SELECT 1 FROM interest_watchlist_items WHERE group_id = ? AND ticker = ?",
        (group_id, ticker),
    ).fetchone():
        return False
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
    return True


def sync_special_interest_items(items: list[dict]) -> int:
    targets = [
        (
            str(item.get("ticker") or "").strip().upper(),
            SPECIAL_GROUP_BY_CATEGORY.get(str(item.get("category") or "").lower()),
        )
        for item in items
    ]
    targets = [(ticker, group_name) for ticker, group_name in targets if ticker and group_name]
    if not targets:
        return 0
    added = 0
    with connect() as conn:
        for ticker, group_name in targets:
            group_id = ensure_group_by_name(conn, group_name)
            if insert_interest_item_if_missing(conn, group_id, ticker):
                added += 1
        conn.commit()
    return added


def protected_group_required_category(group_name: str | None) -> str | None:
    for category, name in SPECIAL_GROUP_BY_CATEGORY.items():
        if str(group_name or "").casefold() == name.casefold():
            return category
    return None


def seed_initial_interest_watchlists(conn) -> None:
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
                COALESCE(NULLIF(t.display_name, ''), t.name, i.ticker) AS name,
                COALESCE(t.currency, '') AS currency,
                COALESCE(t.category, '') AS category
            FROM interest_watchlist_items i
            LEFT JOIN tickers t ON t.ticker = i.ticker
            ORDER BY i.group_id, i.sort_order, i.ticker
            """
        ).fetchall()
        # 가격수집 대상(tickers)인데 어느 그룹에도 없는 종목 = "기타"
        others = conn.execute(
            """
            SELECT
                t.ticker,
                COALESCE(NULLIF(t.display_name, ''), t.name, t.ticker) AS name,
                COALESCE(t.currency, '') AS currency,
                COALESCE(t.category, '') AS category
            FROM tickers t
            WHERE t.ticker IS NOT NULL AND TRIM(t.ticker) <> ''
              AND UPPER(t.ticker) NOT IN (
                  SELECT UPPER(ticker) FROM interest_watchlist_items
              )
            ORDER BY t.category, t.ticker
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
    result_groups = [
        {
            "id": int(row["id"]),
            "name": row["name"],
            "items": by_group.get(int(row["id"]), []),
        }
        for row in groups
    ]
    # "기타"는 항상 최하위에 강제 추가 (삭제·이름변경·이동 불가).
    result_groups.append(
        {
            "id": OTHERS_GROUP_ID,
            "name": OTHERS_GROUP_NAME,
            "fixed": True,
            "items": [
                {
                    "ticker": row["ticker"],
                    "name": row["name"],
                    "currency": row["currency"] or ticker_currency(row["ticker"]),
                    "category": row["category"] or None,
                }
                for row in others
            ],
        }
    )
    return {"groups": result_groups}


def create_interest_group(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("그룹명을 입력해야 합니다.")
    if len(name) > 40:
        raise ValueError("그룹명은 40자 이내로 입력해야 합니다.")
    with connect() as conn:
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


def rename_interest_group(payload: dict) -> dict:
    group_id = int(payload.get("group_id") or 0)
    name = str(payload.get("name") or "").strip()
    if group_id <= 0:
        raise ValueError("이름을 변경할 그룹이 올바르지 않습니다.")
    if not name:
        raise ValueError("그룹명을 입력해야 합니다.")
    if len(name) > 40:
        raise ValueError("그룹명은 40자 이내로 입력해야 합니다.")
    with connect() as conn:
        if not conn.execute(
            "SELECT 1 FROM interest_watchlist_groups WHERE id = ?",
            (group_id,),
        ).fetchone():
            raise ValueError("그룹을 찾지 못했습니다.")
        duplicate = conn.execute(
            """
            SELECT 1
            FROM interest_watchlist_groups
            WHERE name = ? COLLATE NOCASE AND id <> ?
            """,
            (name, group_id),
        ).fetchone()
        if duplicate:
            raise ValueError("같은 이름의 그룹이 이미 있습니다.")
        conn.execute(
            "UPDATE interest_watchlist_groups SET name = ? WHERE id = ?",
            (name, group_id),
        )
        conn.commit()
    return load_interest_watchlists()


def reorder_interest_groups(payload: dict) -> dict:
    raw_ids = payload.get("group_ids")
    if not isinstance(raw_ids, list):
        raise ValueError("그룹 순서가 올바르지 않습니다.")
    try:
        group_ids = [int(group_id) for group_id in raw_ids]
    except (TypeError, ValueError) as exc:
        raise ValueError("그룹 순서가 올바르지 않습니다.") from exc
    if not group_ids or len(group_ids) != len(set(group_ids)):
        raise ValueError("그룹 순서가 올바르지 않습니다.")
    with connect() as conn:
        existing_ids = {
            int(row["id"])
            for row in conn.execute("SELECT id FROM interest_watchlist_groups").fetchall()
        }
        if set(group_ids) != existing_ids:
            raise ValueError("전체 관심그룹 순서가 필요합니다.")
        for index, group_id in enumerate(group_ids, start=1):
            conn.execute(
                "UPDATE interest_watchlist_groups SET sort_order = ? WHERE id = ?",
                (index * 10, group_id),
            )
        conn.commit()
    return load_interest_watchlists()


def delete_interest_group(payload: dict) -> dict:
    group_id = int(payload.get("group_id") or 0)
    if group_id <= 0:
        raise ValueError("삭제할 그룹이 올바르지 않습니다.")
    with connect() as conn:
        group = conn.execute(
            "SELECT name FROM interest_watchlist_groups WHERE id = ?",
            (group_id,),
        ).fetchone()
        if not group:
            raise ValueError("그룹을 찾지 못했습니다.")
        if protected_group_required_category(group["name"]):
            raise ValueError("지수/환율 그룹은 삭제할 수 없습니다.")
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
        group = conn.execute(
            "SELECT name FROM interest_watchlist_groups WHERE id = ?",
            (group_id,),
        ).fetchone()
        if not group:
            raise ValueError("그룹을 찾지 못했습니다.")
        ticker_row = conn.execute(
            "SELECT ticker, COALESCE(category, '') AS category FROM tickers WHERE UPPER(ticker) = ?",
            (ticker,),
        ).fetchone()
        if not ticker_row:
            raise ValueError("가격수집 대상에 등록된 종목만 추가할 수 있습니다.")
        required_category = protected_group_required_category(group["name"])
        ticker_category = str(ticker_row["category"] or "").lower()
        if required_category and ticker_category != required_category:
            target_name = SPECIAL_GROUP_BY_CATEGORY[required_category]
            raise ValueError(f"{target_name} 그룹에는 해당 유형의 항목만 추가할 수 있습니다.")
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
        row = conn.execute(
            """
            SELECT
                g.name AS group_name,
                COALESCE(t.category, '') AS category
            FROM interest_watchlist_items i
            JOIN interest_watchlist_groups g ON g.id = i.group_id
            LEFT JOIN tickers t ON UPPER(t.ticker) = UPPER(i.ticker)
            WHERE i.group_id = ? AND UPPER(i.ticker) = ?
            """,
            (group_id, ticker),
        ).fetchone()
        if not row:
            raise ValueError("관심목록에서 종목을 찾지 못했습니다.")
        if protected_group_required_category(row["group_name"]) or str(row["category"] or "").lower() in {"index", "fx"}:
            raise ValueError("지수/환율 항목은 삭제할 수 없습니다.")
        cursor = conn.execute(
            "DELETE FROM interest_watchlist_items WHERE group_id = ? AND ticker = ?",
            (group_id, ticker),
        )
        if cursor.rowcount == 0:
            raise ValueError("관심목록에서 종목을 찾지 못했습니다.")
        conn.commit()
    return load_interest_watchlists()

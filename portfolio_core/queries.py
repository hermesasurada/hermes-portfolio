from __future__ import annotations

import sqlite3
from typing import Iterable


TICKER_SEARCH_ALIASES = {
    "AAPL": ("애플",),
    "ABNB": ("에어비앤비",),
    "ADI": ("아날로그디바이시스",),
    "AMAT": ("어플라이드머티어리얼즈", "어플라이드 머티리얼즈"),
    "AMD": ("에이엠디",),
    "AMZN": ("아마존",),
    "ANET": ("아리스타네트웍스", "아리스타"),
    "APH": ("암페놀",),
    "ARM": ("암",),
    "ASML": ("에이에스엠엘",),
    "AVGO": ("브로드컴",),
    "BA": ("보잉",),
    "BLK": ("블랙록",),
    "BX": ("블랙스톤",),
    "CAT": ("캐터필러",),
    "COHR": ("코히런트",),
    "COST": ("코스트코",),
    "CRWD": ("크라우드스트라이크",),
    "CRWV": ("코어위브",),
    "CSCO": ("시스코",),
    "DE": ("디어", "존디어"),
    "DELL": ("델",),
    "DIS": ("디즈니",),
    "DPZ": ("도미노피자", "도미노"),
    "EME": ("엠코어",),
    "ENPH": ("엔페이즈",),
    "F": ("포드",),
    "FIX": ("컴포트시스템즈",),
    "FSLR": ("퍼스트솔라",),
    "GD": ("제너럴다이내믹스",),
    "GE": ("지이", "GE에어로스페이스"),
    "GEV": ("GE버노바", "지이버노바"),
    "GLW": ("코닝",),
    "GM": ("제너럴모터스",),
    "GOOGL": ("구글", "알파벳"),
    "GS": ("골드만삭스",),
    "HON": ("허니웰",),
    "HOOD": ("로빈후드",),
    "HWM": ("하우멧", "하우멧에어로스페이스"),
    "INTC": ("인텔",),
    "IRDM": ("이리듐",),
    "ISRG": ("인튜이티브서지컬",),
    "JNJ": ("존슨앤존슨",),
    "JPM": ("제이피모건", "JP모건"),
    "KLAC": ("KLA", "케이엘에이"),
    "KO": ("코카콜라",),
    "LLY": ("일라이릴리", "릴리"),
    "LMT": ("록히드마틴",),
    "LRCX": ("램리서치",),
    "MA": ("마스터카드",),
    "MAR": ("메리어트",),
    "MCD": ("맥도날드",),
    "MEDP": ("메드페이스",),
    "META": ("메타", "페이스북"),
    "MMM": ("쓰리엠", "3M"),
    "MP": ("MP머티리얼즈",),
    "MRK": ("머크",),
    "MRVL": ("마벨", "마벨테크놀로지"),
    "MS": ("모건스탠리",),
    "MSFT": ("마이크로소프트",),
    "MU": ("마이크론",),
    "NBIS": ("네비우스",),
    "NKE": ("나이키",),
    "NOC": ("노스롭그루먼",),
    "NVDA": ("엔비디아",),
    "ORCL": ("오라클",),
    "PANW": ("팔로알토", "팔로알토네트웍스"),
    "PEP": ("펩시", "펩시코"),
    "PG": ("프록터앤갬블", "P&G"),
    "PH": ("파커하니핀",),
    "PL": ("플래닛랩스",),
    "PLTR": ("팔란티어",),
    "PWR": ("콴타서비스",),
    "PYPL": ("페이팔",),
    "QCOM": ("퀄컴",),
    "RACE": ("페라리",),
    "RKLB": ("로켓랩",),
    "RTX": ("RTX", "레이시온"),
    "SOFI": ("소파이",),
    "SPCX": ("스페이스엑스",),
    "SYM": ("심보틱",),
    "TSLA": ("테슬라",),
    "TSM": ("TSMC", "티에스엠씨", "대만반도체"),
    "TXN": ("텍사스인스트루먼트",),
    "UBER": ("우버",),
    "UNH": ("유나이티드헬스",),
    "V": ("비자",),
    "VRT": ("버티브",),
    "WM": ("웨이스트매니지먼트",),
    "WMT": ("월마트",),
    "XOM": ("엑슨모빌",),
}


def clean_account_ids(account_ids: Iterable[str] | None) -> list[int]:
    return [int(value) for value in (account_ids or []) if str(value).strip()]


def load_collection_diagnostics(conn: sqlite3.Connection) -> dict:
    """수집 상태 진단 — 기존 DB 흔적만 노출(새 수집 없음). 조용히 삼켜지던 실패를
    화면에 보이게 하기 위함."""
    dividend_errors = conn.execute(
        "SELECT ticker, status FROM ticker_dividend_cache WHERE status LIKE '%_error%' ORDER BY ticker"
    ).fetchall()
    stale = conn.execute(
        """
        WITH latest AS (SELECT MAX(date) AS d FROM daily_prices)
        SELECT t.ticker, MAX(p.date) AS last_date
        FROM tickers t
        JOIN daily_prices p ON p.ticker = t.ticker
        WHERE t.category IN ('overseas', 'kr', 'crypto')
        GROUP BY t.ticker
        HAVING julianday((SELECT d FROM latest)) - julianday(MAX(p.date)) > 4
        ORDER BY last_date
        """
    ).fetchall()
    run = conn.execute(
        "SELECT updated_at, item_count FROM collector_runs WHERE name = 'price'"
    ).fetchone()
    daily_run = conn.execute(
        "SELECT updated_at, item_count FROM collector_runs WHERE name = 'price-daily'"
    ).fetchone()
    return {
        "dividend_errors": [{"ticker": row["ticker"], "status": row["status"]} for row in dividend_errors],
        "stale_prices": [{"ticker": row["ticker"], "last_date": row["last_date"]} for row in stale],
        "price_run": ({"updated_at": run["updated_at"], "item_count": run["item_count"]} if run else None),
        "daily_price_run": (
            {"updated_at": daily_run["updated_at"], "item_count": daily_run["item_count"]}
            if daily_run else None
        ),
    }


def load_ticker_directory(conn: sqlite3.Connection) -> list[dict]:
    """DB에 등록된 전체 종목(티커·이름) — 비교 검색 자동완성용. DB 전용."""
    rows = conn.execute(
        """
        SELECT ticker, COALESCE(NULLIF(display_name, ''), name) AS name
        FROM tickers
        WHERE ticker IS NOT NULL AND TRIM(ticker) <> ''
        ORDER BY ticker
        """
    ).fetchall()
    return [
        {
            "ticker": row["ticker"],
            "name": row["name"] or row["ticker"],
            "aliases": list(TICKER_SEARCH_ALIASES.get(str(row["ticker"]).upper(), ())),
        }
        for row in rows
    ]


def account_filter_clause(account_ids: list[int], alias: str = "a") -> tuple[str, list[object]]:
    if not account_ids:
        return "", []
    placeholders = ",".join("?" for _ in account_ids)
    return f"WHERE {alias}.id IN ({placeholders})", list(account_ids)


def load_holding_rows(
    conn: sqlite3.Connection,
    account_ids: list[int] | None = None,
    positive_only: bool = False,
) -> list[sqlite3.Row]:
    params: list[object] = []
    conditions: list[str] = []
    if account_ids:
        placeholders = ",".join("?" for _ in account_ids)
        conditions.append(f"a.id IN ({placeholders})")
        params.extend(account_ids)
    if positive_only:
        conditions.append("COALESCE(h.qty, 0) > 0")
    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    return conn.execute(
        f"""
        SELECT
            h.account_id,
            COALESCE(h.member, a.member) AS member,
            a.account_type,
            a.name AS account_name,
            a.region,
            h.ticker,
            h.qty,
            h.avg_price,
            h.invested,
            h.updated_at,
            COALESCE(h.currency, tk.currency, '') AS currency,
            COALESCE(NULLIF(tk.display_name, ''), tk.name, h.name, h.ticker) AS name
        FROM holdings h
        JOIN accounts a ON a.id = h.account_id
        LEFT JOIN tickers tk ON tk.ticker = h.ticker
        {where_sql}
        ORDER BY h.account_id, h.ticker
        """,
        params,
    ).fetchall()

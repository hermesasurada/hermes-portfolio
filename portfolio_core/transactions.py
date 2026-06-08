from __future__ import annotations

import sqlite3
from collections.abc import Callable
from datetime import datetime

from .accounts import load_account, load_holding, load_ticker_info
from .constants import KOREAN_SUFFIXES
from .db import connect
from .paths import KST
from .portfolio import load_portfolio
from .tickers import account_scope, ticker_currency, ticker_scope


def ensure_ticker(conn: sqlite3.Connection, ticker: str, name: str, currency: str) -> None:
    if not ticker:
        return
    category = "crypto" if ticker == "BTC" else "kr" if ticker.endswith(KOREAN_SUFFIXES) else "overseas"
    region = "KR" if category == "kr" else "US"
    conn.execute(
        """
        INSERT INTO tickers (ticker, name, region, currency, added_date, category)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
            name = COALESCE(NULLIF(excluded.name, ''), tickers.name),
            currency = COALESCE(NULLIF(excluded.currency, ''), tickers.currency),
            category = COALESCE(tickers.category, excluded.category)
        """,
        (ticker, name, region, currency, datetime.now().strftime("%Y-%m-%d"), category),
    )


def parse_trade_date(value: str | None) -> str:
    if not value:
        return datetime.now().strftime("%Y-%m-%d")
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("거래일은 YYYY-MM-DD 형식이어야 합니다.") from exc


def now_kst_text() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")


def positive_float(value, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label}은 숫자여야 합니다.") from exc
    if number <= 0:
        raise ValueError(f"{label}은 0보다 커야 합니다.")
    return number


def parse_bool(value, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() not in {"0", "false", "no", "off", "미반영"}


def validate_account_ticker_scope(account, ticker: str, name: str, category: str | None, currency: str) -> None:
    expected = account_scope(account["account_type"])
    actual = ticker_scope(ticker, name, category, currency)
    labels = {
        "overseas": "해외종목",
        "kr_stock": "한국 개별종목",
        "kr_etf": "한국 ETF",
        "crypto": "가상자산",
    }
    if not actual:
        raise ValueError("이 종목은 거래내역 계좌에 추가할 수 없는 유형입니다.")
    if expected and actual != expected:
        account_name = account["name"] or account["account_type"]
        raise ValueError(
            f"{account_name} 계좌에는 {labels.get(expected, expected)}만 추가할 수 있습니다. "
            f"입력한 종목은 {labels.get(actual, actual)}입니다."
        )


def load_transactions(account_id: str | None = None, ticker: str | None = None, account_ids: list[str] | None = None) -> dict:
    params: list[object] = []
    filters = []
    cleaned_account_ids = [int(x) for x in (account_ids or []) if str(x).strip()]
    if cleaned_account_ids:
        placeholders = ",".join("?" for _ in cleaned_account_ids)
        filters.append(f"t.account_id IN ({placeholders})")
        params.extend(cleaned_account_ids)
    elif account_id:
        filters.append("t.account_id = ?")
        params.append(int(account_id))
    if ticker:
        filters.append("upper(t.ticker) = ?")
        params.append(ticker.upper())
    where = "WHERE " + " AND ".join(filters) if filters else ""
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT
                t.id,
                t.trade_date,
                t.created_at,
                t.account_id,
                COALESCE(t.member, a.member, '') AS member,
                a.account_type,
                a.name AS account_name,
                t.ticker,
                COALESCE(h.name, tk.name, t.ticker) AS name,
                t.side,
                t.qty,
            t.price,
            t.currency,
            t.note,
            t.apply_to_holdings
            FROM transactions t
            LEFT JOIN accounts a ON t.account_id = a.id
            LEFT JOIN holdings h ON h.account_id = t.account_id AND h.ticker = t.ticker
            LEFT JOIN tickers tk ON tk.ticker = t.ticker
            {where}
            ORDER BY t.trade_date DESC, t.id DESC
            LIMIT 200
            """,
            params,
        ).fetchall()
    return {"transactions": [dict(row) for row in rows]}


def add_transaction(payload: dict, portfolio_loader: Callable[[], dict] | None = None) -> dict:
    account_id = int(payload.get("account_id") or 0)
    ticker = str(payload.get("ticker") or "").strip().upper()
    side = str(payload.get("side") or "").strip().upper()
    qty = positive_float(payload.get("qty"), "수량")
    price = positive_float(payload.get("price"), "단가")
    trade_date = parse_trade_date(payload.get("trade_date"))
    note = str(payload.get("note") or "").strip()
    apply_to_holdings = parse_bool(payload.get("apply_to_holdings"), True)
    if not account_id:
        raise ValueError("계좌를 선택해야 합니다.")
    if not ticker:
        raise ValueError("티커를 입력해야 합니다.")
    if side not in {"BUY", "SELL"}:
        raise ValueError("거래 유형은 BUY 또는 SELL이어야 합니다.")

    with connect() as conn:
        account = load_account(conn, account_id)
        if not account:
            raise ValueError("존재하지 않는 계좌입니다.")

        holding = load_holding(conn, account_id, ticker)
        ticker_info = load_ticker_info(conn, ticker)
        existing_name = holding["name"] if holding else None
        ticker_name = ticker_info["name"] if ticker_info else None
        ticker_info_currency = ticker_info["currency"] if ticker_info else None
        ticker_category = ticker_info["category"] if ticker_info else None
        name = str(payload.get("name") or existing_name or ticker_name or ticker).strip()
        currency = str(payload.get("currency") or (holding["currency"] if holding else ticker_info_currency) or ticker_currency(ticker)).strip().upper()
        amount = qty * price
        validate_account_ticker_scope(account, ticker, name, ticker_category, currency)

        if apply_to_holdings:
            if side == "BUY":
                if holding:
                    old_qty = float(holding["qty"] or 0)
                    old_avg = float(holding["avg_price"] or 0)
                    old_invested = float(holding["invested"] if holding["invested"] is not None else old_qty * old_avg)
                    new_qty = old_qty + qty
                    new_invested = old_invested + amount
                    new_avg = new_invested / new_qty
                    conn.execute(
                        """
                        UPDATE holdings
                        SET member = ?, qty = ?, avg_price = ?, invested = ?, name = ?, currency = ?,
                            notes = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (account["member"], new_qty, round(new_avg, 4), round(new_invested, 2), name, currency, note or trade_date, holding["id"]),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO holdings
                          (member, account_id, ticker, name, qty, avg_price, currency, invested, notes)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (account["member"], account_id, ticker, name, qty, round(price, 4), currency, round(amount, 2), note or trade_date),
                    )
            else:
                if not holding:
                    raise ValueError("매도할 보유 종목이 없습니다.")
                old_qty = float(holding["qty"] or 0)
                if qty > old_qty + 0.00000001:
                    raise ValueError(f"매도 수량이 보유 수량({old_qty:g})보다 큽니다.")
                avg_price = float(holding["avg_price"] or 0)
                new_qty = max(0.0, old_qty - qty)
                new_invested = new_qty * avg_price
                conn.execute(
                    """
                    UPDATE holdings
                    SET member = ?, qty = ?, invested = ?, name = ?, currency = ?,
                        notes = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (account["member"], new_qty, round(new_invested, 2), name, currency, note or trade_date, holding["id"]),
                )

        ensure_ticker(conn, ticker, name, currency)
        conn.execute(
            """
            INSERT INTO transactions
              (trade_date, member, account_id, ticker, side, qty, price, currency, note, created_at, apply_to_holdings)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (trade_date, account["member"], account_id, ticker, side, qty, price, currency, note, now_kst_text(), 1 if apply_to_holdings else 0),
        )

    return {
        "ok": True,
        "portfolio": (portfolio_loader or load_portfolio)(),
        "transactions": load_transactions(str(account_id))["transactions"],
    }


def update_transaction(payload: dict) -> dict:
    """거래내역(원장) 레코드만 수정. 보유(holdings)는 거래의 순수 투영이 아니므로
    재계산하지 않는다(과거 거래 일부만 입력되는 설계). 티커·계좌·종목명은 식별자라
    고정하고, 거래일·유형·수량·단가·메모만 수정한다."""
    tx_id = int(payload.get("id") or 0)
    if not tx_id:
        raise ValueError("거래 id가 필요합니다.")
    with connect() as conn:
        row = conn.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,)).fetchone()
        if not row:
            raise ValueError("존재하지 않는 거래입니다.")
        trade_date = parse_trade_date(payload.get("trade_date") or row["trade_date"])
        side = str(payload.get("side") or row["side"]).strip().upper()
        if side not in {"BUY", "SELL"}:
            raise ValueError("거래 유형은 BUY 또는 SELL이어야 합니다.")
        qty = positive_float(payload["qty"], "수량") if payload.get("qty") not in (None, "") else float(row["qty"])
        price = positive_float(payload["price"], "단가") if payload.get("price") not in (None, "") else float(row["price"])
        note = str(payload["note"] if payload.get("note") is not None else (row["note"] or "")).strip()
        conn.execute(
            "UPDATE transactions SET trade_date = ?, side = ?, qty = ?, price = ?, note = ? WHERE id = ?",
            (trade_date, side, qty, price, note, tx_id),
        )
        conn.commit()
    return {"ok": True, "id": tx_id}


def delete_transaction(payload: dict) -> dict:
    """거래내역 물리 삭제(hard delete). 보유는 건드리지 않음."""
    tx_id = int(payload.get("id") or 0)
    if not tx_id:
        raise ValueError("거래 id가 필요합니다.")
    with connect() as conn:
        cursor = conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
        conn.commit()
    if cursor.rowcount == 0:
        raise ValueError("존재하지 않는 거래입니다.")
    return {"ok": True, "id": tx_id}

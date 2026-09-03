"""계좌 현금 입출금(외부 자금 흐름) — 성과 계산의 분모.

입금 +, 출금 −. 통화는 기본적으로 계좌 통화(없으면 KRW)이고 스냅샷이
그날 환율로 KRW 환산한다. 변경이 있으면 해당 계좌 스냅샷을 즉시 다시 만든다.
"""

from __future__ import annotations

from .dates import now_kst_text, parse_iso_date
from .db import connect, ensure_cash_flow_table
from .performance_snapshots import rebuild_account_snapshots


def list_cash_flows(account_id: int | None = None) -> dict:
    with connect() as conn:
        ensure_cash_flow_table(conn)
        where = "WHERE f.account_id = ?" if account_id else ""
        rows = conn.execute(
            f"""
            SELECT f.id, f.account_id, COALESCE(a.member, '') AS member, a.name AS account_name,
                   f.flow_date, f.amount, f.currency, f.note, f.created_at
            FROM account_cash_flows f LEFT JOIN accounts a ON a.id = f.account_id
            {where}
            ORDER BY f.flow_date DESC, f.id DESC
            """,
            (int(account_id),) if account_id else (),
        ).fetchall()
    return {"cash_flows": [dict(r) for r in rows]}


def add_cash_flow(payload: dict) -> dict:
    account_id = int(payload.get("account_id") or 0)
    if not account_id:
        raise ValueError("계좌를 선택해야 합니다.")
    flow_date = parse_iso_date(payload.get("flow_date"))
    if not flow_date:
        raise ValueError("입출금일이 필요합니다(YYYY-MM-DD).")
    try:
        amount = float(payload.get("amount"))
    except (TypeError, ValueError):
        raise ValueError("금액이 필요합니다(입금 +, 출금 −).")
    if amount == 0:
        raise ValueError("금액은 0이 될 수 없습니다.")
    note = str(payload.get("note") or "").strip()
    with connect() as conn:
        ensure_cash_flow_table(conn)
        account = conn.execute("SELECT id, currency FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not account:
            raise ValueError("존재하지 않는 계좌입니다.")
        currency = str(payload.get("currency") or account["currency"] or "KRW").strip().upper()
        cursor = conn.execute(
            """
            INSERT INTO account_cash_flows (account_id, flow_date, amount, currency, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (account_id, flow_date.isoformat(), amount, currency, note, now_kst_text()),
        )
        flow_id = cursor.lastrowid
        conn.commit()
    rebuild_account_snapshots([account_id])
    return {"ok": True, "id": flow_id, **list_cash_flows(account_id)}


def delete_cash_flow(payload: dict) -> dict:
    flow_id = int(payload.get("id") or 0)
    if not flow_id:
        raise ValueError("입출금 id가 필요합니다.")
    with connect() as conn:
        ensure_cash_flow_table(conn)
        row = conn.execute("SELECT account_id FROM account_cash_flows WHERE id = ?", (flow_id,)).fetchone()
        if not row:
            raise ValueError("존재하지 않는 입출금입니다.")
        conn.execute("DELETE FROM account_cash_flows WHERE id = ?", (flow_id,))
        conn.commit()
        account_id = int(row["account_id"])
    rebuild_account_snapshots([account_id])
    return {"ok": True, **list_cash_flows(account_id)}

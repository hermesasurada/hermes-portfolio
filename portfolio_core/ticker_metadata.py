from __future__ import annotations

from .db import connect


MAX_DISPLAY_NAME_LENGTH = 80


def clean_ticker_display_name(value: object) -> str:
    name = " ".join(str(value or "").split())
    if not name:
        raise ValueError("노출명칭을 입력해야 합니다.")
    if len(name) > MAX_DISPLAY_NAME_LENGTH:
        raise ValueError(f"노출명칭은 {MAX_DISPLAY_NAME_LENGTH}자 이하여야 합니다.")
    return name


def update_ticker_display_name(payload: dict) -> dict:
    ticker = str(payload.get("ticker") or "").strip().upper()
    if not ticker:
        raise ValueError("종목코드를 입력해야 합니다.")
    name = clean_ticker_display_name(payload.get("display_name"))

    with connect() as conn:
        row = conn.execute(
            "SELECT ticker FROM tickers WHERE UPPER(ticker) = ?",
            (ticker,),
        ).fetchone()
        if not row:
            raise ValueError("가격수집 대상에 없는 종목입니다.")
        stored_ticker = row["ticker"]
        conn.execute(
            "UPDATE tickers SET display_name = ? WHERE ticker = ?",
            (name, stored_ticker),
        )
        conn.commit()

    return {"ok": True, "ticker": stored_ticker, "name": name}

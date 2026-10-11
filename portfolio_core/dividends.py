"""보유 종목의 배당 지급 목록 — 세후 원화 환산, 배당락일 기준 수량, 목록 범위.

종목별 배당 이력·성장률은 dividend_history.py(2026-10-11 분리).
"""

from __future__ import annotations

from datetime import date, timedelta

from .constants import DIVIDEND_LOOKAHEAD_DAYS
from .dates import positive_float, today_kst
from .db import connect
from .dividend_schedule import consolidated_dividend_events, event_schedule_date
from .prices import fx_rates, latest_prices
from .queries import clean_account_ids, load_holding_rows
from .tickers import ticker_currency

# 공용 헬퍼 위임 (중복 제거)
_today = today_kst
_float_value = positive_float

TAX_FREE_ACCOUNT_TYPES = {"pension_kr", "retirement_kr"}

def _tax_rate(currency: str, account_type: str | None = None) -> float:
    if account_type in TAX_FREE_ACCOUNT_TYPES:
        return 0.0
    if currency == "KRW":
        return 15.4
    if currency == "JPY":
        return 15.315
    return 15.0


# 매달 1~5일에는 전월 배당도 목록에 넣는다(2026-10-01 사용자 지시) — 월초엔 지난달 말 지급분을
# 아직 확인하는 경우가 많다. 화면은 당월 포함 3개월만 펼치므로 전월은 접힌 채로 나온다.
DIVIDEND_PREVIOUS_MONTH_DAYS = 5


def dividend_list_start(today: date) -> date:
    """배당 목록 시작일: 이번 달 1일, 단 1~DIVIDEND_PREVIOUS_MONTH_DAYS일에는 전월 1일."""
    first = today.replace(day=1)
    if today.day <= DIVIDEND_PREVIOUS_MONTH_DAYS:
        return (first - timedelta(days=1)).replace(day=1)
    return first


def entitled_quantity(current_qty: float, trades: list[tuple[str, str, float]], ex_date: str | None) -> float:
    """배당락일 기준 보유 수량 = 지금 수량에서 배당락일 이후 거래를 되돌린 값(2026-10-03 사용자 지시).

    배당은 배당락일 전날 장 마감 보유분이 받는다 — 배당락일 이후에 산 주식은 못 받고, 이후에 판
    주식은 받는다. 결제일(미국 T+1·한국 T+2)은 배당락일 자체에 이미 녹아 있다(미국 배당락=기준일,
    한국은 OpenDART 수집 시 배당락=기준일−1영업일). trades는 (거래일, 'BUY'|'SELL', 수량)이고
    거래일은 원장에 적힌 날짜 그대로 비교한다. 배당락일이 없으면 지금 수량을 쓴다."""
    if not ex_date:
        return current_qty
    adjustment = sum(
        (qty if side == "SELL" else -qty)
        for trade_date, side, qty in trades
        if trade_date >= str(ex_date)[:10]
    )
    return max(0.0, current_qty + adjustment)


def load_dividends(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = clean_account_ids(account_ids)

    start = dividend_list_start(_today())
    end = _today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS)
    raw_start = start - timedelta(days=140)  # 지급일 없는 일본 배당락 이벤트 후보 포함

    with connect() as conn:
        holding_rows = load_holding_rows(conn, cleaned_account_ids)
        # 배당락 이후 거래 — 지급 예정 배당의 수량을 '배당락일 기준 보유'로 되돌리는 데 쓴다.
        # 잔고에 반영된 거래(apply_to_holdings=1)만 본다: 현재 잔고에서 거꾸로 빼고 더하는 계산이라
        # 잔고를 바꾸지 않은 이력 보강분을 섞으면 이중으로 빠진다.
        trade_rows = conn.execute(
            f"""
            SELECT account_id, ticker, trade_date, side, qty
            FROM transactions
            WHERE COALESCE(apply_to_holdings, 1) = 1 AND trade_date >= ?
              {"AND account_id IN (" + ",".join("?" for _ in cleaned_account_ids) + ")" if cleaned_account_ids else ""}
            """,
            [raw_start.isoformat(), *cleaned_account_ids],
        ).fetchall()
    trades_by_holding: dict[tuple[str, str], list[tuple[str, str, float]]] = {}
    for trade in trade_rows:
        trades_by_holding.setdefault((str(trade["account_id"]), str(trade["ticker"])), []).append(
            (str(trade["trade_date"]), str(trade["side"]).upper(), float(trade["qty"] or 0))
        )

    holdings = [
        {
            "account_id": str(row["account_id"]),
            "member": row["member"],
            "account_type": row["account_type"],
            "account_name": row["account_name"],
            "ticker": row["ticker"],
            "name": row["name"] or row["ticker"],
            "qty": float(row["qty"] or 0),
            "currency": row["currency"] or ticker_currency(row["ticker"]),
        }
        for row in holding_rows
        # 지금 0주라도 최근 거래가 있으면 후보 — 배당락 뒤에 전량 팔았어도 그 배당은 받는다.
        if row["ticker"] and (
            float(row["qty"] or 0) > 0 or (str(row["account_id"]), str(row["ticker"])) in trades_by_holding
        )
    ]
    tickers = sorted({row["ticker"] for row in holdings})

    with connect() as conn:
        prices = latest_prices(conn)
        placeholders = ",".join("?" for _ in tickers) if tickers else "''"
        event_rows = conn.execute(
            f"""
            SELECT ticker, ex_date, pay_date, amount, currency, source, fetched_at
            FROM dividend_events
            WHERE ticker IN ({placeholders})
              AND date(COALESCE(pay_date, ex_date)) BETWEEN ? AND ?
            ORDER BY date(COALESCE(pay_date, ex_date)), ticker
            """,
            [*tickers, raw_start.isoformat(), end.isoformat()] if tickers else [raw_start.isoformat(), end.isoformat()],
        ).fetchall()
        history_rows = conn.execute(
            f"""
            SELECT ticker, ex_date, pay_date, amount, currency, source, fetched_at
            FROM dividend_events
            WHERE ticker IN ({placeholders})
              AND amount IS NOT NULL
            ORDER BY ticker, date(COALESCE(pay_date, ex_date))
            """,
            tickers if tickers else [],
        ).fetchall()
        cache_rows = conn.execute(
            f"""
            SELECT ticker, fetched_at, status
            FROM ticker_dividend_cache
            WHERE ticker IN ({placeholders})
            """,
            tickers if tickers else [],
        ).fetchall()
        stats_rows = conn.execute(
            f"""
            SELECT ticker, dividend_yield, dividend_growth_5y
            FROM ticker_stats_cache
            WHERE ticker IN ({placeholders})
            """,
            tickers if tickers else [],
        ).fetchall()

    holdings_by_ticker: dict[str, list[dict]] = {}
    for holding in holdings:
        holdings_by_ticker.setdefault(holding["ticker"], []).append(holding)
    stats_by_ticker = {row["ticker"]: row for row in stats_rows}

    rates = fx_rates(prices)   # FX_TICKERS 기반 전 통화 — 수동 dict는 CNY/TWD 누락 버그가 있었다
    rows = []
    dividend_events = [
        event for event in consolidated_dividend_events(event_rows, history_rows)
        if start <= (event_schedule_date(event) or start) <= end
    ]
    for event in dividend_events:
        stats = stats_by_ticker.get(event["ticker"])
        currency = event["currency"] or ticker_currency(event["ticker"])
        amount = _float_value(event["amount"])
        rate = rates.get(currency, 1.0)
        for holding in holdings_by_ticker.get(event["ticker"], []):
            qty = entitled_quantity(
                holding["qty"],
                trades_by_holding.get((holding["account_id"], holding["ticker"]), []),
                event.get("ex_date"),
            )
            if qty <= 0:
                continue  # 배당락일에 들고 있지 않았다(그 뒤에 샀거나, 그 전에 다 팔았다)
            tax_rate = _tax_rate(currency, holding["account_type"])
            gross = amount * qty if amount is not None else None
            tax = gross * tax_rate / 100 if gross is not None else None
            net = gross - tax if gross is not None and tax is not None else None
            net_krw = net * rate if net is not None else None
            rows.append(
                {
                    "pay_date": event["pay_date"],
                    "ex_date": event["ex_date"],
                    "pay_date_estimated": bool(event.get("pay_date_estimated")),
                    "ex_date_estimated": bool(event.get("ex_date_estimated")),
                    "member": holding["member"],
                    "target": holding["member"],   # 대상은 사람 이름만 (계좌구분 제외)
                    "account_id": holding["account_id"],
                    "ticker": event["ticker"],
                    "currency": currency,
                    "name": holding["name"],
                    "amount": amount,
                    "qty": qty,
                    "holding_qty": holding["qty"],   # 지금 보유 — qty(배당락일 기준)와 다르면 화면이 알려 준다
                    "gross": gross,
                    "tax": tax,
                    "tax_rate": tax_rate,
                    "net": net,
                    "fx_rate": rate if currency != "KRW" else None,
                    "net_krw": net_krw,
                    "dividend_yield": stats["dividend_yield"] if stats else None,
                    "dividend_growth_5y": stats["dividend_growth_5y"] if stats else None,
                    "source": event["source"],
                }
            )
    rows.sort(key=lambda row: (row["pay_date"] or "", row["ex_date"] or "", row["ticker"], row["account_id"]))
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "updated_at": max((row["fetched_at"] for row in cache_rows), default=None),
        "rows": rows,
    }

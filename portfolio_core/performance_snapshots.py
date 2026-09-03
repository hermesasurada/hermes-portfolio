"""계좌별 일별 KRW 평가액 스냅샷 — 성과차트의 데이터 정본.

기준일(accounts.history_start, 없으면 전 계좌 공통 최초 거래일)에서 **현재 잔고 −
기준일 이후 순거래**로 기초 포지션을 역산하고, 이후 거래를 하루씩 재생해
보유수량 × 종가 × 환율(KRW)로 평가한다. 거래 이력이 부분적인 계좌(연금
4계좌)도 이 방식이면 재생이 항상 현재 잔고에 도달한다.

결과는 account_value_snapshots에 저장한다. 조회 때는 읽기만 하고, 다시
만드는 건 거래 입력·수정·삭제, 현금 입출금 변경, 일배치(당일 점 추가)뿐.

거래 수량은 이미 분할 후 기준으로 입력돼 있다(141쌍 대조에서 무환산 104
일치·환산 0 일치). 분할 환산을 적용하지 않는다.

저장 컬럼은 구성요소로 나눈다 — 프런트가 어떤 성과 정의(단순 평가액,
현금 포함, TWR)를 쓰든 조합할 수 있게.
  holdings_value_krw : 그날 보유 증권 평가액
  trade_cash_krw     : 기준일 이후 누적 거래 현금(매도 +, 매수 −)
  flow_krw           : 기준일 이후 누적 외부 입출금(입금 +, 출금 −)
"""

from __future__ import annotations

import sqlite3
from bisect import bisect_right
from collections import defaultdict
from datetime import date

from .dates import now_kst_text, today_kst
from .db import (
    connect,
    ensure_account_history_columns,
    ensure_cash_flow_table,
    ensure_value_snapshot_table,
)

FX_TICKER_FOR = {"USD": "USDKRW", "EUR": "EURKRW", "JPY": "JPYKRW", "GBP": "GBPKRW",
                 "CHF": "CHFKRW", "CAD": "CADKRW", "AUD": "AUDKRW", "SGD": "SGDKRW",
                 "HKD": "HKDKRW", "CNY": "CNYKRW", "TWD": "TWDKRW"}
PRICE_WARMUP_DAYS = 45  # 기준일 직전 종가를 이월할 수 있게 조금 앞부터 읽는다


class _Series:
    """(date, value) 정렬 시계열 — 그날 이하 마지막 값 조회."""

    def __init__(self, rows):
        self.dates = [str(r[0]) for r in rows]
        self.values = [float(r[1]) for r in rows]

    def at(self, day: str) -> float | None:
        index = bisect_right(self.dates, day)
        return self.values[index - 1] if index else None


def account_anchor(conn: sqlite3.Connection, account_id: int) -> str | None:
    """기준일 — 명시값(accounts.history_start)이 있으면 그것, 없으면 **전 계좌 최초 거래일**.

    계좌마다 최초 거래일이 다르면(퇴직연금 2026-08, 해외 2021-10) 합산 차트가
    가장 늦은 계좌부터만 그려진다. 기준일을 앞당겨도 역산은 그대로 성립한다 —
    기준일 이후 거래가 없는 구간은 기초 포지션을 그대로 들고 있던 것으로 평가되며,
    이는 예전 성과차트의 '현재 잔고 고정' 가정과 같다. 그래서 공통 기준일을 쓴다.
    """
    row = conn.execute("SELECT history_start FROM accounts WHERE id = ?", (account_id,)).fetchone()
    explicit = (row["history_start"] or "").strip() if row else ""
    if explicit:
        return explicit
    first = conn.execute("SELECT MIN(trade_date) AS d FROM transactions").fetchone()
    return first["d"] if first and first["d"] else None


def _load_series(conn: sqlite3.Connection, ticker: str, since: str) -> _Series:
    rows = conn.execute(
        """
        SELECT date, close FROM daily_prices
        WHERE ticker = ? AND close IS NOT NULL AND date >= ?
        ORDER BY date
        """,
        (ticker, since),
    ).fetchall()
    return _Series(rows)


def _shift_days(day: str, days: int) -> str:
    from datetime import timedelta

    return (date.fromisoformat(day) - timedelta(days=days)).isoformat()


def build_account_series(conn: sqlite3.Connection, account_id: int) -> list[dict]:
    anchor = account_anchor(conn, account_id)
    if not anchor:
        return []
    today = today_kst().isoformat()
    since = _shift_days(anchor, PRICE_WARMUP_DAYS)

    holdings = {
        str(r["ticker"]).upper(): (float(r["qty"] or 0), str(r["currency"] or "KRW").upper())
        for r in conn.execute("SELECT ticker, qty, currency FROM holdings WHERE account_id = ?", (account_id,))
    }
    trades = conn.execute(
        """
        SELECT trade_date, ticker, side, qty, price, currency FROM transactions
        WHERE account_id = ? AND trade_date >= ? ORDER BY trade_date, id
        """,
        (account_id, anchor),
    ).fetchall()
    flows = conn.execute(
        "SELECT flow_date, amount, currency FROM account_cash_flows WHERE account_id = ? AND flow_date >= ? ORDER BY flow_date, id",
        (account_id, anchor),
    ).fetchall()

    # 기초 포지션 역산: 현재 잔고 − 기준일 이후 순거래
    opening: dict[str, float] = defaultdict(float)
    currency_of: dict[str, str] = {}
    for ticker, (qty, currency) in holdings.items():
        opening[ticker] += qty
        currency_of[ticker] = currency
    for t in trades:
        ticker = str(t["ticker"]).upper()
        signed = float(t["qty"]) * (1 if t["side"] == "BUY" else -1)
        opening[ticker] -= signed
        currency_of.setdefault(ticker, str(t["currency"] or "KRW").upper())

    tickers = sorted(opening)
    prices = {ticker: _load_series(conn, ticker, since) for ticker in tickers}
    fx: dict[str, _Series | None] = {}
    for currency in set(currency_of.values()) | {str(f["currency"] or "KRW").upper() for f in flows}:
        fx[currency] = None if currency == "KRW" else _load_series(conn, FX_TICKER_FOR.get(currency, f"{currency}KRW"), since)

    def to_krw(amount: float, currency: str, day: str) -> float | None:
        series = fx.get(currency)
        if series is None:
            return amount
        rate = series.at(day)
        return None if rate is None else amount * rate

    # 거래 캘린더: 관련 종목 종가 날짜의 합집합(기준일~오늘)
    days = sorted({d for s in prices.values() for d in s.dates if anchor <= d <= today})
    if not days:
        return []

    trades_by_day: dict[str, list] = defaultdict(list)
    for t in trades:
        trades_by_day[str(t["trade_date"])].append(t)
    flows_by_day: dict[str, list] = defaultdict(list)
    for f in flows:
        flows_by_day[str(f["flow_date"])].append(f)

    positions = dict(opening)
    trade_cash = 0.0
    flow_cash = 0.0
    out: list[dict] = []
    pending_days = sorted(set(trades_by_day) | set(flows_by_day))
    pending_index = 0
    for day in days:
        # 거래일이 휴장일(캘린더 밖)이면 그 다음 캘린더 날에 반영
        while pending_index < len(pending_days) and pending_days[pending_index] <= day:
            event_day = pending_days[pending_index]
            for t in trades_by_day.get(event_day, []):
                ticker = str(t["ticker"]).upper()
                signed = float(t["qty"]) * (1 if t["side"] == "BUY" else -1)
                positions[ticker] = positions.get(ticker, 0.0) + signed
                cash = to_krw(float(t["qty"]) * float(t["price"]), str(t["currency"] or "KRW").upper(), event_day)
                if cash is not None:
                    trade_cash += -cash if t["side"] == "BUY" else cash
            for f in flows_by_day.get(event_day, []):
                amount = to_krw(float(f["amount"]), str(f["currency"] or "KRW").upper(), event_day)
                if amount is not None:
                    flow_cash += amount
            pending_index += 1
        value = 0.0
        for ticker, qty in positions.items():
            if abs(qty) < 1e-12:
                continue
            close = prices[ticker].at(day)
            if close is None:
                continue
            krw = to_krw(qty * close, currency_of.get(ticker, "KRW"), day)
            if krw is not None:
                value += krw
        out.append({
            "date": day,
            "holdings_value_krw": round(value, 2),
            "trade_cash_krw": round(trade_cash, 2),
            "flow_krw": round(flow_cash, 2),
        })
    return out


def rebuild_account_snapshots(account_ids: list[int] | None = None) -> dict[int, int]:
    """계좌별 스냅샷을 다시 만든다. {account_id: 행 수}."""
    written: dict[int, int] = {}
    with connect() as conn:
        ensure_account_history_columns(conn)
        ensure_cash_flow_table(conn)
        ensure_value_snapshot_table(conn)
        ids = [int(x) for x in account_ids] if account_ids else [
            int(r["id"]) for r in conn.execute("SELECT id FROM accounts ORDER BY id")
        ]
        stamp = now_kst_text()
        for account_id in ids:
            rows = build_account_series(conn, account_id)
            conn.execute("DELETE FROM account_value_snapshots WHERE account_id = ?", (account_id,))
            conn.executemany(
                """
                INSERT INTO account_value_snapshots
                  (account_id, date, holdings_value_krw, trade_cash_krw, flow_krw, computed_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [(account_id, r["date"], r["holdings_value_krw"], r["trade_cash_krw"], r["flow_krw"], stamp) for r in rows],
            )
            written[account_id] = len(rows)
        conn.commit()
    return written


def load_account_snapshots(
    account_ids: list[int] | None = None,
    start: str | None = None,
    end: str | None = None,
) -> dict:
    with connect() as conn:
        ensure_value_snapshot_table(conn)
        ensure_account_history_columns(conn)
        params: list = []
        where = []
        if account_ids:
            where.append(f"s.account_id IN ({','.join('?' for _ in account_ids)})")
            params.extend(int(x) for x in account_ids)
        if start:
            where.append("s.date >= ?"); params.append(start)
        if end:
            where.append("s.date <= ?"); params.append(end)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        rows = conn.execute(
            f"""
            SELECT s.account_id, s.date, s.holdings_value_krw, s.trade_cash_krw, s.flow_krw, s.computed_at
            FROM account_value_snapshots s {clause}
            ORDER BY s.account_id, s.date
            """,
            params,
        ).fetchall()
        accounts = {
            int(r["id"]): {"id": int(r["id"]), "member": r["member"], "name": r["name"],
                           "history_start": account_anchor(conn, int(r["id"]))}
            for r in conn.execute("SELECT id, member, name FROM accounts")
        }
    series: dict[int, list[dict]] = defaultdict(list)
    computed_at = None
    for r in rows:
        series[int(r["account_id"])].append({
            "date": r["date"],
            "holdings_value_krw": r["holdings_value_krw"],
            "trade_cash_krw": r["trade_cash_krw"],
            "flow_krw": r["flow_krw"],
        })
        computed_at = r["computed_at"] or computed_at
    return {
        "accounts": [
            {**accounts[aid], "points": series.get(aid, [])}
            for aid in sorted(accounts) if not account_ids or aid in {int(x) for x in account_ids}
        ],
        "computed_at": computed_at,
    }


def twr_index(points: list[dict], basis: str) -> list[float]:
    """시간가중 지수(첫 점 1.0). points는 날짜순 {value, trade_cash, flow}(누계).

    basis="securities": 매수·매도를 전부 외부 흐름으로 간주 — 계좌 현금을 모를 때.
        r_t = V_t / (V_{t-1} − ΔC_t) − 1,  ΔC = 그날 매도금 − 매수금 (매수면 분모가 커진다)
    basis="full": 외부 입출금만 흐름으로 — 현금 입출금이 입력된 뒤.
        T_t = V_t + (flow_t + trade_cash_t)   ← 기준일 현금은 0으로 두므로
              기준일 보유 현금은 기준일자 입금으로 넣는다는 규약
        r_t = T_t / (T_{t-1} + ΔF_t) − 1,  ΔF = 그날 외부 입출금

    흐름은 **장 시작 시점**에 들어온 것으로 본다(분모). 장 마감 관례(분자에서 차감)는
    기존 자본이 작을 때 큰 매수가 들어오면 그날 산 주식의 장중 등락이 작은 기존 자본
    대비 수익률로 잡혀 폭발한다(신규 계좌 1년 +1120% 실측). 분모가 0 이하면 그날은 0%.
    """
    out: list[float] = []
    growth = 1.0
    previous = None
    for point in points:
        value = float(point.get("value") or 0.0)
        trade_cash = float(point.get("trade_cash") or 0.0)
        flow = float(point.get("flow") or 0.0)
        total = value + flow + trade_cash if basis == "full" else value
        if previous is not None:
            prev_total, prev_trade, prev_flow = previous
            if basis == "full":
                denominator = prev_total + (flow - prev_flow)
                numerator = total
            else:
                denominator = prev_total - (trade_cash - prev_trade)
                numerator = value
            if denominator > 0 and prev_total > 0:
                growth *= numerator / denominator
        out.append(growth)
        previous = (total, trade_cash, flow)
    return out

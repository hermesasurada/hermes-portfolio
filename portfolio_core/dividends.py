from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any

from .constants import DIVIDEND_LOOKAHEAD_DAYS, DIVIDEND_LOOKBACK_DAYS, FX_DEFAULT_RATES, KOREAN_SUFFIXES
from .dates import positive_float, today_kst
from .db import connect, ensure_dividend_tables
from .dividend_refresh import refresh_dividend_events
from .dividend_schedule import consolidated_dividend_events, event_schedule_date
from .prices import latest_prices
from .queries import clean_account_ids, load_holding_rows
from .tickers import account_label, ticker_currency

DIVIDEND_HISTORY_START_YEAR = 2010

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


def _annual_growth(current: float, previous: float | None) -> float | None:
    if previous is None or previous <= 0:
        return None
    return (current / previous - 1) * 100


def _annual_cagr(
    totals: dict[int, float],
    complete_years: set[int],
    end_year: int,
    years: int,
) -> float | None:
    start_value = totals.get(end_year - years)
    end_value = totals.get(end_year)
    if (
        start_value is None
        or end_value is None
        or start_value <= 0
        or end_value <= 0
        or any(year not in complete_years for year in range(end_year - years, end_year + 1))
    ):
        return None
    return ((end_value / start_value) ** (1 / years) - 1) * 100


def _history_date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _entitlement_date(event: Any) -> date | None:
    return (
        _history_date(event["record_date"])
        or _history_date(event["ex_date"])
        or _history_date(event["pay_date"])
    )


def _fiscal_year_end_month(conn, ticker: str) -> int | None:
    """캐시된 yfinance info의 lastFiscalYearEnd에서 회계연도 종료 '월'을 읽는다.
    12월(역년) 결산이면 None을 돌려 일반 anchor 방식으로 처리하게 한다."""
    try:
        row = conn.execute(
            "SELECT raw_json FROM ticker_stats_cache WHERE ticker = ?", (ticker,)
        ).fetchone()
    except Exception:
        return None
    if not row or not row["raw_json"]:
        return None
    try:
        info = json.loads(row["raw_json"]).get("info", {}) or {}
        ts = info.get("lastFiscalYearEnd") or info.get("nextFiscalYearEnd")
        if not ts:
            return None
        month = datetime.fromtimestamp(int(ts), tz=timezone.utc).month
    except (TypeError, ValueError, OSError):
        return None
    return None if month == 12 else month


def _dividend_attribution(
    event: Any,
    ticker: str,
    anchor_month: int | None = None,
    fiscal_end_month: int | None = None,
) -> tuple[date | None, int | None, bool]:
    entitlement_date = _entitlement_date(event)
    if entitlement_date is None:
        return None, None, False

    declaration_date = _history_date(event["declaration_date"])
    is_korean = ticker.upper().endswith(KOREAN_SUFFIXES)
    if is_korean:
        is_final = entitlement_date.month == 12
        attributed_year = entitlement_date.year
        # 결산배당 기준일을 다음 해로 옮긴 한국 기업: 연초 이사회 결의 + 1~3월
        # 기준일이면 직전 사업연도 결산배당으로 귀속한다.
        if (
            entitlement_date.month <= 3
            and declaration_date is not None
            and declaration_date.year == entitlement_date.year
            and declaration_date.month <= 2
        ):
            attributed_year -= 1
            is_final = True
        return entitlement_date, attributed_year, is_final

    # 비역년 회계연도(예: 디어·브로드컴 11월 결산) → 회계연도 기준 귀속.
    # 기준일 월이 결산월 이하면 그 해 회계연도, 초과하면 다음 회계연도.
    # 결산배당(연중 마지막 회차) 표식은 그룹 확정 후 별도로 단다.
    if fiscal_end_month:
        attributed_year = (
            entitlement_date.year
            if entitlement_date.month <= fiscal_end_month
            else entitlement_date.year + 1
        )
        return entitlement_date, attributed_year, False

    # 그 외 해외주식: '최초 배당월(anchor)' 기준 1년 주기로 귀속한다.
    # 예) 구글은 6월 시작 → 6/9/12월 + 익년 3월이 같은 결산년도.
    # anchor_month가 1월이거나 분기월이 anchor 이후만 있으면 기존 역년 귀속과 동일.
    attributed_year = entitlement_date.year
    if anchor_month and entitlement_date.month < anchor_month:
        attributed_year -= 1
    return entitlement_date, attributed_year, False


def _dividend_frequency(events: list[dict], completed_counts: dict[int, int], current_year: int) -> int:
    recent_dates = sorted(event["date"] for event in events if event["year"] >= current_year - 3)
    intervals = [
        (right - left).days
        for left, right in zip(recent_dates, recent_dates[1:])
        if 14 <= (right - left).days <= 400
    ]
    interval_hint = None
    if intervals:
        typical_days = median(intervals)
        interval_hint = 12 if typical_days <= 45 else 4 if typical_days <= 120 else 2 if typical_days <= 220 else 1

    recent_counts = [
        count
        for year, count in completed_counts.items()
        if current_year - 3 <= year < current_year and count > 0
    ]
    count_hint = max(recent_counts, default=0)
    count_hint = 12 if count_hint >= 8 else 4 if count_hint >= 3 else 2 if count_hint == 2 else 1 if count_hint else None
    return max(interval_hint or 1, count_hint or 1)


def _frequency_label(frequency: int) -> str:
    return {12: "월배당", 4: "분기배당", 2: "반기배당", 1: "연배당"}.get(frequency, "비정기")


def _same_period_reference(events: list[dict], current: dict) -> dict | None:
    candidates = [
        event
        for event in events
        if event["date"] < current["date"] and 250 <= (current["date"] - event["date"]).days <= 470
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda event: abs((current["date"] - event["date"]).days - 365))


def _current_year_estimate(events: list[dict], frequency: int, current_year: int) -> float | None:
    current_events = [event for event in events if event["year"] == current_year]
    if not current_events:
        return None
    actual = sum(event["amount"] for event in current_events)
    missing = max(0, frequency - len(current_events))
    if missing == 0:
        return actual

    latest = current_events[-1]
    reference = _same_period_reference(events, latest)
    previous_events = [event for event in events if event["year"] == current_year - 1]
    if reference and len(previous_events) >= frequency and reference in previous_events:
        ratio = latest["amount"] / reference["amount"] if reference["amount"] > 0 else 1.0
        reference_index = previous_events.index(reference)
        remaining = previous_events[reference_index + 1:reference_index + 1 + missing]
        if len(remaining) == missing:
            return actual + sum(event["amount"] * ratio for event in remaining)
    return actual + missing * latest["amount"]


def load_dividend_history(ticker: str) -> dict:
    clean_ticker = str(ticker or "").strip().upper()
    if not clean_ticker:
        raise ValueError("ticker is required")

    today = _today()
    with connect() as conn:
        ensure_dividend_tables(conn)
        ticker_row = conn.execute(
            "SELECT ticker, name, currency FROM tickers WHERE UPPER(ticker) = ?",
            (clean_ticker,),
        ).fetchone()
        if not ticker_row:
            raise ValueError("unknown ticker")
        event_rows = conn.execute(
            """
            SELECT ex_date, record_date, pay_date, declaration_date, amount, currency, source
            FROM dividend_events
            WHERE ticker = ?
              AND amount IS NOT NULL
              AND amount > 0
              AND date(COALESCE(record_date, ex_date, pay_date)) >= ?
              AND date(COALESCE(record_date, ex_date, pay_date)) <= ?
            ORDER BY date(COALESCE(record_date, ex_date, pay_date))
            """,
            (ticker_row["ticker"], f"{DIVIDEND_HISTORY_START_YEAR}-01-01", today.isoformat()),
        ).fetchall()
        is_korean = ticker_row["ticker"].upper().endswith(KOREAN_SUFFIXES)
        # 비역년 회계연도면 회계연도 기준 귀속(디어 11월 등), 아니면 최초 배당월 anchor.
        fiscal_end_month = None if is_korean else _fiscal_year_end_month(conn, ticker_row["ticker"])

    # 해외 역년결산/신규배당 종목의 anchor — 가장 이른 배당 회차의 월
    anchor_month = None
    if not is_korean and not fiscal_end_month:
        for event in event_rows:
            first_date = _entitlement_date(event)
            if first_date is not None:
                anchor_month = first_date.month
                break

    events = []
    final_dividend_count = 0
    for event in event_rows:
        entitlement_date, attributed_year, is_final = _dividend_attribution(
            event, ticker_row["ticker"], anchor_month, fiscal_end_month
        )
        if entitlement_date is None or attributed_year is None:
            continue
        final_dividend_count += int(is_final)
        events.append(
            {
                "date": entitlement_date,
                "year": attributed_year,
                "amount": float(event["amount"]),
                "source": event["source"],
                "declaration_date": _history_date(event["declaration_date"]),
                "ex_date": _history_date(event["ex_date"]),
                "pay_date": _history_date(event["pay_date"]),
                "is_final": is_final,
            }
        )

    annual: dict[int, dict] = {}
    for event in events:
        year_row = annual.setdefault(
            event["year"],
            {"amount": 0.0, "payments": 0, "last_date": event["date"], "sources": set(), "final": False, "events": []},
        )
        year_row["amount"] += event["amount"]
        year_row["payments"] += 1
        year_row["last_date"] = max(year_row["last_date"], event["date"])
        year_row["final"] = year_row["final"] or event["is_final"]
        year_row["events"].append(event)
        if event["source"]:
            year_row["sources"].add(event["source"])

    totals = {year: row["amount"] for year, row in annual.items()}
    payment_counts = {year: row["payments"] for year, row in annual.items()}
    frequency = _dividend_frequency(events, payment_counts, today.year)
    complete_years = {
        year for year, count in payment_counts.items()
        if year < today.year and count >= frequency
    }
    # 비역년 회계연도 종목: 완결된 회계연도의 마지막 회차를 '결산배당'으로 표시
    if fiscal_end_month:
        for year in complete_years:
            group = annual.get(year)
            if not group or not group["events"]:
                continue
            final_event = max(group["events"], key=lambda item: item["date"])
            if not final_event["is_final"]:
                final_event["is_final"] = True
                final_dividend_count += 1
                group["final"] = True
    current_estimate = _current_year_estimate(events, frequency, today.year)
    rows = []
    for year in sorted(annual, reverse=True):
        row = annual[year]
        previous_complete = year - 1 in complete_years
        complete = year in complete_years
        current_ytd = year == today.year
        estimated_amount = current_estimate if current_ytd else None
        growth_pct = (
            None
            if not complete or not previous_complete
            else _annual_growth(row["amount"], totals.get(year - 1))
        )
        growth_basis = "annual" if growth_pct is not None else None
        # 연간배당이 완결되지 않은 해외주식: 직전연도 대비 '해당연도 최초 배당금'으로 성장률 산출
        if growth_pct is None and not is_korean:
            previous = annual.get(year - 1)
            if previous and previous["events"] and row["events"]:
                first_growth = _annual_growth(
                    row["events"][0]["amount"], previous["events"][0]["amount"]
                )
                if first_growth is not None:
                    growth_pct = first_growth
                    growth_basis = "first_payment"
        rows.append(
            {
                "year": year,
                "amount": row["amount"],
                "growth_pct": growth_pct,
                "growth_basis": growth_basis,
                "payments": row["payments"],
                "expected_payments": frequency,
                "complete": complete,
                "estimated_amount": estimated_amount,
                "last_date": row["last_date"].isoformat(),
                "current_ytd": current_ytd,
                "final_dividend": row["final"],
                "sources": sorted(row["sources"]),
                "payments_detail": [
                    {
                        "entitlement_date": event["date"].isoformat(),
                        "ex_date": event["ex_date"].isoformat() if event["ex_date"] else None,
                        "pay_date": event["pay_date"].isoformat() if event["pay_date"] else None,
                        "amount": event["amount"],
                        "source": event["source"],
                        "is_final": event["is_final"],
                    }
                    for event in sorted(row["events"], key=lambda item: item["date"], reverse=True)
                ],
            }
        )

    completed_years = sorted(complete_years)
    latest_completed = completed_years[-1] if completed_years else None
    latest_growth = (
        _annual_growth(totals[latest_completed], totals.get(latest_completed - 1))
        if latest_completed is not None and latest_completed - 1 in complete_years
        else None
    )
    cagr_3y = _annual_cagr(totals, complete_years, latest_completed, 3) if latest_completed is not None else None
    cagr_5y = _annual_cagr(totals, complete_years, latest_completed, 5) if latest_completed is not None else None

    last_raise_pct = None
    last_raise_date = None
    for index, current in enumerate(events):
        reference = _same_period_reference(events, current)
        previous = events[index - 1] if index > 0 else None
        if (
            reference
            and previous
            and current["amount"] > reference["amount"]
            and reference["amount"] > 0
            and abs(current["amount"] - previous["amount"]) > 1e-12
        ):
            last_raise_pct = _annual_growth(current["amount"], reference["amount"])
            last_raise_date = (current["declaration_date"] or current["date"]).isoformat()
    latest_completed_total = totals.get(latest_completed) if latest_completed is not None else None
    annualized_run_rate = current_estimate if current_estimate is not None else latest_completed_total
    return {
        "ticker": ticker_row["ticker"],
        "name": ticker_row["name"] or ticker_row["ticker"],
        "currency": ticker_row["currency"] or ticker_currency(ticker_row["ticker"]),
        "start_year": DIVIDEND_HISTORY_START_YEAR,
        "rows": rows,
        "summary": {
            "latest_completed_year": latest_completed,
            "latest_growth_pct": latest_growth,
            "cagr_3y": cagr_3y,
            "cagr_5y": cagr_5y,
            "frequency": frequency,
            "frequency_label": _frequency_label(frequency),
            "annualized_run_rate": annualized_run_rate,
            "last_raise_pct": last_raise_pct,
            "last_raise_date": last_raise_date,
            "final_dividend_adjusted": final_dividend_count > 0,
        },
    }


def load_dividends(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = clean_account_ids(account_ids)

    start = _today().replace(day=1)   # 이번 달 1일부터
    end = _today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS)

    with connect() as conn:
        ensure_dividend_tables(conn)
        holding_rows = load_holding_rows(conn, cleaned_account_ids, positive_only=True)

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
        if row["ticker"] and float(row["qty"] or 0) > 0
    ]
    tickers = sorted({row["ticker"] for row in holdings})

    with connect() as conn:
        ensure_dividend_tables(conn)
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
            [*tickers, start.isoformat(), end.isoformat()] if tickers else [start.isoformat(), end.isoformat()],
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

    holdings_by_ticker: dict[str, list[dict]] = {}
    for holding in holdings:
        holdings_by_ticker.setdefault(holding["ticker"], []).append(holding)

    rates = {
        "KRW": 1.0,
        "USD": float(prices.get("USDKRW", {}).get("price") or FX_DEFAULT_RATES["USD"]),
        "EUR": float(prices.get("EURKRW", {}).get("price") or FX_DEFAULT_RATES["EUR"]),
        "JPY": float(prices.get("JPYKRW", {}).get("price") or FX_DEFAULT_RATES["JPY"]),
    }
    rows = []
    dividend_events = [
        event for event in consolidated_dividend_events(event_rows, history_rows)
        if start <= (event_schedule_date(event) or start) <= end
    ]
    for event in dividend_events:
        currency = event["currency"] or ticker_currency(event["ticker"])
        amount = _float_value(event["amount"])
        rate = rates.get(currency, 1.0)
        for holding in holdings_by_ticker.get(event["ticker"], []):
            tax_rate = _tax_rate(currency, holding["account_type"])
            qty = holding["qty"]
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
                    "target": f"{holding['member']} {account_label(holding['member'], holding['account_type'], holding['account_name'])}",
                    "account_id": holding["account_id"],
                    "ticker": event["ticker"],
                    "currency": currency,
                    "name": holding["name"],
                    "amount": amount,
                    "qty": qty,
                    "gross": gross,
                    "tax": tax,
                    "tax_rate": tax_rate,
                    "net": net,
                    "fx_rate": rate if currency != "KRW" else None,
                    "net_krw": net_krw,
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

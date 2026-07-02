from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from statistics import median
from typing import Any

from .constants import DIVIDEND_LOOKAHEAD_DAYS, KOREAN_SUFFIXES
from .dates import parse_iso_date, positive_float, today_kst
from .db import connect, ensure_dividend_tables, ensure_stock_split_tables
from .dividend_refresh import dividend_history_start, refresh_dividend_events
from .dividend_schedule import consolidated_dividend_events, event_schedule_date
from .prices import fx_rates, latest_prices
from .queries import clean_account_ids, load_holding_rows
from .tickers import ticker_currency

# 공용 헬퍼 위임 (중복 제거)
_today = today_kst
_float_value = positive_float


TAX_FREE_ACCOUNT_TYPES = {"pension_kr", "retirement_kr"}
FISCAL_END_MONTH_OVERRIDES = {
    "NVDA": 3,
}
PAY_DATE_YEAR_TICKERS = {"DIS"}
UNADJUSTED_DIVIDEND_SOURCES = {"polygon", "nasdaq", "opendart", "seibro"}


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


# 공용 헬퍼 위임 (동일 기능 로컬 복제 제거)
_history_date = parse_iso_date


def _entitlement_date(event: Any) -> date | None:
    return (
        _history_date(event["record_date"])
        or _history_date(event["ex_date"])
        or _history_date(event["pay_date"])
    )


def _most_recent_raise_month(adjusted_events: list[dict]) -> int | None:
    """분할조정 금액 시계열에서 '가장 최근의 지속된 인상' 회차의 월.
    배당년도는 인상 시점에 시작하므로(같은 금액 N분기가 한 묶음) 이 월이 anchor.
    일회성 특별배당(직후 회차가 다시 내려감)은 제외, 2% 미만 변동은 반올림 노이즈로 무시."""
    raise_month = None
    for i in range(1, len(adjusted_events)):
        prev = adjusted_events[i - 1]["amount"]
        cur = adjusted_events[i]["amount"]
        if prev > 0 and cur > prev * 1.02:
            nxt = adjusted_events[i + 1]["amount"] if i + 1 < len(adjusted_events) else cur
            if nxt >= cur * 0.98:
                raise_month = adjusted_events[i]["date"].month
    return raise_month


def _dividend_fiscal_end_month(ticker: str, adjusted_events: list[dict]) -> int | None:
    """배당 결산년도 종료월 — 인상월(=배당년도 시작) 직전 달.
    예) 애플 5월 인상→4월, 디어 12월 인상→11월, 구글 6월 인상→5월.
    NVDA 등 오버라이드 우선, 인상이 감지되지 않으면 None(최초배당월 anchor 폴백)."""
    override = FISCAL_END_MONTH_OVERRIDES.get(str(ticker or "").upper())
    if override:
        return override
    raise_month = _most_recent_raise_month(adjusted_events)
    if raise_month is None:
        return None
    return (raise_month - 2) % 12 + 1   # 인상월 직전 달 (1월 인상 → 12월)


def _active_dividend_year(today: date, fiscal_end_month: int | None) -> int:
    if fiscal_end_month and today.month > fiscal_end_month:
        return today.year + 1
    return today.year


def _split_adjusted_amount(
    amount: float,
    event_date: date,
    source: str | None,
    splits: list[dict],
) -> tuple[float, float]:
    if str(source or "").lower() not in UNADJUSTED_DIVIDEND_SOURCES:
        return amount, 1.0
    factor = 1.0
    for split in splits:
        split_date = _history_date(split["split_date"])
        ratio = _float_value(split["ratio"])
        if split_date and split_date > event_date and ratio:
            factor *= ratio
    return (amount / factor, factor) if abs(factor - 1.0) > 1e-12 else (amount, 1.0)


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
    pay_date = _history_date(event["pay_date"])
    if ticker.upper() in PAY_DATE_YEAR_TICKERS and pay_date is not None:
        return entitlement_date, pay_date.year, False

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


def _attributed_history_events(
    event_rows: list,
    ticker: str,
    is_korean: bool,
    fiscal_end_month: int | None,
    splits: list[dict] | None = None,
) -> tuple[list[dict], int]:
    """DB 행 → 귀속연도가 매겨진 이벤트 목록 + 결산배당 횟수."""
    # 해외 역년결산/신규배당 종목의 anchor — 가장 이른 배당 회차의 월
    anchor_month = None
    if not is_korean and not fiscal_end_month:
        for event in event_rows:
            first_date = _entitlement_date(event)
            if first_date is not None:
                anchor_month = first_date.month
                break

    events = []
    splits = splits or []
    final_dividend_count = 0
    for event in event_rows:
        entitlement_date, attributed_year, is_final = _dividend_attribution(
            event, ticker, anchor_month, fiscal_end_month
        )
        if entitlement_date is None or attributed_year is None:
            continue
        raw_amount = float(event["amount"])
        amount, split_factor = _split_adjusted_amount(
            raw_amount, entitlement_date, event["source"], splits
        )
        final_dividend_count += int(is_final)
        events.append(
            {
                "date": entitlement_date,
                "year": attributed_year,
                "amount": amount,
                "raw_amount": raw_amount,
                "split_factor": split_factor,
                "source": event["source"],
                "declaration_date": _history_date(event["declaration_date"]),
                "ex_date": _history_date(event["ex_date"]),
                "pay_date": _history_date(event["pay_date"]),
                "is_final": is_final,
            }
        )

    # 결산년도 키(회계연도/인상주기)로 묶은 한 묶음을, 그 안에서 지급 회차가
    # 가장 많은 역년으로 재라벨한다. 묶음은 그대로 유지되므로 같은 금액 N분기는
    # 한 그룹으로 남고, 라벨만 직관적인 역년이 된다(애플 2025, 구글 2024 …).
    # 동률이면 더 늦은 해. 한국·오버라이드(예: NVDA)는 기존 라벨 유지.
    relabel = (
        not is_korean
        and str(ticker or "").upper() not in FISCAL_END_MONTH_OVERRIDES
        and str(ticker or "").upper() not in PAY_DATE_YEAR_TICKERS
    )
    if relabel and events:
        cycles: dict[int, list[dict]] = {}
        for event in events:
            cycles.setdefault(event["year"], []).append(event)
        for cycle_events in cycles.values():
            year_counts = Counter(event["date"].year for event in cycle_events)
            majority_year = max(year_counts, key=lambda year: (year_counts[year], year))
            for event in cycle_events:
                event["year"] = majority_year

    return events, final_dividend_count


def _aggregate_annual_dividends(events: list[dict]) -> dict[int, dict]:
    """귀속연도별 합계·회차·최근기준일·소스 집계."""
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
    return annual


def _mark_fiscal_finals(annual: dict[int, dict], complete_years: set[int]) -> int:
    """비역년 회계연도 종목: 완결 회계연도의 마지막 회차를 '결산배당'으로 표시.
    새로 표시한 개수를 돌려준다."""
    marked = 0
    for year in complete_years:
        group = annual.get(year)
        if not group or not group["events"]:
            continue
        final_event = max(group["events"], key=lambda item: item["date"])
        if not final_event["is_final"]:
            final_event["is_final"] = True
            group["final"] = True
            marked += 1
    return marked


def _year_growth(
    year: int, annual: dict[int, dict], totals: dict[int, float],
    complete_years: set[int], is_korean: bool,
) -> tuple[float | None, str | None]:
    """연간 성장률 — 완결연도끼리는 연간합계, 미완결 해외주식은 '해당 연도
    최초 배당금' 기준(first_payment)으로 폴백."""
    if year in complete_years and year - 1 in complete_years:
        growth = _annual_growth(annual[year]["amount"], totals.get(year - 1))
        if growth is not None:
            return growth, "annual"
    if not is_korean:
        previous = annual.get(year - 1)
        current = annual.get(year)
        if previous and previous["events"] and current and current["events"]:
            growth = _annual_growth(
                current["events"][0]["amount"], previous["events"][0]["amount"]
            )
            if growth is not None:
                return growth, "first_payment"
    return None, None


def _history_year_rows(
    annual: dict[int, dict], totals: dict[int, float], complete_years: set[int],
    frequency: int, current_estimate: float | None, current_year: int, is_korean: bool,
) -> list[dict]:
    """연도별 응답 행 직렬화 (최신 연도부터)."""
    rows = []
    for year in sorted(annual, reverse=True):
        row = annual[year]
        current_ytd = year == current_year
        growth_pct, growth_basis = _year_growth(year, annual, totals, complete_years, is_korean)
        rows.append(
            {
                "year": year,
                "amount": row["amount"],
                "growth_pct": growth_pct,
                "growth_basis": growth_basis,
                "payments": row["payments"],
                "expected_payments": frequency,
                "complete": year in complete_years,
                "estimated_amount": current_estimate if current_ytd else None,
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
                        "raw_amount": event["raw_amount"],
                        "split_factor": event["split_factor"],
                        "split_adjusted": event["split_factor"] != 1.0,
                        "source": event["source"],
                        "is_final": event["is_final"],
                    }
                    for event in sorted(row["events"], key=lambda item: item["date"], reverse=True)
                ],
            }
        )
    return rows


def _last_raise(events: list[dict]) -> tuple[float | None, str | None]:
    """가장 최근 '인상' 회차 — 전년 동기 대비 증가했고 직전 회차와 금액이 달라진 것."""
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
    return last_raise_pct, last_raise_date


def _history_summary(
    events: list[dict], totals: dict[int, float], complete_years: set[int],
    frequency: int, current_estimate: float | None, final_dividend_count: int,
) -> dict:
    completed_years = sorted(complete_years)
    latest_completed = completed_years[-1] if completed_years else None
    latest_growth = (
        _annual_growth(totals[latest_completed], totals.get(latest_completed - 1))
        if latest_completed is not None and latest_completed - 1 in complete_years
        else None
    )
    cagr_3y = _annual_cagr(totals, complete_years, latest_completed, 3) if latest_completed is not None else None
    cagr_5y = _annual_cagr(totals, complete_years, latest_completed, 5) if latest_completed is not None else None
    last_raise_pct, last_raise_date = _last_raise(events)
    latest_completed_total = totals.get(latest_completed) if latest_completed is not None else None
    return {
        "latest_completed_year": latest_completed,
        "latest_growth_pct": latest_growth,
        "cagr_3y": cagr_3y,
        "cagr_5y": cagr_5y,
        "frequency": frequency,
        "frequency_label": _frequency_label(frequency),
        "annualized_run_rate": current_estimate if current_estimate is not None else latest_completed_total,
        "last_raise_pct": last_raise_pct,
        "last_raise_date": last_raise_date,
        "final_dividend_adjusted": final_dividend_count > 0,
    }


def load_dividend_history(ticker: str) -> dict:
    """배당이력 팝업 응답 — 조회 → 귀속 → 연간집계 → 파생지표 → 직렬화."""
    clean_ticker = str(ticker or "").strip().upper()
    if not clean_ticker:
        raise ValueError("ticker is required")

    today = _today()
    history_start = dividend_history_start()
    with connect() as conn:
        ensure_dividend_tables(conn)
        ensure_stock_split_tables(conn)
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
            (ticker_row["ticker"], history_start.isoformat(), today.isoformat()),
        ).fetchall()
        split_rows = [
            dict(row) for row in conn.execute(
                """
                SELECT split_date, ratio, source
                FROM stock_splits
                WHERE ticker = ?
                ORDER BY split_date
                """,
                (ticker_row["ticker"],),
            ).fetchall()
        ]
        is_korean = ticker_row["ticker"].upper().endswith(KOREAN_SUFFIXES)
        # 배당년도 종료월을 '최근 인상월 직전'으로 도출 → 같은 금액 N분기가 한 묶음.
        # 인상 감지엔 분할조정 금액이 필요하므로 먼저 (기준일, 조정금액) 시계열을 만든다.
        adjusted_events = []
        for event in event_rows:
            event_date = _entitlement_date(event)
            if event_date is None:
                continue
            amount, _factor = _split_adjusted_amount(
                float(event["amount"]), event_date, event["source"], split_rows
            )
            adjusted_events.append({"date": event_date, "amount": amount})
        adjusted_events.sort(key=lambda item: item["date"])
        pay_date_year_ticker = ticker_row["ticker"].upper() in PAY_DATE_YEAR_TICKERS
        fiscal_end_month = None if is_korean or pay_date_year_ticker else _dividend_fiscal_end_month(
            ticker_row["ticker"], adjusted_events
        )

    events, final_dividend_count = _attributed_history_events(
        event_rows, ticker_row["ticker"], is_korean, fiscal_end_month, split_rows
    )
    annual = _aggregate_annual_dividends(events)

    # 재라벨(한국·오버라이드 제외) 종목은 역년 기준이므로 active_year=올해.
    # NVDA 등 오버라이드는 회계연도 기준 그대로.
    is_override = ticker_row["ticker"].upper() in FISCAL_END_MONTH_OVERRIDES
    active_year = (
        _active_dividend_year(today, fiscal_end_month)
        if is_korean or is_override
        else today.year
    )
    totals = {year: row["amount"] for year, row in annual.items()}
    payment_counts = {year: row["payments"] for year, row in annual.items()}
    frequency = _dividend_frequency(events, payment_counts, active_year)
    complete_years = {
        year for year, count in payment_counts.items()
        if year < active_year and count >= frequency
    }
    if fiscal_end_month:
        final_dividend_count += _mark_fiscal_finals(annual, complete_years)
    current_estimate = _current_year_estimate(events, frequency, active_year)

    return {
        "ticker": ticker_row["ticker"],
        "name": ticker_row["name"] or ticker_row["ticker"],
        "currency": ticker_row["currency"] or ticker_currency(ticker_row["ticker"]),
        "start_year": history_start.year,
        "rows": _history_year_rows(
            annual, totals, complete_years, frequency, current_estimate, active_year, is_korean
        ),
        "summary": _history_summary(
            events, totals, complete_years, frequency, current_estimate, final_dividend_count
        ),
    }


def load_dividends(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = clean_account_ids(account_ids)

    start = _today().replace(day=1)   # 이번 달 1일부터
    end = _today() + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS)
    raw_start = start - timedelta(days=140)  # 지급일 없는 일본 배당락 이벤트 후보 포함

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

    holdings_by_ticker: dict[str, list[dict]] = {}
    for holding in holdings:
        holdings_by_ticker.setdefault(holding["ticker"], []).append(holding)

    rates = fx_rates(prices)   # FX_TICKERS 기반 전 통화 — 수동 dict는 CNY/TWD 누락 버그가 있었다
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
                    "target": holding["member"],   # 대상은 사람 이름만 (계좌구분 제외)
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

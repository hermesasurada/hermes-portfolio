"""분기배당 기업의 배당 증액 표시 — 배당 탭 주당배당금 강조(2026-10-28 사용자 지시).

- confirmed: 공시(수집)된 배당이 직전 정기 회차보다 늘었고 작년 같은 분기보다도 많다 → 빨강 굵게.
  작년 비교는 한국식 '소액 분기 + 대액 기말'에서 기말 회차가 매년 증액으로 잡히는 것을 막는다.
- expected: 아직 공시 전인 다음 회차(추정 행)인데 작년 같은 분기에 증액했고, 그 뒤로 증액이
  없었다(연 1회 인상 주기) → 주황 굵게. 금액은 최근 배당을 그대로 쓴 추정이라 실제는 더 클 수 있다.

비교는 분할보정·특별배당 제외·중복 병합을 거친 정기 회차 시계열로 한다(배당이력 팝업과 같은 규칙).
대상은 분기배당(최근 400일 3회 이상 + 회차 간격 중앙값 60~120일) 개별 기업만 — ETF·레버리지 상품
분배금은 매 회차 들쭉날쭉해 증액 개념이 맞지 않는다. 한국 기업의 자사주 소각에 따른 주당배당 미세
증가(삼성전자 370→372원)는 1% 문턱으로, 현지 통화 배당을 달러로 환산해 매번 금액이 달라지는
ADR(TSM·ASML)은 5% 문턱으로 거른다.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from statistics import median
from typing import Any

from .constants import KOREAN_SUFFIXES
from .corporate_actions import (
    dedupe_dividend_event_rows,
    entitlement_date,
    split_adjusted_amount,
)
from .dates import parse_iso_date, positive_float
from .dividend_history import (
    DIVIDEND_FREQUENCY_OVERRIDES,
    _dividend_components,
    _distribution_type_override,
    _mark_special_dividends,
    _same_dividend_cycle_amount,
    _same_period_reference,
)
from .entry_reward import is_leveraged_product
from .tickers import asset_class

RAISE_TOLERANCE = 0.01           # 1% 이하 변동은 반올림·자사주 소각 노이즈
FX_RAISE_TOLERANCE = 0.05        # 환산 금액(ADR)은 환율만으로 몇 % 움직인다
MATCH_WINDOW_DAYS = 10           # 목록 행 ↔ 이력 회차 매칭 허용 오차
EXPECTED_MIN_GAP_DAYS = 300      # 최근 증액 뒤 이 기간 안이면 '증액 예정'으로 보지 않는다
ACTIVE_PAYER_DAYS = 200          # 마지막 정기 회차가 이보다 오래면 배당 중단으로 본다
# 브랜드 목록에 없는 펀드(일본 NEXT FUNDS 'Exchange Traded Fd' 등)를 영문 정식 명칭으로 거른다
FUND_NAME_PATTERN = re.compile(r"\b(ETF|ETN|ETP|Fund|Fd)\b", re.IGNORECASE)


def is_dividend_raise_candidate(ticker: str, names: list[str | None]) -> bool:
    """증액 표시 대상 = 개별 기업. 이름 후보(정식명·표시명) 어느 쪽이든 펀드로 보이면 제외."""
    for name in names:
        if not name:
            continue
        if asset_class(ticker, name) != "stock" or is_leveraged_product(name) or FUND_NAME_PATTERN.search(name):
            return False
    return True


def regular_dividend_series(ticker: str, event_rows: list, split_rows: list[dict]) -> list[dict]:
    """정기 배당 회차 시계열 [{date, ex_date, amount, raw_amount}] — 분할보정, 특별·자본이득 분배 제외."""
    events = []
    for event in dedupe_dividend_event_rows(event_rows, split_rows):
        event_date = entitlement_date(event)
        if event_date is None or positive_float(event["amount"]) is None:
            continue
        if _distribution_type_override(ticker, event) == "capital_gain":
            continue
        for component_amount, special_override in _dividend_components(
            ticker, event_date, float(event["amount"])
        ):
            amount, _factor = split_adjusted_amount(component_amount, event_date, event["source"], split_rows)
            events.append({
                "date": event_date,
                "ex_date": parse_iso_date(event["ex_date"]),
                "amount": amount,
                "raw_amount": component_amount,
                "is_final": False,
                "special_override": special_override,
            })
    events.sort(key=lambda item: item["date"])
    if str(ticker or "").upper().endswith(KOREAN_SUFFIXES):
        # 한국은 '분기 + 기말' 관례라 특별배당 자동 판정을 타지 않는다(배당이력과 같은 규칙)
        for event in events:
            event["is_special"] = event.get("special_override") is True
    else:
        _mark_special_dividends(events)
    return [event for event in events if not event["is_special"]]


def is_quarterly_payer(ticker: str, series: list[dict], today: date) -> bool:
    override = DIVIDEND_FREQUENCY_OVERRIDES.get(str(ticker or "").upper())
    if override:
        return override == 4
    if sum(1 for event in series if event["date"] >= today - timedelta(days=400)) < 3:
        return False
    recent = [event["date"] for event in series if event["date"] >= today - timedelta(days=3 * 365)]
    intervals = [(right - left).days for left, right in zip(recent, recent[1:]) if (right - left).days >= 14]
    return len(intervals) >= 3 and 60 <= median(intervals) <= 120


def fx_converted_amounts(series: list[dict]) -> bool:
    """최근 4회가 모두 센트 미만 자릿수를 가진 서로 다른 금액이면 환산 배당(ADR)으로 본다.
    0.2625달러처럼 원래 센트 미만인 정기배당은 회차마다 같은 금액이라 걸리지 않는다."""
    recent = [event["raw_amount"] for event in series[-4:]]
    return (
        len(recent) == 4
        and len({round(value, 6) for value in recent}) == 4
        and all(abs(value - round(value, 2)) > 1e-6 for value in recent)
    )


def _pct(current: float, base: float) -> float:
    return (current / base - 1) * 100


def raise_info(series: list[dict], index: int, tolerance: float = RAISE_TOLERANCE) -> dict | None:
    """series[index]가 증액 회차면 {pct(직전 대비), yoy_pct(작년 같은 분기 대비), previous_date, year_ago_date}."""
    if index <= 0 or index >= len(series):
        return None
    current = series[index]["amount"]
    previous = series[index - 1]
    if (
        previous["amount"] <= 0
        or _same_dividend_cycle_amount(current, previous["amount"])
        or current <= previous["amount"] * (1 + tolerance)
    ):
        return None
    year_ago = _same_period_reference(series[:index], series[index])
    if year_ago and current <= year_ago["amount"] * (1 + tolerance):
        return None
    return {
        "pct": _pct(current, previous["amount"]),
        "yoy_pct": _pct(current, year_ago["amount"]) if year_ago and year_ago["amount"] > 0 else None,
        "previous_date": previous["date"].isoformat(),
        "year_ago_date": year_ago["date"].isoformat() if year_ago else None,
    }


def _event_key_date(event: dict) -> date | None:
    return parse_iso_date(event.get("ex_date")) or parse_iso_date(event.get("pay_date"))


def _matching_index(series: list[dict], target: date) -> int | None:
    best = None
    for index, item in enumerate(series):
        gap = min(
            abs((item["date"] - target).days),
            abs((item["ex_date"] - target).days) if item["ex_date"] else 10**6,
        )
        if gap <= MATCH_WINDOW_DAYS and (best is None or gap < best[0]):
            best = (gap, index)
    return best[1] if best else None


def _is_estimated(event: dict) -> bool:
    source = str(event.get("source") or "")
    return source.startswith("estimated-history") or "+history" in source


def annotate_raise_markers(
    events: list[dict], series_by_ticker: dict[str, list[dict]], today: date, eligible: set[str],
) -> None:
    """배당 목록 이벤트에 raise_marker를 단다(제자리 수정). eligible은 개별 기업 티커.
    confirmed: {kind, pct, yoy_pct, previous_date, year_ago_date}
    expected:  {kind, pct(작년 증액률), raised_date(작년 증액 회차)}"""
    by_ticker: dict[str, list[dict]] = {}
    for event in events:
        by_ticker.setdefault(event["ticker"], []).append(event)
    for ticker, ticker_events in by_ticker.items():
        series = series_by_ticker.get(ticker) or []
        if ticker not in eligible or not series or not is_quarterly_payer(ticker, series, today):
            continue
        tolerance = FX_RAISE_TOLERANCE if fx_converted_amounts(series) else RAISE_TOLERANCE
        ticker_events.sort(key=lambda item: _event_key_date(item) or date.max)
        for event in ticker_events:
            key_date = _event_key_date(event)
            if key_date is None or _is_estimated(event):
                continue
            index = _matching_index(series, key_date)
            info = raise_info(series, index, tolerance) if index is not None else None
            if info:
                event["raise_marker"] = {"kind": "confirmed", **info}
        if (today - series[-1]["date"]).days > ACTIVE_PAYER_DAYS:
            continue
        upcoming = next(
            (event for event in ticker_events
             if _is_estimated(event) and (_event_key_date(event) or date.min) > series[-1]["date"]),
            None,
        )
        if upcoming is None:
            continue
        target = _event_key_date(upcoming)
        year_ago = _same_period_reference(series, {"date": target})
        if year_ago is None:
            continue
        year_ago_index = series.index(year_ago)
        info = raise_info(series, year_ago_index, tolerance)
        if info is None:
            continue
        raised_since = any(
            raise_info(series, index, tolerance) is not None
            for index in range(year_ago_index + 1, len(series))
            if (target - series[index]["date"]).days < EXPECTED_MIN_GAP_DAYS
        )
        if raised_since:
            continue
        upcoming["raise_marker"] = {"kind": "expected", "pct": info["pct"], "raised_date": year_ago["date"].isoformat()}


def load_regular_series(conn: Any, tickers: list[str]) -> tuple[dict[str, list[dict]], set[str]]:
    """(티커별 정기 회차 시계열, 증액 표시 대상 티커)."""
    if not tickers:
        return {}, set()
    placeholders = ",".join("?" for _ in tickers)
    rows = conn.execute(
        f"""
        SELECT ticker, ex_date, record_date, pay_date, declaration_date, amount, currency, source
        FROM dividend_events
        WHERE ticker IN ({placeholders}) AND amount IS NOT NULL AND amount > 0
        ORDER BY ticker, date(COALESCE(record_date, ex_date, pay_date))
        """,
        tickers,
    ).fetchall()
    split_rows = conn.execute(
        f"SELECT ticker, split_date, ratio, source FROM stock_splits WHERE ticker IN ({placeholders}) ORDER BY split_date",
        tickers,
    ).fetchall()
    name_rows = conn.execute(
        f"SELECT ticker, name, display_name FROM tickers WHERE ticker IN ({placeholders})",
        tickers,
    ).fetchall()
    rows_by_ticker: dict[str, list] = {}
    for row in rows:
        rows_by_ticker.setdefault(row["ticker"], []).append(row)
    splits_by_ticker: dict[str, list[dict]] = {}
    for row in split_rows:
        splits_by_ticker.setdefault(row["ticker"], []).append(dict(row))
    eligible = {
        row["ticker"] for row in name_rows
        if is_dividend_raise_candidate(row["ticker"], [row["name"], row["display_name"]])
    }
    series = {
        ticker: regular_dividend_series(ticker, ticker_rows, splits_by_ticker.get(ticker, []))
        for ticker, ticker_rows in rows_by_ticker.items()
        if ticker in eligible
    }
    return series, eligible

#!/usr/bin/env python3
"""Pure-function tests for portfolio_core.

Runs with plain `python3 tests/test_portfolio_core.py` (no pytest required) and is
also discoverable by pytest. Covers the deterministic, network-free helpers — the
layer where the original parse_number regression slipped through unnoticed.
"""

from __future__ import annotations

import sys
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import portfolio_core.fundamentals as fundamentals_module
import portfolio_core.dividend_refresh as dividend_refresh_module
import portfolio_core.schedule as schedule_module
from portfolio_core.collect_common import parse_categories
from portfolio_core.fundamentals import fetch_fundamentals, normalize_pe, parse_number
from portfolio_core.dates import parse_iso_date, to_iso_text
from portfolio_core.dividends import (
    _active_dividend_year,
    _aggregate_annual_dividends,
    _attributed_history_events,
    _estimated_annual_cagr,
    _history_summary,
    _history_year_rows,
    _mark_fiscal_finals,
    _split_adjusted_amount,
    _tax_rate,
)
from portfolio_core.dividend_schedule import consolidated_dividend_events
from portfolio_core.indicators import (
    performance_pct,
    price_near_target,
    recent_performance,
    resample_last,
    shift_months,
)
from portfolio_core.market_calendar import us_equity_calendar_day
from portfolio_core.price_store import infer_category
from portfolio_core.prices import fx_previous_rates, fx_rates
from portfolio_core.us_live_quotes import (
    apply_us_live_prices,
    extended_change_from_quote,
    extended_quote_pick,
    live_price_from_quote,
    regular_change_from_quote,
)
from portfolio_core.tickers import (
    account_kind,
    account_label,
    account_scope,
    asset_class,
    is_korean_stock_ticker,
    is_us_stock_ticker,
    normalize_yfinance_symbol,
    ticker_currency,
    ticker_scope,
)
from portfolio_core.logos import _is_square_logo, candidate_symbols, logo_stem
from portfolio_core.watchlist import estimate_hydration_minutes, normalize_lookup_ticker


# --- fundamentals.parse_number (the regression that started all this) -------
def test_parse_number():
    assert parse_number("1,234.5") == 1234.5
    assert parse_number("12,345억") == 12345.0
    assert parse_number("-12.5") == -12.5
    assert parse_number(None) is None
    assert parse_number("-") is None
    assert parse_number("") is None
    assert parse_number("abc") is None


def test_normalize_pe():
    assert normalize_pe("12.3") == 12.3
    assert normalize_pe(0) is None
    assert normalize_pe(-5) is None
    assert normalize_pe(float("inf")) is None
    assert normalize_pe(None) is None
    assert normalize_pe("n/a") is None


def test_dividend_growth_uses_current_annual_estimate():
    totals = {2021: 1.0, 2022: 1.1, 2023: 1.2, 2024: 1.3, 2025: 1.4, 2026: 0.5}
    complete_years = {2021, 2022, 2023, 2024, 2025}
    estimate = 2.0
    expected_cagr = ((estimate / totals[2021]) ** (1 / 5) - 1) * 100
    assert abs(_estimated_annual_cagr(totals, complete_years, 2026, estimate, 5) - expected_cagr) < 1e-9

    annual = {
        year: {
            "amount": amount,
            "payments": 4 if year < 2026 else 1,
            "last_date": date(year, 12 if year < 2026 else 3, 1),
            "sources": {"test"},
            "final": False,
            "events": [],
        }
        for year, amount in totals.items()
    }
    current_row = next(
        row for row in _history_year_rows(
            annual, totals, complete_years, 4, estimate, 2026, False
        )
        if row["year"] == 2026
    )
    assert current_row["growth_basis"] == "estimate"
    assert abs(current_row["growth_pct"] - (estimate / totals[2025] - 1) * 100) < 1e-9

    summary = _history_summary([], totals, complete_years, 4, estimate, 2026, 0)
    assert summary["latest_growth_estimated"] is True
    assert summary["cagr_5y_estimated"] is True
    assert abs(summary["cagr_5y"] - expected_cagr) < 1e-9


def test_dividend_growth_ignores_historical_payment_count_changes():
    totals = {2021: 3.954, 2022: 6.634, 2023: 6.452, 2024: 6.713, 2025: 7.372}
    estimate = 10.699
    expected_cagr = ((estimate / totals[2021]) ** (1 / 5) - 1) * 100

    # ASML처럼 반기배당에서 분기배당으로 바뀐 종목은 과거 연도가 현재 주기
    # 기준으로 완결되지 않아도 귀속연도 합계로 CAGR을 계산한다.
    result = _estimated_annual_cagr(totals, {2023, 2024, 2025}, 2026, estimate, 5)
    assert abs(result - expected_cagr) < 1e-9

    missing_year = dict(totals)
    missing_year.pop(2023)
    assert _estimated_annual_cagr(missing_year, set(), 2026, estimate, 5) is None


def test_dividend_network_fetch_runs_outside_db_transaction():
    active_connections = 0
    stored_tickers = []

    class Result:
        def __init__(self, rows=None):
            self.rows = rows or []

        def fetchall(self):
            return self.rows

    class FakeConnection:
        def execute(self, sql, params=()):
            if "SELECT c.ticker" in sql:
                return Result([])
            if "SELECT ticker, name" in sql:
                return Result([{"ticker": "AAPL", "name": "Apple"}])
            if "INSERT INTO ticker_dividend_cache" in sql:
                assert active_connections == 1
                stored_tickers.append(params[0])
            return Result()

        def commit(self):
            return None

    @contextmanager
    def fake_connect():
        nonlocal active_connections
        active_connections += 1
        try:
            yield FakeConnection()
        finally:
            active_connections -= 1

    originals = {
        "connect": dividend_refresh_module.connect,
        "ensure_dividend_tables": dividend_refresh_module.ensure_dividend_tables,
        "_fetch_dividends": dividend_refresh_module._fetch_dividends,
        "normalize_dividend_events": dividend_refresh_module.normalize_dividend_events,
    }
    try:
        dividend_refresh_module.connect = fake_connect
        dividend_refresh_module.ensure_dividend_tables = lambda _conn: None

        def fake_fetch(_ticker, _name):
            assert active_connections == 0
            return [], "test"

        dividend_refresh_module._fetch_dividends = fake_fetch
        dividend_refresh_module.normalize_dividend_events = lambda _ticker, _events: []
        dividend_refresh_module.refresh_dividend_events(["AAPL"])
        assert stored_tickers == ["AAPL"]
    finally:
        for name, value in originals.items():
            setattr(dividend_refresh_module, name, value)


def test_kr_dividend_partial_failure_preserves_existing_history():
    class Result:
        def __init__(self, rows=None):
            self.rows = rows or []

        def fetchall(self):
            return self.rows

    statements: list[str] = []

    class FakeConnection:
        def execute(self, sql, params=()):
            statements.append(" ".join(sql.split()))
            if "SELECT c.ticker" in sql:
                return Result([])
            if "SELECT ticker, name" in sql:
                return Result([{"ticker": "005930.KS", "name": "Samsung Electronics"}])
            return Result()

        def commit(self):
            return None

    @contextmanager
    def fake_connect():
        yield FakeConnection()

    originals = {
        "connect": dividend_refresh_module.connect,
        "ensure_dividend_tables": dividend_refresh_module.ensure_dividend_tables,
        "_fetch_dividends": dividend_refresh_module._fetch_dividends,
        "normalize_dividend_events": dividend_refresh_module.normalize_dividend_events,
        "_kr_dividend_candidate": dividend_refresh_module._kr_dividend_candidate,
    }
    event = {
        "ticker": "005930.KS",
        "ex_date": f"{date.today().year}-06-01",
        "pay_date": f"{date.today().year}-06-20",
        "amount": 100.0,
        "currency": "KRW",
        "source": "opendart",
    }
    try:
        dividend_refresh_module.connect = fake_connect
        dividend_refresh_module.ensure_dividend_tables = lambda _conn: None
        dividend_refresh_module.normalize_dividend_events = lambda _ticker, events: events
        dividend_refresh_module._kr_dividend_candidate = lambda _ticker: True

        dividend_refresh_module._fetch_dividends = lambda _ticker, _name: ([event], "opendart_error(TimeoutError)+kr_history")
        dividend_refresh_module.refresh_dividend_events(["005930.KS"])
        assert not any(sql.startswith("DELETE FROM dividend_events") for sql in statements)
        assert any(sql.startswith("INSERT INTO dividend_events") for sql in statements)

        statements.clear()
        dividend_refresh_module._fetch_dividends = lambda _ticker, _name: ([event], "opendart+kr_history")
        dividend_refresh_module.refresh_dividend_events(["005930.KS"])
        assert any(sql.startswith("DELETE FROM dividend_events") for sql in statements)
    finally:
        for name, value in originals.items():
            setattr(dividend_refresh_module, name, value)


def test_parse_collector_categories():
    assert parse_categories(["overseas,fx", "overseas"]) == ["fx", "overseas"]
    assert parse_categories(["all"]) == ["fx", "crypto", "overseas", "kr", "index"]


def test_read_only_fundamentals_serve_stale_cache():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE tickers (ticker TEXT, name TEXT, display_name TEXT, category TEXT, currency TEXT, next_earnings_date TEXT)"
    )
    conn.execute("INSERT INTO tickers VALUES ('AAPL', 'Apple', NULL, 'overseas', 'USD', NULL)")
    original_loader = fundamentals_module.load_stats_cache_items

    def fake_loader(_conn, _tickers, _now_ts, fresh_only=True):
        if fresh_only:
            return {}
        return {
            "AAPL": {
                "market_cap": 123.0,
                "aum": None,
                "dividend_yield": 0.5,
                "dividend_growth_5y": 7.5,
                "trailing_pe": 20.0,
                "forward_pe": 18.0,
                "price_to_book": 4.0,
                "next_earnings_date": None,
            }
        }

    try:
        fundamentals_module.load_stats_cache_items = fake_loader
        result = fetch_fundamentals(conn, ["AAPL"], refresh_stale=False)
        assert result["AAPL"]["market_cap"] == 123.0
        assert result["AAPL"]["dividend_yield"] == 0.5
        assert result["AAPL"]["dividend_growth_5y"] == 7.5
    finally:
        fundamentals_module.load_stats_cache_items = original_loader
        conn.close()


# --- tickers ----------------------------------------------------------------
def test_ticker_currency():
    assert ticker_currency("BTC") == "KRW"
    assert ticker_currency("005930.KS") == "KRW"
    assert ticker_currency("000660.KQ") == "KRW"
    assert ticker_currency("ASML.PA") == "EUR"
    assert ticker_currency("7203.T") == "JPY"
    assert ticker_currency("AAPL") == "USD"


def test_is_us_stock_ticker():
    assert is_us_stock_ticker("AAPL", "USD") is True
    assert is_us_stock_ticker("AAPL", "KRW") is False
    assert is_us_stock_ticker("USDKRW", "USD") is False
    assert is_us_stock_ticker("005930.KS", "USD") is False  # has a dot
    # market indexes must NOT be live-quoted as US stocks (SP500 -> ^GSPC 404 bug)
    assert is_us_stock_ticker("SP500", "USD") is False
    assert is_us_stock_ticker("NASDAQ", "USD") is False


def test_is_korean_stock_ticker():
    assert is_korean_stock_ticker("005930.KS") is True
    assert is_korean_stock_ticker("000660.KQ") is True
    assert is_korean_stock_ticker("AAPL") is False


def test_normalize_yfinance_symbol():
    assert normalize_yfinance_symbol("BTC") == "BTC-KRW"
    assert normalize_yfinance_symbol("USDKRW") is None
    assert normalize_yfinance_symbol("AAPL") == "AAPL"
    # market indexes map to their Yahoo symbol, not the bare internal ticker
    assert normalize_yfinance_symbol("SP500") == "^GSPC"
    assert normalize_yfinance_symbol("NASDAQ") == "^IXIC"


def test_asset_class():
    assert asset_class("BTC", "Bitcoin") == "crypto"
    assert asset_class("QQQ", "Invesco QQQ") == "etf"
    assert asset_class("ARKG", "ARK Genomic") == "etf"
    assert asset_class("200A.T", "Nikkei Semiconductor") == "etf"
    assert asset_class("069500.KS", "KODEX 200") == "etf"
    assert asset_class("457480.KS", "ACE 테슬라밸류체인액티브") == "etf"
    assert asset_class("SCHD", "") == "etf"          # ticker-only ETF
    assert asset_class("AAPL", "Apple Inc.") == "stock"
    assert asset_class("SPCX", "SpaceX") == "stock"


def test_account_kind_and_label():
    assert account_kind("pension_kr") == "pension"
    assert account_kind("retirement_kr") == "pension"
    assert account_kind("overseas") == "general"
    assert account_label("철수", "overseas", None) == "해외주식계좌"
    assert account_label("철수", "overseas", "내계좌") == "내계좌"  # explicit name wins
    assert account_label("철수", "unknown", None) == "철수 unknown"


# --- price_store.infer_category --------------------------------------------
def test_infer_category():
    assert infer_category("USDKRW") == "fx"
    assert infer_category("BTC") == "crypto"
    assert infer_category("KOSPI") == "index"
    assert infer_category("005930.KS") == "kr"
    assert infer_category("AAPL") == "overseas"
    assert infer_category("WHATEVER", "kr") == "kr"  # explicit category respected


# --- prices.fx_rates --------------------------------------------------------
def test_fx_rates_uses_quotes_then_fallback():
    prices = {"USDKRW": {"price": 1500.0, "previous_price": 1490.0}}
    rates = fx_rates(prices)
    assert rates["USD"] == 1500.0
    assert rates["KRW"] == 1.0
    assert rates["EUR"] == 1700.0  # fallback when no EURKRW quote
    prev = fx_previous_rates(prices)
    assert prev["USD"] == 1490.0
    assert prev["EUR"] == 1700.0


# --- indicators -------------------------------------------------------------
def test_shift_months():
    assert shift_months(date(2026, 3, 31), -1) == date(2026, 2, 28)
    assert shift_months(date(2024, 3, 31), -1) == date(2024, 2, 29)  # leap year
    assert shift_months(date(2026, 1, 15), -1) == date(2025, 12, 15)
    assert shift_months(date(2026, 5, 31), -12) == date(2025, 5, 31)


def test_resample_last_monthly():
    rows = [
        {"date": "2026-01-10", "close": 10.0},
        {"date": "2026-01-20", "close": 11.0},   # later in same month overrides
        {"date": "2026-02-05", "close": 12.0},
    ]
    assert resample_last(rows, "month") == [11.0, 12.0]


def test_performance_pct():
    rows = [
        {"date": "2026-01-01", "close": 100.0},
        {"date": "2026-02-01", "close": 110.0},
    ]
    assert performance_pct(rows, date(2026, 1, 1)) == 10.0
    assert performance_pct([], date(2026, 1, 1)) is None


def test_price_near_target_uses_first_trading_day_for_edge_weekend():
    rows = [
        {"date": "2021-06-01", "close": 100.0},
        {"date": "2026-05-29", "close": 150.0},
    ]
    assert price_near_target(rows, date(2021, 5, 29)) == 100.0
    assert price_near_target(rows, date(2021, 5, 1)) is None


def test_recent_performance_keys():
    keys = set(recent_performance([]).keys())
    assert keys == {
        "one_month", "three_month", "six_month", "ytd",
        "one_year", "three_year", "five_year",
    }




def test_estimated_dividend_uses_latest_amount_not_same_period_amount():
    import portfolio_core.dividend_schedule as schedule

    original_today = schedule.today
    try:
        schedule.today = lambda: date(2026, 6, 2)
        history_rows = [
            {
                "ticker": "NVDA",
                "ex_date": "2025-09-11",
                "pay_date": "2025-10-02",
                "amount": 0.01,
                "currency": "USD",
                "source": "nasdaq",
            },
            {
                "ticker": "NVDA",
                "ex_date": "2026-06-04",
                "pay_date": "2026-06-26",
                "amount": 0.25,
                "currency": "USD",
                "source": "nasdaq",
            },
        ]
        events = consolidated_dividend_events([], history_rows)
        estimate = next(event for event in events if event["ticker"] == "NVDA" and event["pay_date"] == "2026-10-02")
        assert estimate["amount"] == 0.25
    finally:
        schedule.today = original_today


def test_pension_dividend_tax_rate_is_zero():
    assert _tax_rate("KRW", "pension_kr") == 0.0
    assert _tax_rate("USD", "retirement_kr") == 0.0
    assert _tax_rate("KRW", "kr_individual") == 15.4
    assert _tax_rate("USD", "overseas") == 15.0


def test_nvda_march_dividend_closes_fiscal_year():
    rows = []
    for year in (2024, 2025, 2026):
        for month in (6, 9, 12):
            rows.append({
                "record_date": f"{year - 1}-{month:02d}-10",
                "ex_date": None,
                "pay_date": None,
                "declaration_date": None,
                "amount": 0.01,
                "source": "test",
            })
        rows.append({
            "record_date": f"{year}-03-10",
            "ex_date": None,
            "pay_date": None,
            "declaration_date": None,
            "amount": 0.01,
            "source": "test",
        })

    events, _ = _attributed_history_events(rows, "NVDA", False, 3)
    annual = _aggregate_annual_dividends(events)
    complete_years = {2024, 2025, 2026}
    _mark_fiscal_finals(annual, complete_years)

    assert _active_dividend_year(date(2026, 6, 12), 3) == 2027
    for year in complete_years:
        final = next(event for event in annual[year]["events"] if event["is_final"])
        assert final["date"].year == year
        assert final["date"].month == 3


def test_dividend_raise_plateau_uses_start_year_for_us_fiscal_cycle():
    rows = [
        {"record_date": "2023-05-30", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 1.87, "source": "test"},
        {"record_date": "2023-08-28", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 1.87, "source": "test"},
        {"record_date": "2023-11-27", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 1.87, "source": "test"},
        {"record_date": "2024-02-26", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 1.87, "source": "test"},
        {"record_date": "2024-05-28", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 2.06, "source": "test"},
        {"record_date": "2024-09-03", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 2.06, "source": "test"},
        {"record_date": "2024-12-02", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 2.06, "source": "test"},
        {"record_date": "2025-03-03", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 2.06, "source": "test"},
    ]

    events, _ = _attributed_history_events(rows, "NOC", False, 5)
    annual = _aggregate_annual_dividends(events)

    assert annual[2023]["payments"] == 4
    assert round(annual[2023]["amount"], 6) == 7.48
    assert [event["amount"] for event in annual[2023]["events"]] == [1.87, 1.87, 1.87, 1.87]
    assert annual[2024]["payments"] == 4
    assert round(annual[2024]["amount"], 6) == 8.24


def test_quarterly_dividend_cycle_never_groups_more_than_four_payments():
    rows = []
    for record_date, amount in [
        ("2023-03-31", 1.25),
        ("2023-06-30", 1.25),
        ("2023-09-30", 1.35),
        ("2023-12-31", 1.47),
        ("2024-03-31", 1.47),
        ("2024-06-30", 1.47),
        ("2024-09-30", 1.47),
        ("2024-12-31", 1.62),
        ("2025-03-31", 1.62),
        ("2025-06-30", 1.62),
        ("2025-09-30", 1.62),
        ("2025-12-31", 1.62),
        ("2026-03-31", 1.62),
        ("2026-06-30", 1.62),
    ]:
        rows.append({
            "record_date": record_date,
            "ex_date": None,
            "pay_date": None,
            "declaration_date": None,
            "amount": amount,
            "source": "test",
        })

    events, _ = _attributed_history_events(rows, "DE", False, 11)
    annual = _aggregate_annual_dividends(events)

    assert annual[2023]["payments"] == 4
    assert round(annual[2023]["amount"], 6) == 5.32
    assert annual[2024]["payments"] == 4
    assert round(annual[2024]["amount"], 6) == 6.03
    assert annual[2025]["payments"] == 4
    assert round(annual[2025]["amount"], 6) == 6.48
    assert annual[2026]["payments"] == 2
    assert round(annual[2026]["amount"], 6) == 3.24
    assert all(row["payments"] <= 4 for row in annual.values())


def test_special_dividend_excluded_from_annual_totals_and_cycles():
    # COST 패턴: $1.02 분기 사이클 중간의 12월 $15 특별배당.
    rows = []
    for record_date, amount in [
        ("2022-05-12", 0.9),
        ("2022-08-11", 0.9),
        ("2022-11-10", 0.9),
        ("2023-02-09", 0.9),
        ("2023-05-11", 1.02),
        ("2023-08-24", 1.02),
        ("2023-11-02", 1.02),
        ("2023-12-27", 15.0),
        ("2024-02-01", 1.02),
        ("2024-04-25", 1.16),
        ("2024-07-26", 1.16),
        ("2024-11-01", 1.16),
        ("2025-02-07", 1.16),
        ("2025-05-02", 1.3),
    ]:
        rows.append({
            "record_date": record_date,
            "ex_date": None,
            "pay_date": None,
            "declaration_date": None,
            "amount": amount,
            "source": "test",
        })

    events, _ = _attributed_history_events(rows, "COST", False, 4)
    specials = [event for event in events if event["is_special"]]
    assert len(specials) == 1 and specials[0]["amount"] == 15.0
    # 특별배당은 직전 정기 회차의 그룹(2023 사이클)에 표시된다.
    assert specials[0]["year"] == 2023

    annual = _aggregate_annual_dividends(events)
    # 연간 합계·회차에서 제외 — $15가 끊던 사이클도 복원(2024-02가 2023 그룹).
    assert annual[2023]["payments"] == 4
    assert round(annual[2023]["amount"], 6) == 4.08
    assert annual[2024]["payments"] == 4
    assert round(annual[2024]["amount"], 6) == 4.64
    # 상세에는 특별배당 포함(2023 그룹 5건).
    assert len(annual[2023]["events"]) == 5

    # 한국 기말배당(중간의 3배 이상, 매년 반복)은 특별배당이 아니다.
    kr_rows = []
    for record_date, declaration_date, amount in [
        ("2022-06-30", None, 1500.0),
        ("2022-12-31", None, 6000.0),
        ("2023-06-30", None, 1500.0),
        ("2023-12-31", None, 6000.0),
    ]:
        kr_rows.append({
            "record_date": record_date,
            "ex_date": None,
            "pay_date": None,
            "declaration_date": declaration_date,
            "amount": amount,
            "source": "test",
        })
    kr_events, _ = _attributed_history_events(kr_rows, "005380.KS", True, None)
    assert not any(event["is_special"] for event in kr_events)


def test_split_adjusted_half_cent_stays_in_same_dividend_cycle():
    rows = [
        {"record_date": "2023-12-20", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 5.25, "source": "polygon"},
        {"record_date": "2024-03-21", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 5.25, "source": "polygon"},
        {"record_date": "2024-06-24", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 5.25, "source": "polygon"},
        {"record_date": "2024-09-19", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 0.53, "source": "polygon"},
        {"record_date": "2024-12-23", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 0.59, "source": "polygon"},
        {"record_date": "2025-03-20", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 0.59, "source": "polygon"},
        {"record_date": "2025-06-20", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 0.59, "source": "polygon"},
        {"record_date": "2025-09-22", "ex_date": None, "pay_date": None, "declaration_date": None, "amount": 0.59, "source": "polygon"},
    ]
    splits = [{"split_date": "2024-07-15", "ratio": 10.0}]

    events, _ = _attributed_history_events(rows, "AVGO", False, 11, splits)
    annual = _aggregate_annual_dividends(events)

    assert annual[2023]["payments"] == 4
    assert round(annual[2023]["amount"], 6) == 2.105
    assert annual[2024]["payments"] == 4
    assert round(annual[2024]["amount"], 6) == 2.36
    assert all(row["payments"] <= 4 for row in annual.values())


def test_dividend_split_adjustment_is_source_aware():
    splits = [{"split_date": "2024-07-15", "ratio": 10.0}]
    adjusted, factor = _split_adjusted_amount(
        5.25, date(2024, 6, 24), "polygon", splits
    )
    assert adjusted == 0.525
    assert factor == 10.0

    yahoo_amount, yahoo_factor = _split_adjusted_amount(
        0.525, date(2024, 6, 24), "yf-history", splits
    )
    assert yahoo_amount == 0.525
    assert yahoo_factor == 1.0


# --- quote parsing: behaviour-preservation regression -----------------------
def _legacy_live_price(quote_row, include_extended, regular_hours):
    """Original (pre-refactor) live_price_from_quote logic, kept here as oracle."""
    market_state = str(quote_row.get("marketState") or "").upper()
    if include_extended and not regular_hours:
        if market_state == "PRE" and quote_row.get("preMarketPrice"):
            return float(quote_row["preMarketPrice"]), "yf-pre"
        if market_state in {"POST", "POSTPOST"} and quote_row.get("postMarketPrice"):
            return float(quote_row["postMarketPrice"]), "yf-after"
        if quote_row.get("preMarketPrice"):
            return float(quote_row["preMarketPrice"]), "yf-pre"
        if quote_row.get("postMarketPrice"):
            return float(quote_row["postMarketPrice"]), "yf-after"
    if quote_row.get("regularMarketPrice"):
        return float(quote_row["regularMarketPrice"]), "yf-live"
    return None, None


def _quote_matrix():
    states = ["", "PRE", "POST", "POSTPOST", "REGULAR"]
    rows = []
    for state in states:
        for pre in (None, 0, 201.0):
            for post in (None, 0, 202.0):
                for reg in (None, 0, 200.0):
                    rows.append({
                        "marketState": state,
                        "preMarketPrice": pre,
                        "postMarketPrice": post,
                        "regularMarketPrice": reg,
                        "regularMarketPreviousClose": 199.0,
                    })
    return rows


def test_live_price_from_quote_matches_legacy():
    for row in _quote_matrix():
        for include_extended in (False, True):
            for regular_hours in (False, True):
                assert live_price_from_quote(row, include_extended, regular_hours) == \
                    _legacy_live_price(row, include_extended, regular_hours), row


def test_extended_quote_pick_and_change():
    pre = {"marketState": "PRE", "preMarketPrice": 201.0, "regularMarketPrice": 200.0}
    assert extended_quote_pick(pre) == (201.0, "yf-pre")
    change = extended_change_from_quote(pre, regular_hours=False)
    assert change["extended_price"] == 201.0
    assert change["extended_base_price"] == 200.0
    assert round(change["extended_change"], 6) == 1.0
    # during regular hours there is no extended block
    assert extended_change_from_quote(pre, regular_hours=True) == {}
    # nothing to pick
    assert extended_quote_pick({"marketState": "REGULAR"}) == (None, None)


def test_regular_change_from_quote_stays_separate_from_extended():
    row = {
        "marketState": "PRE",
        "regularMarketPrice": 200.0,
        "regularMarketPreviousClose": 199.0,
        "preMarketPrice": 210.0,
    }
    regular = regular_change_from_quote(row)
    extended = extended_change_from_quote(row, regular_hours=False)
    assert round(regular["regular_change_pct"], 6) == round((200.0 - 199.0) / 199.0 * 100, 6)
    assert round(extended["extended_change_pct"], 6) == 5.0


def test_apply_us_live_prices_keeps_regular_change_when_extended_is_applied():
    import portfolio_core.us_live_quotes as price_module

    original_fetch = price_module.fetch_us_live_quotes
    try:
        price_module.fetch_us_live_quotes = lambda symbols, include_extended, regular_hours: {
            "AAPL": {
                "price": 210.0,
                "source": "yf-pre",
                "market_state": "PRE",
                "regular_price": 200.0,
                "regular_previous_price": 199.0,
                "regular_change": 1.0,
                "regular_change_pct": (200.0 - 199.0) / 199.0 * 100,
                "extended_price": 210.0,
                "extended_base_price": 200.0,
                "extended_change": 10.0,
                "extended_change_pct": 5.0,
                "extended_source": "yf-pre",
            }
        }
        prices = {
            "AAPL": {
                "price": 199.0,
                "date": "2026-06-01",
                "source": "db",
                "previous_price": 198.0,
                "previous_date": "2026-05-29",
            }
        }
        rows = [{"ticker": "AAPL", "currency": "USD"}]
        meta = apply_us_live_prices(prices, rows, include_extended=True, market_status={"is_regular": False})
        assert meta["live_count"] == 1
        assert prices["AAPL"]["price"] == 210.0
        assert prices["AAPL"]["regular_change_pct"] != prices["AAPL"]["extended_change_pct"]
        assert round(prices["AAPL"]["regular_change_pct"], 6) == round((200.0 - 199.0) / 199.0 * 100, 6)
        assert prices["AAPL"]["extended_change_pct"] == 5.0
    finally:
        price_module.fetch_us_live_quotes = original_fetch


def test_apply_us_live_prices_skips_live_quotes_when_market_is_closed():
    import portfolio_core.us_live_quotes as price_module

    original_fetch = price_module.fetch_us_live_quotes
    try:
        price_module.fetch_us_live_quotes = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not fetch"))
        prices = {"AAPL": {"price": 199.0, "date": "2026-07-02", "source": "db"}}
        rows = [{"ticker": "AAPL", "currency": "USD"}]
        meta = apply_us_live_prices(
            prices,
            rows,
            include_extended=True,
            market_status={"is_regular": False, "is_closed": True},
        )
        assert meta["use_live"] is False
        assert meta["include_extended"] is False
        assert meta["live_count"] == 0
        assert prices["AAPL"]["price"] == 199.0
    finally:
        price_module.fetch_us_live_quotes = original_fetch


def test_us_market_calendar_observed_independence_day_and_early_close():
    assert us_equity_calendar_day(date(2026, 7, 3))["status"] == "closed"
    thanksgiving_after = us_equity_calendar_day(date(2026, 11, 27))
    assert thanksgiving_after["status"] == "early_close"
    assert thanksgiving_after["early_close_time"] == "13:00"


def test_fetch_us_live_quotes_uses_stale_cache_when_batch_fails():
    import portfolio_core.us_live_quotes as price_module

    original_batch = price_module.yahoo_quote_batch
    original_shared = price_module.load_shared_quote_rows
    original_cache = dict(price_module.US_LIVE_QUOTE_CACHE)
    original_schedule = price_module.schedule_us_live_fallback
    scheduled = []
    stale_item = {
        "price": 123.0,
        "source": "yf-pre",
        "market_state": "PRE",
        "fetched_ts": 1,
        "extended_price": 123.0,
        "extended_base_price": 120.0,
        "extended_change": 3.0,
        "extended_change_pct": 2.5,
    }
    try:
        price_module.US_LIVE_QUOTE_CACHE.clear()
        price_module.US_LIVE_QUOTE_CACHE[("AAPL", "extended")] = stale_item
        price_module.load_shared_quote_rows = lambda symbols: {}
        price_module.yahoo_quote_batch = lambda symbols: (_ for _ in ()).throw(RuntimeError("blocked"))
        price_module.schedule_us_live_fallback = lambda *args: scheduled.append(args)
        result = price_module.fetch_us_live_quotes(["AAPL"], include_extended=True, regular_hours=False)
        assert result["AAPL"] is stale_item
        assert scheduled == [(["AAPL"], "extended", True, False)]
    finally:
        price_module.yahoo_quote_batch = original_batch
        price_module.load_shared_quote_rows = original_shared
        price_module.schedule_us_live_fallback = original_schedule
        price_module.US_LIVE_QUOTE_CACHE.clear()
        price_module.US_LIVE_QUOTE_CACHE.update(original_cache)


# --- scope rules (single source shared by validation + API) -----------------
def test_account_scope():
    assert account_scope("overseas") == "overseas"
    assert account_scope("kr_individual") == "kr_stock"
    assert account_scope("pension_kr") == "kr_etf"
    assert account_scope("retirement_kr") == "kr_etf"
    assert account_scope("bitcoin") == "crypto"
    assert account_scope("unknown") is None


def test_ticker_scope():
    assert ticker_scope("BTC", "Bitcoin", "crypto", "KRW") == "crypto"
    assert ticker_scope("SP500", "S&P 500", "index", "USD") is None
    assert ticker_scope("005930.KS", "삼성전자", "kr", "KRW") == "kr_stock"
    assert ticker_scope("069500.KS", "KODEX 200", "kr", "KRW") == "kr_etf"
    assert ticker_scope("0101N0.KS", "RISE AI전력인프라", "kr", "KRW") == "kr_etf"
    assert ticker_scope("411860.KS", "KIWOOM 독일DAX", "kr", "KRW") == "kr_etf"
    assert ticker_scope("AAPL", "Apple", "overseas", "USD") == "overseas"
    # KRW currency without an explicit category still resolves to a KR scope
    assert ticker_scope("042660.KS", "한화오션", None, "KRW") == "kr_stock"


def test_schedule_excludes_only_korean_etfs():
    assert not schedule_module._include_schedule_ticker("069500.KS", "KODEX 200", "kr", "KRW")
    assert not schedule_module._include_schedule_ticker("0101N0.KS", "RISE AI전력인프라", "kr", "KRW")
    assert schedule_module._include_schedule_ticker("005930.KS", "삼성전자", "kr", "KRW")
    assert schedule_module._include_schedule_ticker("SCHD", "Schwab US Dividend Equity ETF", "overseas", "USD")


# --- watchlist helpers ------------------------------------------------------
def test_estimate_hydration_minutes():
    assert estimate_hydration_minutes(0) == 1
    assert estimate_hydration_minutes(1) == 1
    assert estimate_hydration_minutes(3) == 2   # ceil(1.8)
    assert estimate_hydration_minutes(10) == 6  # ceil(6.0)


def test_normalize_lookup_ticker():
    assert normalize_lookup_ticker("005930") == "005930.KS"  # 6 digits -> KOSPI
    assert normalize_lookup_ticker(" aapl ") == "AAPL"
    assert normalize_lookup_ticker("brk.b") == "BRK.B"
    assert normalize_lookup_ticker("") == ""


# --- logos ------------------------------------------------------------------
def test_logo_stem_and_candidates():
    assert logo_stem("005930.KS") == "005930_KS"
    assert logo_stem("AAPL") == "AAPL"
    assert candidate_symbols("BTC") == ["BTC", "BTCUSD", "BTC-USD"]
    assert candidate_symbols("005930.KS") == ["005930.KS", "005930"]


def test_square_logo_aspect_rejects_tall_and_wide_images():
    def png_header(width: int, height: int) -> bytes:
        return (
            b"\x89PNG\r\n\x1a\n"
            + b"\x00\x00\x00\rIHDR"
            + width.to_bytes(4, "big")
            + height.to_bytes(4, "big")
            + b"\x00" * 420
        )

    assert _is_square_logo(png_header(100, 100), 1.3)
    assert not _is_square_logo(png_header(85, 128), 1.3)
    assert not _is_square_logo(png_header(220, 80), 1.5)


def test_date_helpers():
    assert parse_iso_date("2026-06-08T00:00:00") == date(2026, 6, 8)
    assert parse_iso_date("not-a-date") is None
    assert parse_iso_date(None) is None
    assert to_iso_text(date(2026, 6, 8)) == "2026-06-08"
    assert to_iso_text(datetime(2026, 6, 8, 9, 30)) == "2026-06-08"
    assert to_iso_text("2026-06-08 extra") == "2026-06-08"
    assert to_iso_text(None) is None
    assert to_iso_text("short") is None


# --- runner -----------------------------------------------------------------
def _run() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {fn.__name__}: {exc!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run())

#!/usr/bin/env python3
"""Pure-function tests for portfolio_core.

Runs with plain `python3 tests/test_portfolio_core.py` (no pytest required) and is
also discoverable by pytest. Covers the deterministic, network-free helpers — the
layer where the original parse_number regression slipped through unnoticed.
"""

from __future__ import annotations

import sys
import sqlite3
import urllib.error
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import portfolio_core.fundamentals as fundamentals_module
import portfolio_core.dividend_refresh as dividend_refresh_module
import portfolio_core.dividend_sources as dividend_sources_module
import portfolio_core.dividends as dividends_module
import portfolio_core.schedule as schedule_module
import portfolio_core.ticker_metadata as ticker_metadata_module
import portfolio_core.price_store as price_store_module
from portfolio_core.earnings_history import backfill_earnings_month, collapse_near_earnings_events
import collect_prices as collect_prices_module
from portfolio_core.collect_common import parse_categories
from portfolio_core.collectors import CollectedPrice
from portfolio_core.fundamentals import (
    dividend_yield_from_run_rate,
    fetch_fundamentals,
    normalize_pe,
    parse_number,
    yfinance_dividend_yield,
    yfinance_profile_metrics,
)
from portfolio_core.dates import parse_iso_date, to_iso_text
from portfolio_core.dividends import (
    _active_dividend_year,
    _aggregate_annual_dividends,
    _attributed_history_events,
    _estimated_annual_cagr,
    _history_summary,
    _history_year_rows,
    _mark_fiscal_finals,
    _monthly_annual_estimate,
    _rolling_monthly_growth,
    _split_adjusted_amount,
    _tax_rate,
)
from portfolio_core.dividend_schedule import consolidated_dividend_events
from portfolio_core.indicators import (
    bollinger_pband,
    performance_pct,
    price_near_target,
    recent_performance,
    resample_last,
    rsi_series,
    shift_months,
)
from portfolio_core.market_calendar import (
    change_session_note,
    holiday_change_session_note,
    japan_equity_calendar_day,
    us_equity_calendar_day,
)
from portfolio_core.paths import KST
from portfolio_core.price_store import infer_category
from portfolio_core.prices import fx_previous_rates, fx_rates, price_view
from portfolio_core.queries import dividend_status_total_failure
from portfolio_core.technical_stats import (
    calculate_price_adjusted_indicators,
    price_adjusted_rows,
)
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
from portfolio_core.logos import (
    _is_letter_placeholder,
    _is_square_logo,
    candidate_symbols,
    logo_stem,
)
from portfolio_core.watchlist import estimate_hydration_minutes, normalize_lookup_ticker


def test_earnings_dates_are_preserved_when_next_date_changes():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE tickers (
            ticker TEXT PRIMARY KEY,
            next_earnings_date TEXT,
            earnings_updated_at TEXT,
            display_name TEXT,
            sector TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO tickers (ticker, next_earnings_date, earnings_updated_at) VALUES (?, ?, ?)",
        ("AAPL", "2026-07-30", "2026-07-01T00:00:00+09:00"),
    )

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = price_store_module.connect
    try:
        price_store_module.connect = fake_connect
        price_store_module.update_earnings_dates([("AAPL", "2026-10-29")])
        rows = conn.execute(
            "SELECT earnings_date FROM earnings_events WHERE ticker = 'AAPL' ORDER BY earnings_date"
        ).fetchall()
        assert [row["earnings_date"] for row in rows] == ["2026-07-30", "2026-10-29"]
        current = conn.execute(
            "SELECT next_earnings_date FROM tickers WHERE ticker = 'AAPL'"
        ).fetchone()
        assert current["next_earnings_date"] == "2026-10-29"
    finally:
        price_store_module.connect = original_connect
        conn.close()


def test_earnings_history_backfill_prefers_cache_and_avoids_near_duplicates(tmp_path=None):
    import json
    import tempfile

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE tickers (
            ticker TEXT PRIMARY KEY,
            category TEXT,
            next_earnings_date TEXT,
            earnings_updated_at TEXT,
            display_name TEXT,
            sector TEXT
        )
        """
    )
    conn.executemany(
        "INSERT INTO tickers (ticker, category, next_earnings_date) VALUES (?, 'overseas', ?)",
        [("AAPL", "2026-07-30"), ("MSFT", "2026-10-29"), ("GOOG", "2026-10-23")],
    )
    conn.execute(
        """
        CREATE TABLE ticker_stats_cache (
            ticker TEXT PRIMARY KEY,
            raw_json TEXT,
            fetched_at TEXT
        )
        """
    )
    conn.executemany(
        "INSERT INTO ticker_stats_cache VALUES (?, ?, ?)",
        [
            (
                "AAPL",
                json.dumps({"info": {"earningsTimestamp": 1785355200, "exchangeTimezoneName": "America/New_York"}}),
                "2026-07-31T10:00:00+09:00",
            ),
            (
                "MSFT",
                json.dumps({"info": {"earningsTimestamp": 1785355200, "exchangeTimezoneName": "America/New_York"}}),
                "2026-07-31T10:00:00+09:00",
            ),
        ],
    )

    with tempfile.TemporaryDirectory() as directory:
        log_path = Path(directory) / "collector.log"
        log_path.write_text(
            "\n".join(
                [
                    "[2026-07-22 10:00:00 KST] exit=0",
                    "  + GOOG earnings: 2026-07-23",
                    "[2026-07-23 10:00:00 KST] exit=0",
                    "  + GOOG earnings: 2026-07-24",
                    "  + MSFT earnings: 2026-07-30",
                ]
            ),
            encoding="utf-8",
        )
        result = backfill_earnings_month(conn, "2026-07", [log_path])

    rows = conn.execute(
        "SELECT ticker, earnings_date, source FROM earnings_events ORDER BY ticker, earnings_date"
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("AAPL", "2026-07-30", "ticker-cache"),
        ("GOOG", "2026-07-24", "collector-log"),
        ("GOOG", "2026-10-23", "ticker-cache"),
        ("MSFT", "2026-07-29", "yfinance-info-cache"),
        ("MSFT", "2026-10-29", "ticker-cache"),
    ]
    assert result["inserted"] == 2
    assert result["inserted_collector_log"] == 1
    assert result["inserted_yfinance_cache"] == 1
    assert result["skipped_duplicate"] == 1
    conn.close()


def test_collapse_near_earnings_events_keeps_preferred_date():
    events = [
        {"ticker": "AVGO", "earnings_date": "2026-09-03", "source": "collector", "observed_at": "2026-08-04"},
        {"ticker": "AVGO", "earnings_date": "2026-09-04", "source": "ticker-cache", "observed_at": "2026-08-01"},
        {"ticker": "AVGO", "earnings_date": "2026-06-03", "source": "yfinance-info-cache", "observed_at": "2026-07-31"},
        {"ticker": "PL", "earnings_date": "2026-09-04", "source": "collector", "observed_at": "2026-08-08"},
        {"ticker": "PL", "earnings_date": "2026-09-10", "source": "ticker-cache", "observed_at": "2026-08-01"},
    ]
    collapsed = collapse_near_earnings_events(
        events,
        {"AVGO": "2026-09-03", "PL": "2026-09-04"},
    )
    assert [(row["ticker"], row["earnings_date"]) for row in collapsed] == [
        ("AVGO", "2026-06-03"),
        ("AVGO", "2026-09-03"),
        ("PL", "2026-09-04"),
    ]


def test_update_earnings_dates_replaces_nearby_estimate():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE tickers (
            ticker TEXT PRIMARY KEY,
            next_earnings_date TEXT,
            earnings_updated_at TEXT,
            display_name TEXT,
            sector TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO tickers (ticker, next_earnings_date, earnings_updated_at) VALUES (?, ?, ?)",
        ("AVGO", "2026-09-04", "2026-08-01T00:00:00+09:00"),
    )

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = price_store_module.connect
    try:
        price_store_module.connect = fake_connect
        price_store_module.update_earnings_dates([("AVGO", "2026-09-03")])
        rows = conn.execute(
            "SELECT earnings_date FROM earnings_events WHERE ticker = 'AVGO' ORDER BY earnings_date"
        ).fetchall()
        assert [row["earnings_date"] for row in rows] == ["2026-09-03"]
    finally:
        price_store_module.connect = original_connect
        conn.close()


def test_transaction_hidden_flag_persists_and_is_returned():
    import portfolio_core.transactions as transactions_module

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE accounts (
            id INTEGER PRIMARY KEY,
            member TEXT,
            account_type TEXT,
            name TEXT
        );
        CREATE TABLE holdings (
            account_id INTEGER,
            ticker TEXT,
            name TEXT
        );
        CREATE TABLE tickers (
            ticker TEXT PRIMARY KEY,
            name TEXT
        );
        CREATE TABLE transactions (
            id INTEGER PRIMARY KEY,
            trade_date TEXT,
            created_at TEXT,
            account_id INTEGER,
            member TEXT,
            ticker TEXT,
            side TEXT,
            qty REAL,
            price REAL,
            currency TEXT,
            note TEXT,
            apply_to_holdings INTEGER DEFAULT 1
        );
        INSERT INTO accounts VALUES (1, '나', 'overseas', '증권');
        INSERT INTO transactions (
            id, trade_date, created_at, account_id, member, ticker, side, qty, price, currency, note
        ) VALUES (1, '2026-08-01', '2026-08-01', 1, '나', 'AVGO', 'BUY', 1, 100, 'USD', '');
        """
    )

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = transactions_module.connect
    try:
        transactions_module.connect = fake_connect
        transactions_module.update_transaction({"id": 1, "hidden": 1})
        rows = transactions_module.load_transactions(account_ids=["1"])["transactions"]
        assert len(rows) == 1
        assert int(rows[0]["hidden"]) == 1
        transactions_module.update_transaction({"id": 1, "hidden": 0})
        rows = transactions_module.load_transactions(account_ids=["1"])["transactions"]
        assert int(rows[0]["hidden"]) == 0
    finally:
        transactions_module.connect = original_connect
        conn.close()


# --- fundamentals.parse_number (the regression that started all this) -------
def test_parse_number():
    assert parse_number("1,234.5") == 1234.5
    assert parse_number("12,345억") == 12345.0
    assert parse_number("-12.5") == -12.5
    assert parse_number(None) is None
    assert parse_number("-") is None
    assert parse_number("") is None
    assert parse_number("abc") is None


def test_daily_price_collection_batches_yahoo_targets():
    originals = {
        "load_watch": collect_prices_module.load_watch,
        "fetch_yahoo_prices_batch": collect_prices_module.fetch_yahoo_prices_batch,
        "fetch_price": collect_prices_module.fetch_price,
    }
    individual_calls = []
    try:
        collect_prices_module.load_watch = lambda **_kwargs: {
            "overseas": ["AAPL"],
            "kr": ["005930.KS"],
            "index": ["SP500", "KOSPI"],
        }

        def fake_batch(targets):
            assert {target[0] for target in targets} == {"AAPL", "SP500"}
            return [
                CollectedPrice("AAPL", 200.0, "USD", "yf-batch", "2026-07-28", [("2026-07-28", 200.0)]),
                CollectedPrice("SP500", 6000.0, "USD", "yf-batch", "2026-07-28", [("2026-07-28", 6000.0)]),
            ], []

        def fake_individual(category, ticker, history_start=None):
            individual_calls.append((category, ticker, history_start))
            return CollectedPrice(ticker, 1.0, "KRW", "fdr", "2026-07-28", [("2026-07-28", 1.0)])

        collect_prices_module.fetch_yahoo_prices_batch = fake_batch
        collect_prices_module.fetch_price = fake_individual
        fetched, errors = collect_prices_module.collect_prices(
            ["overseas", "kr", "index"], None, None
        )
        assert errors == []
        assert {item.ticker for item in fetched} == {"AAPL", "005930.KS", "SP500", "KOSPI"}
        assert individual_calls == [
            ("kr", "005930.KS", None),
            ("index", "KOSPI", None),
        ]
    finally:
        for name, value in originals.items():
            setattr(collect_prices_module, name, value)


def test_dividend_yield_from_run_rate():
    assert round(dividend_yield_from_run_rate(3320, 82200), 4) == 4.0389
    assert dividend_yield_from_run_rate(None, 82200) is None
    assert dividend_yield_from_run_rate(3320, 0) is None


def test_dividend_status_alerts_only_when_every_source_failed():
    assert dividend_status_total_failure(
        "yahoo_error(TimeoutError)+stockanalysis_error(HTTPError)+nasdaq_error(HTTPError)"
    )
    assert not dividend_status_total_failure(
        "yahoo0+stockanalysis_error(HTTPError)+nasdaq0+polygon0"
    )
    assert not dividend_status_total_failure("yahoo+nasdaq_error(HTTPError)")
    assert not dividend_status_total_failure(None)


def test_stockanalysis_404_is_an_empty_dividend_result():
    original = dividend_sources_module._fetch_text

    def not_found(url, _headers):
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

    dividend_sources_module._fetch_text = not_found
    try:
        assert dividend_sources_module._fetch_stockanalysis_dividends("AAOI") == []
    finally:
        dividend_sources_module._fetch_text = original


def test_dividend_history_includes_source_backed_future_payment():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tickers (ticker TEXT PRIMARY KEY, name TEXT, currency TEXT)")
    conn.execute(
        """
        CREATE TABLE dividend_events (
            ticker TEXT,
            ex_date TEXT,
            record_date TEXT,
            pay_date TEXT,
            declaration_date TEXT,
            amount REAL,
            currency TEXT,
            source TEXT
        )
        """
    )
    conn.execute(
        "CREATE TABLE stock_splits (ticker TEXT, split_date TEXT, ratio REAL, source TEXT)"
    )
    conn.execute("INSERT INTO tickers VALUES ('ASML', 'ASML Holding N.V.', 'USD')")
    conn.executemany(
        "INSERT INTO dividend_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("ASML", "2026-04-27", "2026-04-27", "2026-05-05", "2026-01-28", 3.16845, "USD", "polygon"),
            ("ASML", "2026-07-28", "2026-07-28", "2026-08-05", "2026-07-15", 2.15072, "USD", "polygon"),
        ],
    )

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = dividends_module.connect
    original_today = dividends_module._today
    original_history_start = dividends_module.dividend_history_start
    try:
        dividends_module.connect = fake_connect
        dividends_module._today = lambda: date(2026, 7, 22)
        dividends_module.dividend_history_start = lambda: date(2016, 1, 1)
        payload = dividends_module.load_dividend_history("ASML")
        details = [detail for row in payload["rows"] for detail in row["payments_detail"]]
        future = next(detail for detail in details if detail["pay_date"] == "2026-08-05")
        assert future["entitlement_date"] == "2026-07-28"
        assert abs(future["amount"] - 2.15072) < 1e-9
        assert future["source"] == "polygon"
    finally:
        dividends_module.connect = original_connect
        dividends_module._today = original_today
        dividends_module.dividend_history_start = original_history_start
        conn.close()


def test_race_cross_currency_duplicate_is_one_annual_dividend():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tickers (ticker TEXT PRIMARY KEY, name TEXT, currency TEXT)")
    conn.execute(
        """
        CREATE TABLE dividend_events (
            ticker TEXT,
            ex_date TEXT,
            record_date TEXT,
            pay_date TEXT,
            declaration_date TEXT,
            amount REAL,
            currency TEXT,
            source TEXT
        )
        """
    )
    conn.execute("CREATE TABLE stock_splits (ticker TEXT, split_date TEXT, ratio REAL, source TEXT)")
    conn.execute("INSERT INTO tickers VALUES ('RACE', 'Ferrari N.V.', 'USD')")
    conn.executemany(
        "INSERT INTO dividend_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("RACE", "2024-04-22", "2024-04-23", "2024-05-03", "2024-02-22", 2.443, "EUR", "polygon"),
            ("RACE", "2025-04-22", None, None, None, 3.438, "USD", "yf-history"),
            ("RACE", "2025-04-23", "2025-04-23", "2025-05-06", "2025-02-20", 2.986, "EUR", "polygon"),
            ("RACE", "2026-04-20", None, None, None, 4.254, "USD", "yf-history"),
            ("RACE", "2026-04-21", "2026-04-21", "2026-05-05", "2026-02-19", 3.615, "EUR", "polygon"),
        ],
    )

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = dividends_module.connect
    original_today = dividends_module._today
    original_history_start = dividends_module.dividend_history_start
    try:
        dividends_module.connect = fake_connect
        dividends_module._today = lambda: date(2026, 7, 24)
        dividends_module.dividend_history_start = lambda: date(2016, 1, 1)
        payload = dividends_module.load_dividend_history("RACE")
        assert payload["summary"]["frequency"] == 1
        assert payload["summary"]["frequency_label"] == "연배당"
        rows = {row["year"]: row for row in payload["rows"]}
        assert rows[2025]["payments"] == 1
        assert rows[2025]["expected_payments"] == 1
        assert abs(rows[2025]["amount"] - 2.986) < 1e-9
        assert len(rows[2025]["payments_detail"]) == 1
        assert rows[2025]["payments_detail"][0]["source"] == "polygon"
    finally:
        dividends_module.connect = original_connect
        dividends_module._today = original_today
        dividends_module.dividend_history_start = original_history_start
        conn.close()


def test_yearly_expected_payment_counts_preserves_historical_frequency():
    expected = dividends_module._yearly_expected_payment_counts(
        {2021: 1, 2022: 1, 2023: 1, 2024: 1, 2025: 2, 2026: 1},
        2026,
        2,
    )
    assert expected == {
        2021: 1,
        2022: 1,
        2023: 1,
        2024: 1,
        2025: 2,
        2026: 2,
    }


def test_yearly_expected_payment_counts_handles_isolated_years():
    """양옆 연도에 이력이 없는 고립 연도(배당 개시·재개)에서 죽지 않아야 한다.

    ENR.DE 실사고: 이력이 2022·2026뿐이라 2022의 previous/following이 모두
    None → None == None 이 참이 된 뒤 None > frequency 비교로 TypeError,
    배당이력 팝업이 500으로 비었다(같은 증상 37종목).
    """
    expected = dividends_module._yearly_expected_payment_counts(
        {2022: 1, 2026: 1}, 2026, 1,
    )
    assert expected == {2022: 1, 2026: 1}


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


def test_monthly_dividend_growth_compares_four_calendar_month_sums():
    events = []
    amounts = {
        (2025, 5): [0.30],
        (2025, 6): [0.31],
        (2025, 7): [0.32],
        (2025, 8): [0.33],
        (2026, 5): [0.28],
        (2026, 6): [0.29],
        (2026, 7): [0.30],
        # 지급일 이동으로 같은 달에 두 건이어도 월 합계로 비교한다.
        (2026, 8): [0.15, 0.16],
    }
    for (year, month), month_amounts in amounts.items():
        for day, amount in enumerate(month_amounts, start=1):
            events.append({"date": date(year, month, day), "amount": amount})

    result = _rolling_monthly_growth(events)
    assert result is not None
    assert result["period_start"] == "2026-05"
    assert result["period_end"] == "2026-08"
    assert abs(result["current_amount"] - 1.18) < 1e-9
    assert abs(result["previous_amount"] - 1.26) < 1e-9
    assert abs(result["growth_pct"] - (1.18 / 1.26 - 1) * 100) < 1e-9

    estimate = _monthly_annual_estimate({2025: 3.78}, 2026, result)
    assert abs(estimate - 3.78 * 1.18 / 1.26) < 1e-9


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


def test_yfinance_profile_metrics_normalizes_interest_fields():
    metrics = yfinance_profile_metrics({
        "info": {
            "grossMargins": 0.46,
            "revenueGrowth": 0.18,
            "debtToEquity": 79.5,
            "freeCashflow": 12_345_678,
            "payoutRatio": 0.22,
            "shortPercentOfFloat": 0.014,
            "sharesPercentSharesOut": 0.011,
            "shortRatio": 1.7,
            "heldPercentInsiders": 0.032,
            "heldPercentInstitutions": 0.71,
            "financialCurrency": "usd",
        }
    })
    assert metrics["gross_margin"] == 0.46
    assert metrics["revenue_growth"] == 0.18
    assert metrics["debt_to_equity"] == 79.5
    assert metrics["free_cash_flow"] == 12_345_678
    assert metrics["payout_ratio"] == 0.22
    assert metrics["short_percent_float"] == 0.014
    assert metrics["short_percent_shares"] == 0.011
    assert metrics["short_ratio"] == 1.7
    assert metrics["insider_ownership"] == 0.032
    assert metrics["institutional_ownership"] == 0.71
    assert metrics["financial_currency"] == "USD"


def test_yfinance_dividend_yield_rejects_cross_currency_rate():
    skhy = {
        "currency": "USD",
        "financialCurrency": "KRW",
        "currentPrice": 143.53,
        "trailingAnnualDividendRate": 2625.0,
        "trailingAnnualDividendYield": 17.380653,
    }
    assert yfinance_dividend_yield(skhy) is None
    assert yfinance_profile_metrics({"info": skhy})["dividend_yield"] is None

    # 거래·재무통화가 달라도 거래가격 단위로 정상 환산된 배당금은 유지한다.
    valid_adr = dict(
        skhy,
        trailingAnnualDividendRate=2.5,
        trailingAnnualDividendYield=1.74,
    )
    assert yfinance_dividend_yield(valid_adr) == 1.74


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

    # 전일 환율이 동일해도 '마지막으로 달랐던 값'을 쓰지 않고 실제 직전
    # 거래일 종가를 사용해야 휴장 종목의 금일 환산손익이 0으로 남는다.
    prices["USDKRW"]["prior_price"] = 1500.0
    assert fx_previous_rates(prices)["USD"] == 1500.0


def test_price_view_keeps_regular_change_separate_from_extended_price():
    snapshot = {
        "prices": {
            "MSFT": {
                "price": 425.01,
                "previous_price": 393.35,
                "regular_price": 390.54,
                "regular_previous_price": 393.35,
                "extended_price": 425.01,
                "extended_change": 34.47,
                "extended_change_pct": 8.826,
            }
        },
        "rates": {"USD": 1450.0},
        "previous_rates": {"USD": 1450.0},
    }
    view = price_view("MSFT", "USD", snapshot)
    assert view["current_price"] == 425.01
    assert view["price_record"]["regular_previous_price"] == 393.35
    assert round(view["change"], 2) == -2.81
    assert round(view["change_pct"], 3) == -0.714


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


def test_python_technical_indicators_match_previous_calculation():
    values = [1, 2, 3, 2, 4, 3, 5, 4, 6, 7, 5, 8, 9, 7, 10, 11, 8, 12, 13, 10, 14]
    rsi = rsi_series(values)
    assert rsi[:13] == [None] * 13
    assert abs(rsi[-1] - 66.0488098264758) < 1e-12
    pband = bollinger_pband([float(value) for value in range(1, 21)])
    assert abs(pband - 91.1877235523957) < 1e-12


def test_extended_price_replaces_latest_close_for_rsi_and_bollinger():
    rows = [
        {
            "date": f"2026-07-{day:02d}",
            "close": 100.0 + ((day * 7) % 11) - day * 0.15,
        }
        for day in range(1, 31)
    ]
    adjusted_rows = price_adjusted_rows(rows, 115.0, "2026-07-30")
    adjusted = calculate_price_adjusted_indicators(rows, 115.0, "2026-07-30")
    regular = calculate_price_adjusted_indicators(rows, 105.0, "2026-07-30")

    assert len(adjusted_rows) == len(rows)
    assert adjusted_rows[-1]["close"] == 115.0
    assert adjusted["rsi"]["day"] > regular["rsi"]["day"]
    assert adjusted["bollinger_pband"]["day"] > regular["bollinger_pband"]["day"]


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
        "one_week", "one_month", "three_month", "six_month", "ytd",
        "one_year", "three_year", "five_year", "ten_year",
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
        assert estimate["ex_date"] == "2026-09-11"
        assert estimate["ex_date_estimated"] is True
        assert estimate["pay_date_estimated"] is True
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


def test_hsbc_groups_three_interims_with_following_final():
    """영국식 '중간배당 3회 + 이듬해 3월 결산배당 1회'를 한 사업연도로 묶는다."""
    rows = [
        {"record_date": None, "ex_date": ex, "pay_date": None, "declaration_date": None, "amount": amount, "source": "test"}
        for ex, amount in [
            ("2021-08-19", 0.35), ("2022-03-10", 0.90),
            ("2022-08-18", 0.45), ("2023-03-02", 1.15),
            ("2023-05-11", 0.50), ("2023-08-10", 0.50), ("2023-11-09", 0.50), ("2024-03-07", 1.55),
            ("2024-05-09", 0.50), ("2024-08-16", 0.50), ("2024-11-08", 0.50), ("2025-03-07", 1.80),
            ("2025-05-09", 0.50), ("2025-08-15", 0.50), ("2025-11-07", 0.50), ("2026-03-13", 2.25),
        ]
    ]

    events, _ = _attributed_history_events(rows, "HSBC", False, None)
    annual = _aggregate_annual_dividends(events)

    # 결산배당은 지급이 이듬해라도 직전 사업연도에 붙는다.
    assert annual[2025]["payments"] == 4
    assert round(annual[2025]["amount"], 2) == 3.75
    assert [event["date"].isoformat() for event in annual[2025]["events"]][-1] == "2026-03-13"
    assert round(annual[2024]["amount"], 2) == 3.30
    assert round(annual[2023]["amount"], 2) == 3.05
    # 회차가 2회뿐인 해도 이웃 사업연도와 합쳐지지 않는다(다수결 재라벨 제외).
    assert annual[2022]["payments"] == 2
    assert round(annual[2022]["amount"], 2) == 1.60
    assert round(annual[2021]["amount"], 2) == 1.25


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


def test_long_dividend_plateau_aligns_to_current_raise_month():
    """수년 동결 뒤 인상월이 바뀌어도 잘린 해를 만들지 않는다.

    WAB: $0.12를 8월부터 이어 오다가 2022-02에 인상. 4회씩 앞에서 자르면
    2021-02·05가 2020으로 넘어가고 2021은 2회($0.24)만 남아 5년 CAGR이 부풀었다.
    """
    rows = []
    for record_date, amount in [
        ("2019-08-09", 0.12), ("2019-11-15", 0.12),
        ("2020-02-07", 0.12), ("2020-05-08", 0.12),
        ("2020-08-14", 0.12), ("2020-11-13", 0.12),
        ("2021-02-12", 0.12), ("2021-05-07", 0.12),
        ("2021-08-13", 0.12), ("2021-11-15", 0.12),
        ("2022-02-25", 0.15), ("2022-05-20", 0.15),
        ("2022-08-15", 0.15), ("2022-11-14", 0.15),
        ("2023-02-24", 0.17), ("2023-05-30", 0.17),
        ("2023-08-14", 0.17), ("2023-11-15", 0.17),
        ("2024-02-23", 0.20), ("2024-05-28", 0.20),
        ("2024-08-14", 0.20), ("2024-11-13", 0.20),
        ("2025-02-21", 0.25), ("2025-05-27", 0.25),
        ("2025-08-14", 0.25), ("2025-11-12", 0.25),
        ("2026-02-17", 0.31), ("2026-05-22", 0.31),
        ("2026-08-18", 0.31),
    ]:
        rows.append({
            "record_date": record_date,
            "ex_date": None,
            "pay_date": None,
            "declaration_date": None,
            "amount": amount,
            "source": "test",
        })

    events, _ = _attributed_history_events(rows, "WAB", False, 1)
    annual = _aggregate_annual_dividends(events)

    assert annual[2020]["payments"] == 4
    assert round(annual[2020]["amount"], 2) == 0.48
    assert [event["date"].isoformat()[:7] for event in annual[2020]["events"]] == [
        "2020-02", "2020-05", "2020-08", "2020-11",
    ]
    assert annual[2021]["payments"] == 4
    assert round(annual[2021]["amount"], 2) == 0.48
    assert [event["date"].isoformat()[:7] for event in annual[2021]["events"]] == [
        "2021-02", "2021-05", "2021-08", "2021-11",
    ]
    assert annual[2025]["payments"] == 4
    assert round(annual[2025]["amount"], 2) == 1.00
    estimate = 1.24
    totals = {year: row["amount"] for year, row in annual.items()}
    cagr = _estimated_annual_cagr(totals, {2020, 2021, 2022, 2023, 2024, 2025}, 2026, estimate, 5)
    assert abs(cagr - ((estimate / 0.48) ** (1 / 5) - 1) * 100) < 1e-9


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


def test_risk_reward_score_formula():
    from portfolio_core.risk_reward import risk_reward_score, vol_floor_pct

    # 정상: 기간별 총변동성(clamp(excess)/max(vol, 자산군 바닥)) 가중평균 ×10
    # 52주 고점 보정 없음. 주식 바닥 8% — vol 20/25/40은 바닥에 안 걸림.
    periods = {
        "5y": {"excess": 16.0, "vol": 20.0, "quality": "TR"},
        "3y": {"excess": 12.0, "vol": 25.0, "quality": "TR"},
        "1y": {"excess": 30.0, "vol": 40.0, "quality": "TR"},
    }
    score, basis, quality = risk_reward_score(periods, "stock")
    expected = (0.6 * 16 / 20 + 0.3 * 12 / 25 + 0.1 * 30 / 40) * 10
    assert basis == "5y" and quality == "TR"
    assert abs(score - round(expected, 2)) < 0.01

    # 결측 기간 가중 비례 재분배: 5y 없음 → 3y 0.75 / 1y 0.25
    score3, basis3, _q = risk_reward_score(
        {"3y": {"excess": 12.0, "vol": 25.0, "quality": "TR"},
         "1y": {"excess": 30.0, "vol": 40.0, "quality": "TR"}}, "stock")
    expected3 = (0.75 * 12 / 25 + 0.25 * 30 / 40) * 10
    assert basis3 == "3y"
    assert abs(score3 - round(expected3, 2)) < 0.01

    # 품질: 한 기간이라도 P면 P
    _s, _b, quality_p = risk_reward_score(
        {"5y": {"excess": 10.0, "vol": 20.0, "quality": "P"},
         "1y": {"excess": 10.0, "vol": 20.0, "quality": "TR"}}, "stock")
    assert quality_p == "P"

    # 캡·자산군별 변동성 바닥 (주식 8%, 크립토 20%)
    capped, _b, _q = risk_reward_score({"1y": {"excess": 500.0, "vol": 40.0, "quality": "TR"}}, "stock")
    assert abs(capped - 100.0 / 40.0 * 10) < 0.01
    floor, _b, _q = risk_reward_score({"1y": {"excess": 4.0, "vol": 1.0, "quality": "TR"}}, "stock")
    assert abs(floor - 4.0 / 8.0 * 10) < 0.01
    crypto, _b, _q = risk_reward_score({"1y": {"excess": 4.0, "vol": 1.0, "quality": "TR"}}, "crypto")
    assert abs(crypto - 4.0 / 20.0 * 10) < 0.01
    assert vol_floor_pct("fx") == 3.0

    # 고점 괴리와 무관 — 기간만 있으면 점수
    assert risk_reward_score(periods)[0] is not None
    assert risk_reward_score(None) == (None, None, None)
    assert risk_reward_score({"5y": None, "3y": None, "1y": None}) == (None, None, None)


def test_entry_risk_reward_score_formula():
    from portfolio_core.entry_reward import (
        WEEK_UPSIDE_CAP,
        entry_risk_reward_score,
        _rsi_scale,
    )
    from portfolio_core.indicators import atr_percent, bollinger_distance_pct, ma_pct

    # 일·주 상단 0. 주 RSI 55·60일선 위 → 업사이드 0
    assert entry_risk_reward_score(0.0, 2.0, 50, 55, 5.0, 0.0) == 0.0

    # 일·주 +6%, ATR 2% → 손절 3% → 6/3=2. 주 RSI 60·60일선 +5%(둘 다 밴드 밖) → 추세 1.0·일 RSI 50
    mid = entry_risk_reward_score(6.0, 2.0, 50, 60, 5.0, 6.0)
    assert abs(mid - 2.0) < 0.02

    # 주 밴드가 일보다 무겁다: 일은 소진(0)이어도 주에 여유가 있으면 점수가 난다
    weekly_room = entry_risk_reward_score(0.0, 2.0, 50, 60, 5.0, 8.0)
    daily_only = entry_risk_reward_score(8.0, 2.0, 50, 60, 5.0, 0.0)
    assert abs(weekly_room - 8.0 * 0.7 / 3.0) < 0.02
    assert abs(daily_only - 8.0 * 0.3 / 3.0) < 0.02
    assert weekly_room > daily_only

    # 주봉 상단 거리는 30%에서 자른다. 급락 후 4σ 여유를 그대로 쓰지 않는다.
    capped = entry_risk_reward_score(0.0, 2.0, 50, 60, 5.0, 400.0)
    assert abs(capped - WEEK_UPSIDE_CAP * 0.7 / 3.0) < 0.02
    uncapped = entry_risk_reward_score(0.0, 2.0, 50, 60, 5.0, 20.0)
    assert abs(uncapped - 20.0 * 0.7 / 3.0) < 0.02
    assert capped > uncapped

    # 같은 ATR이면 상단 여유가 큰 쪽이 높다
    near_upper = entry_risk_reward_score(1.0, 2.0, 50, 60, 5.0, 1.0)
    near_lower = entry_risk_reward_score(8.0, 2.0, 50, 60, 5.0, 8.0)
    assert near_lower > near_upper > 0

    # 타이밍 RSI는 일봉만. 주 RSI는 추세에만 쓰이므로 일 RSI만 바꿔도 점수가 갈린다.
    rsi_scores = [
        entry_risk_reward_score(6.0, 2.0, value, 55, 5.0, 6.0)
        for value in (30, 40, 50, 70, 85)
    ]
    assert all(left > right for left, right in zip(rsi_scores, rsi_scores[1:]))
    assert abs(_rsi_scale(50) - 1.0) < 1e-9
    assert _rsi_scale(40) > _rsi_scale(45) > 1.0
    assert 0.25 <= _rsi_scale(90) < _rsi_scale(70) < 1.0
    # 주 RSI가 낮아도 일 RSI 50이면 타이밍 계수는 1.0 (추세만 약해진다)
    # 주 RSI 30(성분 0)·60일선 +5%(성분 1) → 평균 0.5 → 추세 0.625
    same_timing = entry_risk_reward_score(6.0, 2.0, 50, 30, 5.0, 6.0)
    assert abs(same_timing - 2.0 * 0.625) < 0.02

    # 주 RSI 40·60일선 −5%(둘 다 밴드 밖 약세) → 추세 0.25. 일 RSI 50 → 타이밍 1.0
    weak = entry_risk_reward_score(6.0, 2.0, 50, 40, -5.0, 6.0)
    assert abs(weak - 2.0 * 0.25) < 0.02

    # 주 RSI 60(강)·60일선 −5%(약) → 혼합 0.625. 문턱 안쪽(−1%)은 그 사이 값
    mixed = entry_risk_reward_score(6.0, 2.0, 50, 60, -5.0, 6.0)
    assert abs(mixed - 2.0 * 0.625) < 0.02
    between = entry_risk_reward_score(6.0, 2.0, 50, 60, -1.0, 6.0)
    assert mixed < between < 2.0

    # ATR 바닥 1%. ATR 0.2%여도 손절은 1%
    floor = entry_risk_reward_score(4.0, 0.2, 50, 60, 5.0, 4.0)
    assert abs(floor - 4.0) < 0.02

    # ATR은 손절 폭으로만. 같은 밴드면 ATR이 큰 쪽이 점수가 낮다 (가점 없음)
    low_vol = entry_risk_reward_score(6.0, 2.0, 50, 60, 5.0, 6.0)
    high_vol = entry_risk_reward_score(6.0, 4.0, 50, 60, 5.0, 6.0)
    assert low_vol > high_vol > 0
    assert abs(high_vol / low_vol - 0.5) < 0.02

    assert entry_risk_reward_score(None, 2.0, 50, 60, 5.0, 6.0) is None
    assert entry_risk_reward_score(6.0, None, 50, 60, 5.0, 6.0) is None
    # 이력 부족 결측은 낙관 기본값 대신 점수 없음 — 주 RSI / 주 상단 / 60일선 / 일 RSI
    assert entry_risk_reward_score(6.0, 2.0, 50, None, 5.0, 6.0) is None
    assert entry_risk_reward_score(6.0, 2.0, 50, 60, 5.0, None) is None
    assert entry_risk_reward_score(6.0, 2.0, 50, 60, None, 6.0) is None
    assert entry_risk_reward_score(6.0, 2.0, None, 60, 5.0, 6.0) is None

    assert ma_pct([100.0] * 20) == 0.0
    assert ma_pct([90.0] * 19 + [110.0]) > 0
    assert ma_pct([100.0] * 60, 60) == 0.0
    assert ma_pct([90.0] * 59 + [110.0], 60) > 0

    # 밴드 거리: 평탄하면 상·하단이 현재가에 가깝다
    flat = [100.0] * 19 + [100.0]
    assert bollinger_distance_pct(flat) is None  # width 0
    series = [100.0 + (index % 5) for index in range(25)]
    distances = bollinger_distance_pct(series)
    assert distances is not None and distances[0] > 0 and distances[1] > 0

    # ATR: 종가만 있으면 |Δclose|, high/low가 있으면 True Range
    closes = [{"close": 100.0 + index} for index in range(20)]
    assert atr_percent(closes) is not None and atr_percent(closes) > 0
    ranges = [{"close": 100.0, "high": 110.0, "low": 90.0} for _ in range(20)]
    assert atr_percent(ranges) > atr_percent(closes)


def test_total_return_periods_dividend_mapping():
    from portfolio_core.technical_stats import total_return_periods

    # 300거래일 평탄한 가격 + 중간 배당 1건 → 1y CAGR에 배당 수익만 반영
    days = []
    base = date(2024, 1, 2)
    current = base
    while len(days) < 300:
        if current.weekday() < 5:
            days.append(current.isoformat())
        current += timedelta(days=1)
    price_rows = [{"date": day, "close": 100.0} for day in days]

    dividend_rows = [{
        "ex_date": days[150], "record_date": None, "pay_date": None,
        "declaration_date": None, "amount": 5.0, "currency": "USD", "source": "yf-history",
    }]
    result = total_return_periods(price_rows, dividend_rows, [], "USD")
    one_year = result["1y"]
    assert one_year is not None and one_year["quality"] == "TR"
    # 총누적 5% → 산술 연율 ≈ 5%대, 초과수익은 rf 3%를 뺀 값
    assert 4.0 < one_year["mean"] < 6.0
    assert abs(one_year["excess"] - (one_year["mean"] - 3.0)) < 0.01
    assert result["5y"] is None and result["3y"] is None  # 이력 부족

    # 분할 미조정 소스(polygon): 분할 후 이벤트 금액이 10으로 나뉜다
    splits = [{"split_date": days[200], "ratio": 10.0, "source": "yfinance"}]
    div_unadjusted = [{
        "ex_date": days[150], "record_date": None, "pay_date": None,
        "declaration_date": None, "amount": 5.0, "currency": "USD", "source": "polygon",
    }]
    adj = total_return_periods(price_rows, div_unadjusted, splits, "USD")
    assert adj["1y"]["mean"] < 1.0  # 0.5/100 수준으로 축소

    # 마지막 가격일 이후 배당락 = 미래 이벤트 — 실패로 세지 않고 TR 유지
    # (미국 종목은 KST 기준 가격이 하루 늦어 당일 배당이 이 상태가 된다)
    future_div = [{
        "ex_date": (date.fromisoformat(days[-1]) + timedelta(days=1)).isoformat(),
        "record_date": None, "pay_date": None, "declaration_date": None,
        "amount": 5.0, "currency": "USD", "source": "yf-history",
    }]
    future = total_return_periods(price_rows, future_div, [], "USD")
    assert future["1y"]["quality"] == "TR" and abs(future["1y"]["mean"]) < 0.5

    # 기간 내 매핑 실패(가격 공백 6일 초과)가 있으면 품질 P.
    # 매핑된 배당은 남긴다(첫 5%는 1y 창에 포함).
    gap_days = [d for d in days if not (days[100] <= d <= days[104])]
    gap_rows = [{"date": day, "close": 100.0} for day in gap_days]
    mixed_divs = [
        {"ex_date": days[50], "record_date": None, "pay_date": None,
         "declaration_date": None, "amount": 5.0, "currency": "USD", "source": "yf-history"},
        {"ex_date": days[101], "record_date": None, "pay_date": None,
         "declaration_date": None, "amount": 5.0, "currency": "USD", "source": "polygon"},
    ]
    # days[101]~[104] 제거로 두 번째 배당은 다음 가격일까지 6일 초과 → 실패
    partial = total_return_periods(gap_rows, mixed_divs, [], "USD")
    assert partial["1y"]["quality"] == "P"
    assert 4.0 < partial["1y"]["mean"] < 6.0  # 첫 배당은 유지

    # 배당수익률이 있는데 이벤트가 없으면 가격 폴백 P
    no_div = total_return_periods(price_rows, [], [], "USD", None, 3.0)
    assert no_div["1y"]["quality"] == "P"
    # 무배당 종목(수익률 정보 없음)은 TR
    zero_div = total_return_periods(price_rows, [], [], "USD", None, None)
    assert zero_div["1y"]["quality"] == "TR"


def _price_rows_from_returns(returns: list[float], start: date = date(2018, 1, 2), price: float = 100.0):
    days = []
    current = start
    while len(days) < len(returns) + 1:
        if current.weekday() < 5:
            days.append(current.isoformat())
        current += timedelta(days=1)
    closes = [price]
    for value in returns:
        closes.append(closes[-1] * (1 + value))
    return [{"date": day, "close": close} for day, close in zip(days, closes)]


def test_total_return_periods_nonoverlap_vol_krw():
    from portfolio_core.technical_stats import total_return_periods

    # 비겹침: 3~5년 전 +0.04%일, 1~3년 전 0, 최근 1년 +0.08%일
    far = [0.0004] * 504
    mid = [0.0] * 504
    near = [0.0008] * 252
    rows = _price_rows_from_returns(far + mid + near)
    result = total_return_periods(rows, [], [], "KRW", risk_free_pct=3.0)
    assert result["5y"] is not None and result["3y"] is not None and result["1y"] is not None
    assert 9.0 < result["5y"]["mean"] < 11.5
    assert abs(result["3y"]["mean"]) < 0.2
    assert 19.0 < result["1y"]["mean"] < 21.5
    # 창이 겹치지 않으므로 1y 평균이 5y에 섞이지 않는다
    assert result["5y"]["mean"] < result["1y"]["mean"] - 5

    # 총변동성: 10% 하루 스파이크는 연율 vol에 잡힌다
    quiet = [0.0] * 251
    spike = _price_rows_from_returns(quiet + [0.10])
    spiked = total_return_periods(spike, [], [], "KRW", risk_free_pct=0.0)
    assert spiked["1y"]["vol"] > 8.0
    assert spiked["1y"]["mean"] > 8.0

    # KRW 환산: 가격은 그대로인데 환율이 오르면 수익이 생긴다
    fx_days = []
    current = date(2024, 1, 2)
    while len(fx_days) < 260:
        if current.weekday() < 5:
            fx_days.append(current)
        current += timedelta(days=1)
    fx_rows = [{"date": day.isoformat(), "close": 100.0} for day in fx_days]

    def fx_lookup(from_ccy, to_ccy, on):
        if from_ccy == "USD" and to_ccy == "KRW":
            return 1100.0 if on >= fx_days[-1] else 1000.0
        return None

    fx_result = total_return_periods(fx_rows, [], [], "USD", fx_lookup, risk_free_pct=0.0)
    assert fx_result["1y"]["mean"] > 8.0
    flat_fx = total_return_periods(fx_rows, [], [], "USD", lambda *_a: 1000.0, risk_free_pct=0.0)
    assert abs(flat_fx["1y"]["mean"]) < 0.5


def test_dedupe_same_currency_duplicates():
    from portfolio_core.corporate_actions import dedupe_dividend_event_rows

    def event(ex_date, amount, source, currency="USD"):
        return {"ex_date": ex_date, "record_date": None, "pay_date": None,
                "declaration_date": None, "amount": amount, "currency": currency, "source": source}

    # ETN 유형: 이종 출처·동일 금액·1일 차 → 병합(정보 우선 polygon 유지)
    merged = dedupe_dividend_event_rows([
        event("2025-11-05", 1.04, "yf-history"),
        event("2025-11-06", 1.04, "polygon"),
    ])
    assert len(merged) == 1 and merged[0]["source"] == "polygon"

    # COST 유형: 같은 출처의 특별+정기(2일 차, 금액 다름) → 보존
    kept = dedupe_dividend_event_rows([
        event("2017-05-08", 7.0, "polygon"),
        event("2017-05-10", 0.5, "polygon"),
    ])
    assert len(kept) == 2

    # 이종 출처라도 금액이 다르면 보존 (DGRW 유형)
    kept2 = dedupe_dividend_event_rows([
        event("2021-12-22", 0.30, "yf-history"),
        event("2021-12-27", 0.20349, "polygon"),
    ])
    assert len(kept2) == 2

    # 교차통화(RACE 유형): 통화 다름·1일 차 → 병합
    cross = dedupe_dividend_event_rows([
        event("2026-04-20", 4.254, "yf-history", "USD"),
        event("2026-04-21", 3.615, "polygon", "EUR"),
    ])
    assert len(cross) == 1


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


def test_rms_combined_final_and_special_dividends_are_split():
    rows = []
    for ex_date, amount in [
        ("2022-02-21", 2.5),
        ("2022-04-25", 5.5),
        ("2023-02-20", 3.5),
        ("2023-04-25", 9.5),
        ("2024-02-13", 3.5),
        ("2024-05-02", 21.5),
        ("2025-02-17", 3.5),
        ("2025-05-05", 22.5),
        ("2026-02-16", 5.0),
        ("2026-04-21", 13.0),
    ]:
        rows.append({
            "record_date": None,
            "ex_date": ex_date,
            "pay_date": None,
            "declaration_date": None,
            "amount": amount,
            "source": "yf-history",
        })

    events, _ = _attributed_history_events(rows, "RMS.PA", False, 3)
    annual = _aggregate_annual_dividends(events)

    assert annual[2024]["payments"] == 2
    assert annual[2024]["amount"] == 15.0
    assert annual[2025]["payments"] == 2
    assert annual[2025]["amount"] == 16.0
    assert len([event for event in annual[2024]["events"] if event["is_special"]]) == 1
    assert len([event for event in annual[2025]["events"] if event["is_special"]]) == 1
    assert {
        event["amount"]
        for event in events
        if event["date"] == date(2024, 5, 2)
    } == {10.0, 11.5}
    assert {
        event["amount"]
        for event in events
        if event["date"] == date(2025, 5, 5)
    } == {10.0, 12.5}
    assert next(
        event for event in events if event["date"] == date(2025, 2, 17)
    )["year"] == 2025

    totals = {year: row["amount"] for year, row in annual.items()}
    assert dividends_module._dividend_frequency(
        [event for event in events if not event["is_special"]],
        {year: row["payments"] for year, row in annual.items()},
        2026,
        "RMS.PA",
    ) == 2
    growth, basis = dividends_module._year_growth(
        2025, annual, totals, {2023, 2024, 2025}, False
    )
    assert basis == "annual"
    assert round(growth, 6) == round((16.0 / 15.0 - 1) * 100, 6)


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


def test_japan_market_holiday_marks_previous_session_change():
    holiday = japan_equity_calendar_day(date(2026, 8, 11))
    assert holiday == {"status": "closed", "reason": "산의 날"}
    note = holiday_change_session_note(
        "7974.T",
        "2026-08-10",
        datetime(2026, 8, 11, 12, 0, tzinfo=KST),
    )
    assert note == {
        "kind": "holiday_previous_session",
        "label": "휴",
        "price_date": "2026-08-10",
        "reason": "산의 날",
    }
    assert holiday_change_session_note(
        "7974.T",
        "2026-08-11",
        datetime(2026, 8, 11, 12, 0, tzinfo=KST),
    ) is None


def test_session_closed_badge_tracks_local_exchange_hours():
    """정규장이 끝났거나 아직 안 열린 거래소는 등락 열에 '종' 배지를 단다."""
    # 금요일 한국 오전 10시 — 한국장 진행중 / 유럽 개장 전 / 미국 폐장 후
    morning = datetime(2026, 8, 14, 10, 0, tzinfo=KST)
    assert change_session_note("005930.KS", "2026-08-14", morning) is None
    assert change_session_note("7974.T", "2026-08-14", morning) is None
    assert change_session_note("BMW.DE", "2026-08-13", morning) == {
        "kind": "session_closed",
        "label": "종",
        "price_date": "2026-08-13",
        "reason": "개장 전",
    }
    us_morning = change_session_note("AAPL", "2026-08-13", morning)
    assert us_morning["label"] == "종" and us_morning["reason"] == "장 종료"

    # 금요일 밤 11시 — 유럽·런던은 정규장, 한국·일본은 마감
    night = datetime(2026, 8, 14, 23, 0, tzinfo=KST)
    assert change_session_note("BMW.DE", "2026-08-14", night) is None
    assert change_session_note("SHEL.L", "2026-08-14", night) is None
    assert change_session_note("005930.KS", "2026-08-14", night)["label"] == "종"

    # 토요일 새벽 — 유럽은 끝났고(현지 금요일 저녁) 미국은 아직 정규장
    dawn = datetime(2026, 8, 15, 1, 30, tzinfo=KST)
    assert change_session_note("BMW.DE", "2026-08-14", dawn)["reason"] == "장 종료"
    assert change_session_note("AAPL", "2026-08-14", dawn) is None

    # 주말은 '휴'. 현지통화 손익을 0으로 만드는 kind는 기존 대상(일본)만 유지한다.
    saturday = datetime(2026, 8, 15, 12, 0, tzinfo=KST)
    kr_weekend = change_session_note("005930.KS", "2026-08-14", saturday)
    assert kr_weekend["label"] == "휴" and kr_weekend["kind"] == "holiday_closed"
    assert change_session_note("7974.T", "2026-08-14", saturday)["kind"] == "holiday_previous_session"

    # 24시간 거래(크립토·환율)와 미지원 거래소는 배지 없음
    assert change_session_note("BTC", "2026-08-15", saturday) is None
    assert change_session_note("USDKRW", "2026-08-14", saturday) is None

    # 지수는 constants의 region으로 거래소를 찾는다
    assert change_session_note("KOSPI", "2026-08-14", morning) is None
    assert change_session_note("SP500", "2026-08-13", morning)["label"] == "종"


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


def test_update_ticker_display_name():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tickers (ticker TEXT PRIMARY KEY, name TEXT, display_name TEXT)")
    conn.execute("INSERT INTO tickers VALUES ('AAPL', 'Apple Inc.', 'Apple')")

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = ticker_metadata_module.connect
    try:
        ticker_metadata_module.connect = fake_connect
        result = ticker_metadata_module.update_ticker_display_name({
            "ticker": " aapl ",
            "display_name": "  애플   본사  ",
        })
        assert result == {"ok": True, "ticker": "AAPL", "name": "애플 본사"}
        stored = conn.execute("SELECT display_name FROM tickers WHERE ticker = 'AAPL'").fetchone()
        assert stored["display_name"] == "애플 본사"
    finally:
        ticker_metadata_module.connect = original_connect
        conn.close()


def test_unregister_collected_ticker_purges_prices_and_rejects_protected():
    import portfolio_core.watchlist as watchlist_module

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tickers (ticker TEXT PRIMARY KEY, name TEXT, category TEXT)")
    conn.execute("CREATE TABLE holdings (ticker TEXT, qty REAL)")
    conn.execute("CREATE TABLE transactions (ticker TEXT)")
    for table in watchlist_module.TICKER_DATA_TABLES:
        conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (ticker TEXT)")
    conn.execute("INSERT INTO tickers VALUES ('MRNA', 'Moderna', 'overseas')")
    conn.execute("INSERT INTO tickers VALUES ('NVDA', 'NVIDIA', 'overseas')")
    conn.execute("INSERT INTO daily_prices VALUES ('MRNA')")
    conn.execute("INSERT INTO daily_prices VALUES ('NVDA')")
    conn.execute("INSERT INTO dividend_events VALUES ('MRNA')")
    conn.execute("INSERT INTO holdings VALUES ('NVDA', 1)")
    conn.execute("INSERT INTO interest_watchlist_items VALUES ('NVDA')")
    conn.execute("INSERT INTO daily_prices VALUES ('002620.KS')")  # tickers에 없는 무관한 종목
    conn.commit()

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = watchlist_module.connect
    original_logo = watchlist_module.delete_ticker_logo
    original_load = watchlist_module.load_interest_watchlists
    try:
        watchlist_module.connect = fake_connect
        watchlist_module.delete_ticker_logo = lambda ticker: None
        watchlist_module.load_interest_watchlists = lambda: {"groups": []}

        try:
            watchlist_module.unregister_collected_ticker({"ticker": "USDKRW"})
        except ValueError as exc:
            assert "환율" in str(exc)
        else:
            raise AssertionError("FX ticker was unregistered")

        try:
            watchlist_module.unregister_collected_ticker({"ticker": "NVDA"})
        except ValueError as exc:
            assert "관심그룹" in str(exc)
        else:
            raise AssertionError("grouped ticker was unregistered")

        result = watchlist_module.unregister_collected_ticker({"ticker": "mrna"})
        assert result == {"groups": []}
        assert conn.execute("SELECT 1 FROM tickers WHERE ticker = 'MRNA'").fetchone() is None
        assert conn.execute("SELECT 1 FROM daily_prices WHERE ticker = 'MRNA'").fetchone() is None
        assert conn.execute("SELECT 1 FROM dividend_events WHERE ticker = 'MRNA'").fetchone() is None
        assert conn.execute("SELECT 1 FROM tickers WHERE ticker = 'NVDA'").fetchone() is not None
        # 제외 대상이 아닌 종목은 tickers에 없더라도 이력이 남는다 — purge 범위는
        # 방금 제외한 티커 하나뿐이다(전체 훑기는 무관한 종목까지 지운 실사고 방지).
        assert conn.execute("SELECT 1 FROM daily_prices WHERE ticker = '002620.KS'").fetchone() is not None
    finally:
        watchlist_module.connect = original_connect
        watchlist_module.delete_ticker_logo = original_logo
        watchlist_module.load_interest_watchlists = original_load
        conn.close()


def test_purge_untracked_collected_data_only_touches_given_tickers():
    """추적 중인 종목은 지우지 않고, 대상 밖 종목은 미추적이어도 남긴다."""
    import portfolio_core.watchlist as watchlist_module

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tickers (ticker TEXT PRIMARY KEY, name TEXT, category TEXT)")
    conn.execute("CREATE TABLE holdings (ticker TEXT, qty REAL)")
    conn.execute("CREATE TABLE transactions (ticker TEXT)")
    for table in watchlist_module.TICKER_DATA_TABLES:
        conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (ticker TEXT)")
    conn.execute("INSERT INTO tickers VALUES ('NVDA', 'NVIDIA', 'overseas')")
    for ticker in ("NVDA", "MRNA", "002620.KS"):
        conn.execute("INSERT INTO daily_prices VALUES (?)", (ticker,))
    conn.commit()

    @contextmanager
    def fake_connect():
        yield conn

    original_connect = watchlist_module.connect
    try:
        watchlist_module.connect = fake_connect

        # 대상 밖 미추적 종목(002620.KS)은 건드리지 않는다.
        assert watchlist_module.purge_untracked_collected_data(["mrna"]) == 1
        assert conn.execute("SELECT 1 FROM daily_prices WHERE ticker = 'MRNA'").fetchone() is None
        assert conn.execute("SELECT 1 FROM daily_prices WHERE ticker = '002620.KS'").fetchone() is not None

        # 아직 추적 중인 종목은 대상으로 줘도 지우지 않는다.
        assert watchlist_module.purge_untracked_collected_data(["NVDA"]) == 0
        assert conn.execute("SELECT 1 FROM daily_prices WHERE ticker = 'NVDA'").fetchone() is not None

        assert watchlist_module.purge_untracked_collected_data([]) == 0
        assert watchlist_module.purge_untracked_collected_data(["", None]) == 0
    finally:
        watchlist_module.connect = original_connect
        conn.close()


def test_clean_ticker_display_name_rejects_blank_and_long_values():
    for value in ("", "   ", None, "x" * 81):
        try:
            ticker_metadata_module.clean_ticker_display_name(value)
        except ValueError:
            continue
        raise AssertionError(f"invalid display name accepted: {value!r}")


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


def test_letter_placeholder_matches_gstatic_gray_tile_only():
    import io

    from PIL import Image

    def png_bytes(size, color):
        image = Image.new("RGBA", (size, size), color)
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    gray_letter = png_bytes(256, (226, 226, 226, 255))
    assert 500 <= len(gray_letter) <= 3500
    assert _is_letter_placeholder(gray_letter)

    # ProShares SSO 같은 회색 타일+실로고는 크기가 커서 이니셜이 아니다.
    assert not _is_letter_placeholder(gray_letter + b"\x00" * 4000)

    # 흰 배경 워드마크·다른 해상도는 스킵.
    assert not _is_letter_placeholder(png_bytes(256, (255, 255, 255, 255)))
    assert not _is_letter_placeholder(png_bytes(150, (226, 226, 226, 255)))
    assert not _is_letter_placeholder(b"not-a-png")


def test_snapshot_candle_row_keeps_intraday_ohlc():
    from portfolio_core.snapshot_collector import candle_row

    # 시·고·저가 모두 오면 OHLC 행 — 그래야 장중에도 오늘 봉이 캔들로 그려진다.
    row = candle_row("2026-08-20", 216.45, {
        "open": 218.36, "high": 219.86, "low": 215.66, "volume": 36654373,
    })
    assert row == {
        "date": "2026-08-20", "open": 218.36, "high": 219.86,
        "low": 215.66, "close": 216.45, "volume": 36654373,
    }
    # 지수 폴링은 100배 정수 — 시·고·저만 배율을 되돌린다.
    assert candle_row("2026-08-20", 6852.58, {
        "open": 668034, "high": 690455, "low": 660009,
    }, scale=0.01) == {
        "date": "2026-08-20", "open": 6680.34, "high": 6904.55,
        "low": 6600.09, "close": 6852.58,
    }
    # 하나라도 없거나 0이면 종가 행으로 물러난다(가짜 시·고·저 금지).
    assert candle_row("2026-08-20", 42.8, {"open": None, "high": 43.0, "low": 42.0}) == ("2026-08-20", 42.8)
    assert candle_row("2026-08-20", 42.8, {"open": 0, "high": 43.0, "low": 42.0}) == ("2026-08-20", 42.8)


def test_dividend_streaks_from_yearly():
    from portfolio_core.dividend_streaks import streaks_from_yearly

    # 연속 지급·증액 — 완결 연도(작년)까지, 병합지급(0.18=두 분기 몫)은 중앙값으로 무시
    yearly = {
        2021: [0.09] * 4, 2022: [0.09, 0.09, 0.18, 0.09, 0.09],
        2023: [0.10] * 4, 2024: [0.11] * 4, 2025: [0.12] * 4, 2026: [0.13],
    }
    r = streaks_from_yearly(yearly, 2026)
    assert r == {"pay_years": 5, "pay_floor": 0, "growth_years": 3}

    # 이력이 yf 한계(1962)까지 닿으면 floor=1 → '64년+' 표기
    deep = {y: [0.1] for y in range(1962, 2026)}
    r = streaks_from_yearly(deep, 2026)
    assert r["pay_years"] == 64 and r["pay_floor"] == 1

    # 작년 지급이 없으면(배당 중단: INTC) 스트릭 0 — KeyError 회귀 방지
    stopped = {2022: [0.3] * 4, 2023: [0.35] * 4, 2024: [0.12]}
    r = streaks_from_yearly(stopped, 2026)
    assert r == {"pay_years": None, "pay_floor": 0, "growth_years": 0}

    assert streaks_from_yearly({}, 2026) == {"pay_years": None, "pay_floor": 0, "growth_years": None}


def test_dividend_streak_pay_never_below_growth():
    from portfolio_core.dividend_streaks import reconcile_pay_with_growth

    # 공식 증액 기록(스핀오프 승계)이 yf 지급 이력보다 길면 지급을 끌어올리고 '+' 표시
    assert reconcile_pay_with_growth(13.0, 0, 54.0) == (54.0, 1)
    # 이미 정합이면 그대로
    assert reconcile_pay_with_growth(64.0, 1, 63.0) == (64.0, 1)
    assert reconcile_pay_with_growth(32.0, 0, 22.0) == (32.0, 0)
    # 한쪽이 없으면 건드리지 않는다
    assert reconcile_pay_with_growth(None, 0, 10.0) == (None, 0)
    assert reconcile_pay_with_growth(10.0, 0, None) == (10.0, 0)


def test_entry_trend_factor_is_continuous():
    from portfolio_core.entry_reward import (
        TREND_STRONG, TREND_WEAK, _trend_factor, entry_risk_reward_score,
    )

    # 양 끝은 옛 계단과 같다
    assert _trend_factor(60, 5.0) == TREND_STRONG
    assert _trend_factor(40, -5.0) == TREND_WEAK
    # 옛 '하나만 충족'(0.6)에 해당하는 자리는 그 근처 값
    assert abs(_trend_factor(60, -5.0) - 0.625) < 1e-9
    # 60일선 이격 −2%→+2%에서 단조 증가, 문턱(0)에서 도약이 없다
    steps = [_trend_factor(50, pct) for pct in (-3, -2, -1, 0, 1, 2, 3)]
    assert all(b >= a for a, b in zip(steps, steps[1:]))
    assert abs(steps[3] - steps[2]) < 0.2 and abs(steps[4] - steps[3]) < 0.2
    # 정보 없음 → 강함, 한 성분만 → 그 성분으로
    assert _trend_factor(None, None) == TREND_STRONG
    assert _trend_factor(None, 5.0) == TREND_STRONG
    assert _trend_factor(None, -5.0) == TREND_WEAK

    # PH 실사례: 60일선 +0.11%→−0.34%로 0.45% 밀렸을 때 점수가 40% 빠지던 것이 완만해진다
    before = entry_risk_reward_score(9.5, 2.52, 45, 54.1, 0.11, 7.9)
    after = entry_risk_reward_score(11.4, 2.52, 42, 53.5, -0.34, 9.5)
    assert after > before * 0.85


def test_entry_score_series_matches_point_calculation():
    """차트용 일별 점수 시계열은 같은 날짜의 단건 계산과 일치하고, 이력 부족 구간은 None."""
    import sqlite3
    from portfolio_core.entry_reward_history import entry_score_on, entry_score_series
    from portfolio_core.entry_reward import entry_risk_reward_score

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE daily_prices (ticker TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL)")
    # 260거래일 합성 시계열 — 추세+파동
    import math
    from datetime import date, timedelta
    day = date(2025, 1, 6)
    rows = []
    for i in range(260):
        while day.weekday() >= 5:
            day += timedelta(days=1)
        px = 100 + i * 0.15 + 4 * math.sin(i / 7)
        rows.append((day.isoformat(), px * 0.995, px * 1.01, px * 0.99, px))
        day += timedelta(days=1)
    conn.executemany("INSERT INTO daily_prices VALUES ('T', ?, ?, ?, ?, ?)", rows)
    fetched = conn.execute("SELECT date, open, high, low, close FROM daily_prices ORDER BY date").fetchall()

    series = entry_score_series(fetched)
    assert len(series) == 260
    assert series[50] is None                       # 주봉 20개 전
    assert series[-1] is not None
    assert abs(series[-1] - entry_score_on(conn, "T", rows[-1][0])) < 1e-9
    assert abs(series[200] - entry_score_on(conn, "T", rows[200][0])) < 1e-9
    assert entry_score_series(fetched[:50]) == [None] * 50


def test_leveraged_product_detection():
    from portfolio_core.entry_reward import is_leveraged_product

    for name in (
        "Direxion TSLA 롱 2x", "Direxion Daily AAPL Bear 1X ETF", "GraniteShares 2x Long NVDA Daily ETF",
        "T-REX 2X Long SpaceX Daily Target ETF", "ProShares Ultra QQQ", "ProShares UltraPro QQQ",
        "ProShares UltraShort S&P500", "Tradr 1.5X Short NVDA Daily ETF",
        "KODEX 레버리지", "KODEX 200선물인버스2X", "Direxion Daily Semiconductor Bull 3X Shares",
    ):
        assert is_leveraged_product(name), name
    for name in (
        "Coca-Cola", "Schwab US Dividend Equity ETF", "KODEX 200TR", "SpaceX", "3M", "Texas Instruments",
        "Ultragenyx Pharmaceutical", "Longboard Pharmaceuticals", None, "",
    ):
        assert not is_leveraged_product(name), name


def test_performance_snapshot_reconstructs_opening_and_applies_fx():
    """기초 포지션 = 현재 잔고 − 기준일 이후 순거래. 일별 평가는 종가×환율(KRW).
    현금 입출금은 flow_krw에, 거래 현금은 trade_cash_krw에 누적된다."""
    import sqlite3
    from portfolio_core.performance_snapshots import build_account_series

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, member TEXT, name TEXT, account_type TEXT, currency TEXT, region TEXT, history_start TEXT);
        CREATE TABLE holdings (id INTEGER PRIMARY KEY, account_id INTEGER, ticker TEXT, qty REAL, currency TEXT);
        CREATE TABLE transactions (id INTEGER PRIMARY KEY, account_id INTEGER, trade_date TEXT, ticker TEXT, side TEXT, qty REAL, price REAL, currency TEXT);
        CREATE TABLE account_cash_flows (id INTEGER PRIMARY KEY, account_id INTEGER, flow_date TEXT, amount REAL, currency TEXT);
        CREATE TABLE daily_prices (date TEXT, ticker TEXT, close REAL);
        INSERT INTO accounts VALUES (1, 'A', '해외', 'overseas', 'USD', 'US', NULL);
        -- 현재 잔고 10주. 기준일(최초 거래 03-02) 이후 순거래 = +4 → 기초 6주
        INSERT INTO holdings VALUES (1, 1, 'XYZ', 10, 'USD');
        INSERT INTO transactions VALUES (1, 1, '2026-03-02', 'XYZ', 'BUY', 5, 100, 'USD');
        INSERT INTO transactions VALUES (2, 1, '2026-03-04', 'XYZ', 'SELL', 1, 120, 'USD');
        INSERT INTO account_cash_flows VALUES (1, 1, '2026-03-03', 500, 'USD');
    """)
    for day, px, fx in (("2026-03-01", 90, 1300), ("2026-03-02", 100, 1300), ("2026-03-03", 110, 1350), ("2026-03-04", 120, 1400)):
        conn.execute("INSERT INTO daily_prices VALUES (?, 'XYZ', ?)", (day, px))
        conn.execute("INSERT INTO daily_prices VALUES (?, 'USDKRW', ?)", (day, fx))

    import portfolio_core.performance_snapshots as ps
    original_today = ps.today_kst
    ps.today_kst = lambda: date(2026, 3, 4)
    try:
        series = build_account_series(conn, 1)
    finally:
        ps.today_kst = original_today

    assert [r["date"] for r in series] == ["2026-03-02", "2026-03-03", "2026-03-04"]
    # 03-02: 기초 6 + 매수 5 = 11주 × $100 × 1300
    assert series[0]["holdings_value_krw"] == 11 * 100 * 1300
    assert series[0]["trade_cash_krw"] == -5 * 100 * 1300
    assert series[0]["flow_krw"] == 0
    # 03-03: 11주 × $110 × 1350, 입금 $500 × 1350
    assert series[1]["holdings_value_krw"] == 11 * 110 * 1350
    assert series[1]["flow_krw"] == 500 * 1350
    # 03-04: 매도 1 → 10주(현재 잔고와 일치) × $120 × 1400, 매도 현금 +$120×1400
    assert series[2]["holdings_value_krw"] == 10 * 120 * 1400
    assert series[2]["trade_cash_krw"] == -5 * 100 * 1300 + 120 * 1400
    conn.close()


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

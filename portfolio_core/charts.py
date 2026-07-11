from __future__ import annotations

from datetime import datetime
from itertools import groupby

from .constants import MARKET_INDEXES
from .dates import parse_iso_date, today_kst
from .db import connect
from .indicators import shift_months
from .paths import US_EASTERN
from .prices import build_market_snapshot, fx_rates, latest_prices, price_view
from .queries import account_filter_clause, clean_account_ids, load_holding_rows
from .tickers import account_label, ticker_currency
from .us_live_quotes import us_market_status


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def _chart_overlay_series(rows) -> dict[str, dict[str, float | None]]:
    """일봉 OHLC rows → 날짜별 Bollinger/Ichimoku overlay 값.

    통계 탭용 RSI/BB 캐시는 최신값만 저장하므로, 차트용 시계열은 응답 생성 시
    daily_prices에서 계산한다. 차트 한 종목 단위라 비용은 작고 별도 DB 컬럼을 늘리지 않는다.
    """
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    overlay: dict[str, dict[str, float | None]] = {}
    raw_spans: list[tuple[float | None, float | None]] = []

    for index, row in enumerate(rows):
        close = float(row["close"])
        high = float(row["high"] if row["high"] is not None else close)
        low = float(row["low"] if row["low"] is not None else close)
        closes.append(close)
        highs.append(high)
        lows.append(low)

        item: dict[str, float | None] = {}

        if len(closes) >= 20:
            window = closes[-20:]
            avg = _mean(window)
            variance = _mean([(value - avg) ** 2 for value in window])
            deviation = variance ** 0.5
            item["bb_mid"] = avg
            item["bb_upper"] = avg + deviation * 2
            item["bb_lower"] = avg - deviation * 2

        tenkan = None
        kijun = None
        if len(highs) >= 9:
            tenkan = (max(highs[-9:]) + min(lows[-9:])) / 2
            item["ichi_tenkan"] = tenkan
        if len(highs) >= 26:
            kijun = (max(highs[-26:]) + min(lows[-26:])) / 2
            item["ichi_kijun"] = kijun
        span_a = (tenkan + kijun) / 2 if tenkan is not None and kijun is not None else None
        span_b = (max(highs[-52:]) + min(lows[-52:])) / 2 if len(highs) >= 52 else None
        raw_spans.append((span_a, span_b))

        shifted_index = index - 26
        if shifted_index >= 0:
            shifted_a, shifted_b = raw_spans[shifted_index]
            if shifted_a is not None:
                item["ichi_span_a"] = shifted_a
            if shifted_b is not None:
                item["ichi_span_b"] = shifted_b

        overlay[row["date"]] = item

    return overlay


def load_price_chart(ticker: str) -> dict:
    clean_ticker = (ticker or "").strip().upper()
    if not clean_ticker:
        raise ValueError("ticker is required")

    with connect() as conn:
        meta = conn.execute(
            """
            SELECT ticker, COALESCE(NULLIF(display_name, ''), name) AS name, currency, category
            FROM tickers
            WHERE ticker = ?
            """,
            (clean_ticker,),
        ).fetchone()
        rows = conn.execute(
            """
            SELECT p.date, p.high, p.low, p.close, i.rsi_14
            FROM daily_prices p
            LEFT JOIN daily_technical_indicators i
              ON i.ticker = p.ticker AND i.date = p.date
            WHERE p.ticker = ? AND p.close IS NOT NULL
            ORDER BY p.date
            """,
            (clean_ticker,),
        ).fetchall()
        transaction_rows = conn.execute(
            """
            SELECT
                t.trade_date,
                t.side,
                t.qty,
                t.price,
                COALESCE(t.currency, tk.currency, '') AS currency,
                COALESCE(t.member, a.member, '') AS member,
                a.account_type,
                a.name AS account_name
            FROM transactions t
            LEFT JOIN accounts a ON a.id = t.account_id
            LEFT JOIN tickers tk ON tk.ticker = t.ticker
            WHERE upper(t.ticker) = ?
            ORDER BY t.trade_date, t.id
            """,
            (clean_ticker,),
        ).fetchall()
        base_prices = latest_prices(conn, [clean_ticker])

    currency = meta["currency"] if meta and meta["currency"] else ticker_currency(clean_ticker)
    market_status = us_market_status()
    snapshot = build_market_snapshot(
        base_prices,
        [meta] if meta else [],
        include_extended=not bool(market_status.get("is_regular")),
        market_status=market_status,
    )
    market_view = price_view(clean_ticker, currency, snapshot)
    price_record = market_view["price_record"]
    overlays = _chart_overlay_series(rows)
    points = []
    for row in rows:
        if not row["date"] or row["close"] is None:
            continue
        point = {"date": row["date"], "close": float(row["close"])}
        if row["rsi_14"] is not None:
            point["rsi"] = float(row["rsi_14"])
        overlay = overlays.get(row["date"]) or {}
        if any(value is not None for value in overlay.values()):
            point.update({key: value for key, value in overlay.items() if value is not None})
        points.append(point)
    _append_market_chart_point(price_record, snapshot["market_status"], points)

    return {
        "ticker": clean_ticker,
        "name": (meta["name"] if meta and meta["name"] else clean_ticker),
        "currency": currency,
        "category": (meta["category"] if meta else None),
        "current_price": market_view["current_price"],
        "previous_price": market_view["previous_price"],
        "change": market_view["change"],
        "change_pct": market_view["change_pct"],
        "regular_price": price_record.get("regular_price"),
        "regular_previous_price": price_record.get("regular_previous_price"),
        "regular_change": price_record.get("regular_change"),
        "regular_change_pct": price_record.get("regular_change_pct"),
        "extended_price": price_record.get("extended_price"),
        "extended_base_price": price_record.get("extended_base_price"),
        "extended_change": price_record.get("extended_change"),
        "extended_change_pct": price_record.get("extended_change_pct"),
        "extended_source": price_record.get("extended_source"),
        "extended_market_state": price_record.get("extended_market_state") or price_record.get("market_state"),
        "market": snapshot["market_status"],
        "points": points,
        "transactions": [
            {
                "date": row["trade_date"],
                "side": row["side"],
                "qty": float(row["qty"]),
                "price": float(row["price"]),
                "currency": row["currency"] or (meta["currency"] if meta and meta["currency"] else ticker_currency(clean_ticker)),
                "member": row["member"],
                "account": account_label(row["member"], row["account_type"] or "", row["account_name"]),
            }
            for row in transaction_rows
            if row["trade_date"] and row["side"] in {"BUY", "SELL"}
        ],
    }


def _append_market_chart_point(price_record: dict, market_status: dict, points: list[dict]) -> None:
    """공용 시장 스냅샷이 선택한 라이브 가격을 차트 마지막 점으로 추가한다."""
    if not market_status.get("use_live"):
        return
    value = price_record.get("price")
    if value is None:
        return
    today = datetime.now(US_EASTERN).strftime("%Y-%m-%d")
    last_close = points[-1]["close"] if points else None
    if last_close is None or abs(float(value) - last_close) > 1e-9:
        points.append(
            {
                "date": today,
                "close": float(value),
                "live": True,
                "extended": bool(market_status.get("include_extended")),
            }
        )


PERFORMANCE_INDEXES = ("SP500", "NASDAQ", "KOSPI")
PERFORMANCE_RANGE_MONTHS = {
    "1m": 1,
    "6m": 6,
    "1y": 12,
    "3y": 36,
    "5y": 60,
}


def performance_date_bounds(
    range_key: str | None,
    start: str | None = None,
    end: str | None = None,
) -> tuple[str | None, str | None]:
    if range_key == "custom":
        start_date = parse_iso_date(start)
        end_date = parse_iso_date(end)
        if not start_date or not end_date or start_date > end_date:
            raise ValueError("invalid performance date range")
        return start_date.isoformat(), end_date.isoformat()
    today = today_kst()
    if range_key == "ytd":
        return f"{today.year:04d}-01-01", None
    months = PERFORMANCE_RANGE_MONTHS.get(str(range_key or "").lower())
    return (shift_months(today, -months).isoformat(), None) if months else (None, None)


def load_account_performance(
    account_ids: list[str] | None = None,
    *,
    detail: bool = False,
    range_key: str | None = None,
    start: str | None = None,
    end: str | None = None,
) -> dict:
    cleaned_account_ids = clean_account_ids(account_ids)
    account_filter, params = account_filter_clause(cleaned_account_ids)
    start_date, end_date = performance_date_bounds(range_key, start, end)

    with connect() as conn:
        prices = latest_prices(conn)
        account_rows = conn.execute(
            f"""
            SELECT a.id, a.member, a.account_type, a.name
            FROM accounts a
            {account_filter}
            ORDER BY a.id
            """,
            params,
        ).fetchall()
        holding_rows = load_holding_rows(conn, cleaned_account_ids, positive_only=True)

        holdings = [
            {
                "account_id": str(row["account_id"]),
                "ticker": row["ticker"],
                "name": row["name"] or row["ticker"],
                "qty": float(row["qty"] or 0),
                "currency": row["currency"] or ticker_currency(row["ticker"]),
            }
            for row in holding_rows
            if row["ticker"] and float(row["qty"] or 0) > 0
        ]
        tickers = sorted({row["ticker"] for row in holdings})
        price_rows = []
        seed_rows = []
        if tickers:
            placeholders = ",".join("?" for _ in tickers)
            date_conditions = []
            date_params: list[object] = []
            if start_date:
                date_conditions.append("date >= ?")
                date_params.append(start_date)
                seed_rows = conn.execute(
                    f"""
                    SELECT p.ticker, p.close
                    FROM daily_prices p
                    JOIN (
                        SELECT ticker, MAX(date) AS date
                        FROM daily_prices
                        WHERE ticker IN ({placeholders}) AND close IS NOT NULL AND date < ?
                        GROUP BY ticker
                    ) seed ON seed.ticker = p.ticker AND seed.date = p.date
                    """,
                    [*tickers, start_date],
                ).fetchall()
            if end_date:
                date_conditions.append("date <= ?")
                date_params.append(end_date)
            date_sql = f"AND {' AND '.join(date_conditions)}" if date_conditions else ""
            price_rows = conn.execute(
                f"""
                SELECT date, ticker, close
                FROM daily_prices
                WHERE ticker IN ({placeholders})
                  AND close IS NOT NULL
                  {date_sql}
                ORDER BY date, ticker
                """,
                [*tickers, *date_params],
            ).fetchall()

        index_tickers = list(PERFORMANCE_INDEXES)
        placeholders = ",".join("?" for _ in index_tickers)
        index_conditions = []
        index_params: list[object] = []
        if start_date:
            index_conditions.append("date >= ?")
            index_params.append(start_date)
        if end_date:
            index_conditions.append("date <= ?")
            index_params.append(end_date)
        index_date_sql = f"AND {' AND '.join(index_conditions)}" if index_conditions else ""
        index_rows = conn.execute(
            f"""
            SELECT date, ticker, close
            FROM daily_prices
            WHERE ticker IN ({placeholders})
              AND close IS NOT NULL
              {index_date_sql}
            ORDER BY ticker, date
            """,
            [*index_tickers, *index_params],
        ).fetchall()

    rates = fx_rates(prices)   # FX_TICKERS 기반 전 통화 — 수동 dict는 CNY/TWD 누락 버그가 있었다
    available_tickers = {row["ticker"] for row in price_rows} | {row["ticker"] for row in seed_rows}
    holding_specs = [
        {
            **holding,
            "rate": rates.get(holding["currency"], 1.0),
        }
        for holding in holdings
        if holding["ticker"] in available_tickers
    ]
    tickers = sorted({holding["ticker"] for holding in holding_specs})
    account_names = {
        str(row["id"]): f"{row['member']} · {account_label(row['member'], row['account_type'], row['name'])}"
        for row in account_rows
    }
    account_specs: dict[str, list[dict]] = {}
    for holding in holding_specs:
        account_specs.setdefault(holding["account_id"], []).append(holding)

    latest_by_ticker: dict[str, float] = {
        row["ticker"]: float(row["close"])
        for row in seed_rows
    }
    points = []
    account_points: dict[str, list[dict]] = (
        {account_id: [] for account_id in account_specs} if detail else {}
    )
    for date, rows_iter in groupby(price_rows, key=lambda row: row["date"]):
        for row in rows_iter:
            latest_by_ticker[row["ticker"]] = float(row["close"])
        if tickers and all(ticker in latest_by_ticker for ticker in tickers):
            value = sum(
                holding["qty"] * latest_by_ticker[holding["ticker"]] * holding["rate"]
                for holding in holding_specs
            )
            if value > 0:
                points.append({"date": date, "value": value})
        if detail:
            for account_id, specs in account_specs.items():
                account_tickers = {spec["ticker"] for spec in specs}
                if account_tickers and all(ticker in latest_by_ticker for ticker in account_tickers):
                    value = sum(
                        spec["qty"] * latest_by_ticker[spec["ticker"]] * spec["rate"]
                        for spec in specs
                    )
                    if value > 0:
                        account_points[account_id].append({"date": date, "value": value})

    indexes: dict[str, dict] = {}
    for ticker, rows_iter in groupby(index_rows, key=lambda row: row["ticker"]):
        indexes[ticker] = {
            "ticker": ticker,
            "name": MARKET_INDEXES.get(ticker, {}).get("name", ticker),
            "points": [
                {"date": row["date"], "value": float(row["close"])}
                for row in rows_iter
            ],
        }

    return {
        "accounts": [
            {
                "id": str(row["id"]),
                "member": row["member"],
                "name": account_label(row["member"], row["account_type"], row["name"]),
            }
            for row in account_rows
        ],
        "holdings_count": len(holding_specs),
        "points": points,
        "account_series": [
            {
                "id": account_id,
                "name": account_names.get(account_id, account_id),
                "points": account_points[account_id],
            }
            for account_id in account_names
            if len(account_points.get(account_id, [])) >= 2
        ] if detail else [],
        "indexes": indexes,
    }

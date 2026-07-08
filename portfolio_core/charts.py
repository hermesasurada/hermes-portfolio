from __future__ import annotations

from datetime import datetime
from itertools import groupby

from .constants import MARKET_INDEXES
from .db import connect, ensure_daily_technical_indicators_table
from .paths import US_EASTERN
from .prices import fx_rates, latest_prices
from .queries import account_filter_clause, clean_account_ids, load_holding_rows
from .tickers import account_label, is_us_stock_ticker, ticker_currency
from .us_live_quotes import fetch_us_live_quotes, us_market_status


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
        ensure_daily_technical_indicators_table(conn)
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

    currency = meta["currency"] if meta and meta["currency"] else ticker_currency(clean_ticker)
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
    _append_live_chart_point(clean_ticker, currency, points)

    return {
        "ticker": clean_ticker,
        "name": (meta["name"] if meta and meta["name"] else clean_ticker),
        "currency": currency,
        "category": (meta["category"] if meta else None),
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


def _append_live_chart_point(ticker: str, currency: str, points: list[dict]) -> None:
    """US 종목이면 야후 라이브쿼트(정규장=실시간, 장외=연장가)를 차트 마지막 점으로 추가.
    포트폴리오 로드가 채워둔 600s 캐시를 재사용하므로 추가 네트워크는 대부분 없음."""
    if not is_us_stock_ticker(ticker, currency):
        return
    try:
        regular = bool(us_market_status().get("is_regular"))
        quotes = fetch_us_live_quotes([ticker], include_extended=not regular, regular_hours=regular)
        quote = quotes.get(ticker) or quotes.get(ticker.upper())
        if not quote:
            return
        extended_price = quote.get("extended_price")
        live_price = quote.get("price")
        today = datetime.now(US_EASTERN).strftime("%Y-%m-%d")
        last_close = points[-1]["close"] if points else None
        if not regular and extended_price is not None:
            value, extended = float(extended_price), True       # 장외(프리/애프터) 가격
        elif regular and live_price is not None:
            value, extended = float(live_price), False           # 정규장 실시간
        else:
            return
        if last_close is None or abs(value - last_close) > 1e-9:
            points.append({"date": today, "close": value, "live": True, "extended": extended})
    except Exception as exc:  # noqa: BLE001 — best-effort live overlay
        print(f"[chart] live point failed for {ticker}: {exc}")


def load_account_performance(account_ids: list[str] | None = None) -> dict:
    cleaned_account_ids = clean_account_ids(account_ids)
    account_filter, params = account_filter_clause(cleaned_account_ids)

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
        if tickers:
            placeholders = ",".join("?" for _ in tickers)
            price_rows = conn.execute(
                f"""
                SELECT date, ticker, close
                FROM daily_prices
                WHERE ticker IN ({placeholders})
                  AND close IS NOT NULL
                ORDER BY date, ticker
                """,
                tickers,
            ).fetchall()

        index_tickers = list(MARKET_INDEXES.keys())
        placeholders = ",".join("?" for _ in index_tickers)
        index_rows = conn.execute(
            f"""
            SELECT date, ticker, close
            FROM daily_prices
            WHERE ticker IN ({placeholders})
              AND close IS NOT NULL
            ORDER BY ticker, date
            """,
            index_tickers,
        ).fetchall()

    rates = fx_rates(prices)   # FX_TICKERS 기반 전 통화 — 수동 dict는 CNY/TWD 누락 버그가 있었다
    first_prices: dict[str, float] = {}
    for row in price_rows:
        first_prices.setdefault(row["ticker"], float(row["close"]))
    priced_tickers = set(first_prices)
    holding_specs = [
        {
            **holding,
            "rate": rates.get(holding["currency"], 1.0),
        }
        for holding in holdings
        if holding["ticker"] in priced_tickers
    ]
    tickers = sorted({holding["ticker"] for holding in holding_specs})
    account_names = {
        str(row["id"]): f"{row['member']} · {account_label(row['member'], row['account_type'], row['name'])}"
        for row in account_rows
    }
    account_specs: dict[str, list[dict]] = {}
    for holding in holding_specs:
        account_specs.setdefault(holding["account_id"], []).append(holding)

    contributor_specs: dict[str, dict] = {}
    for holding in holding_specs:
        spec = contributor_specs.setdefault(
            holding["ticker"],
            {
                "ticker": holding["ticker"],
                "name": holding.get("name") or holding["ticker"],
                "currency": holding["currency"],
                "qty": 0.0,
                "rate": holding["rate"],
                "points": [],
            },
        )
        spec["qty"] += holding["qty"]

    latest_by_ticker: dict[str, float] = dict(first_prices)
    points = []
    account_points: dict[str, list[dict]] = {account_id: [] for account_id in account_specs}
    for date, rows_iter in groupby(price_rows, key=lambda row: row["date"]):
        for row in rows_iter:
            latest_by_ticker[row["ticker"]] = float(row["close"])
            spec = contributor_specs.get(row["ticker"])
            if spec:
                spec["points"].append(
                    {
                        "date": row["date"],
                        "value": float(row["close"]) * spec["qty"] * spec["rate"],
                    }
                )
        if tickers and all(ticker in latest_by_ticker for ticker in tickers):
            value = sum(
                holding["qty"] * latest_by_ticker[holding["ticker"]] * holding["rate"]
                for holding in holding_specs
            )
            if value > 0:
                points.append({"date": date, "value": value})
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
        ],
        "contributors": [
            {
                "ticker": spec["ticker"],
                "name": spec["name"],
                "currency": spec["currency"],
                "qty": spec["qty"],
                "points": spec["points"],
            }
            for spec in contributor_specs.values()
            if len(spec["points"]) >= 2
        ],
        "indexes": indexes,
    }

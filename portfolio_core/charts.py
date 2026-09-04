from __future__ import annotations

from datetime import date, datetime
from itertools import groupby

from .constants import MARKET_INDEXES
from .dates import parse_iso_date, today_kst
from .db import connect
from .indicators import rsi_series, shift_months
from .market_calendar import holiday_change_session_note
from .paths import US_EASTERN
from .prices import build_market_snapshot, latest_prices, price_view
from .queries import account_filter_clause, clean_account_ids, load_holding_rows
from .technical_stats import price_adjusted_rows
from .tickers import account_label, ticker_currency
from .entry_reward import is_leveraged_product
from .entry_reward_history import entry_score_series
from .performance_snapshots import twr_index
from .us_live_quotes import us_market_status


PRICE_CHART_RANGE_MONTHS = {
    "1m": 1,
    "3m": 3,
    "6m": 6,
    "1y": 12,
    "3y": 36,
    "5y": 60,
    "10y": 120,
}


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


def price_chart_date_bounds(
    points: list[dict],
    range_key: str | None,
    start: str | None = None,
    end: str | None = None,
) -> tuple[date | None, date | None]:
    """Resolve the requested chart window without changing legacy all-history calls."""
    clean_range = str(range_key or "").strip().lower()
    if clean_range == "custom":
        start_date = parse_iso_date(start)
        end_date = parse_iso_date(end)
        if start_date and end_date and start_date > end_date:
            raise ValueError("chart start must not be after end")
        return start_date, end_date
    if clean_range in {"", "all", "cmax"} or not points:
        return None, None
    last_date = parse_iso_date(points[-1].get("date"))
    if last_date is None:
        return None, None
    if clean_range == "ytd":
        return date(last_date.year, 1, 1), None
    months = PRICE_CHART_RANGE_MONTHS.get(clean_range)
    return (shift_months(last_date, -months), None) if months else (None, None)


def price_chart_points_for_range(
    points: list[dict],
    range_key: str | None,
    start: str | None = None,
    end: str | None = None,
) -> tuple[list[dict], date | None, date | None]:
    start_date, end_date = price_chart_date_bounds(points, range_key, start, end)
    if start_date is None and end_date is None:
        return points, start_date, end_date
    filtered = [
        point
        for point in points
        if (point_date := parse_iso_date(point.get("date"))) is not None
        and (start_date is None or point_date >= start_date)
        and (end_date is None or point_date <= end_date)
    ]
    if str(range_key or "").lower() == "custom":
        return filtered, start_date, end_date
    return (filtered if len(filtered) >= 2 else points[-2:]), start_date, end_date


def date_in_chart_window(value: str | None, start: date | None, end: date | None) -> bool:
    if start is None and end is None:
        return bool(value)
    parsed = parse_iso_date(value)
    return parsed is not None and (start is None or parsed >= start) and (end is None or parsed <= end)


def load_price_chart(
    ticker: str,
    us_extended: bool = False,
    range_key: str | None = None,
    start: str | None = None,
    end: str | None = None,
) -> dict:
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
            SELECT date, open, high, low, close, volume
            FROM daily_prices
            WHERE ticker = ? AND close IS NOT NULL
            ORDER BY date
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
        include_extended=us_extended,
        market_status=market_status,
    )
    market_view = price_view(clean_ticker, currency, snapshot)
    price_record = market_view["price_record"]
    overlays = _chart_overlay_series(rows)
    rsi_values = rsi_series([float(row["close"]) for row in rows])
    # 레버리지·인버스 ETF는 점수를 내지 않는다(entry_reward.is_leveraged_product 참조).
    entry_scoring = not is_leveraged_product(meta["name"] if meta else None)
    entry_scores = entry_score_series(rows) if entry_scoring else [None] * len(rows)
    points = []
    for row, rsi, entry_score in zip(rows, rsi_values, entry_scores):
        if not row["date"] or row["close"] is None:
            continue
        point = {"date": row["date"], "close": float(row["close"])}
        if entry_score is not None:
            point["entry_score"] = entry_score
        for key in ("open", "high", "low", "volume"):
            if row[key] is not None:
                point[key] = float(row[key])
        if rsi is not None:
            point["rsi"] = rsi
        overlay = overlays.get(row["date"]) or {}
        if any(value is not None for value in overlay.values()):
            point.update({key: value for key, value in overlay.items() if value is not None})
        points.append(point)
    _append_market_chart_point(price_record, snapshot["market_status"], points, rows, entry_scoring)
    history_start = points[0]["date"] if points else None
    history_end = points[-1]["date"] if points else None
    points, window_start, window_end = price_chart_points_for_range(points, range_key, start, end)

    return {
        "ticker": clean_ticker,
        "name": (meta["name"] if meta and meta["name"] else clean_ticker),
        "currency": currency,
        "category": (meta["category"] if meta else None),
        "current_price": market_view["current_price"],
        "price_date": price_record.get("date"),
        "previous_price": market_view["previous_price"],
        "change_session_note": holiday_change_session_note(
            clean_ticker, price_record.get("date")
        ),
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
        "history_start": history_start,
        "history_end": history_end,
        "range": str(range_key or "all").lower(),
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
            and date_in_chart_window(row["trade_date"], window_start, window_end)
        ],
    }


def _append_market_chart_point(
    price_record: dict,
    market_status: dict,
    points: list[dict],
    rows,
    entry_scoring: bool = True,
) -> None:
    """공용 시장 스냅샷이 선택한 라이브 가격을 차트 마지막 점으로 추가한다."""
    if not market_status.get("use_live"):
        return
    value = price_record.get("price")
    if value is None:
        return
    today = datetime.now(US_EASTERN).strftime("%Y-%m-%d")
    last_close = points[-1]["close"] if points else None
    if last_close is None or abs(float(value) - last_close) > 1e-9:
        adjusted_rows = price_adjusted_rows(rows, float(value), today)
        adjusted_rsi = rsi_series([float(row["close"]) for row in adjusted_rows])
        adjusted_overlays = _chart_overlay_series(adjusted_rows)
        existing = next((item for item in reversed(points) if item.get("date") == today), None)
        if existing is not None:
            point = existing
            if market_status.get("include_extended"):
                # 장외가는 현재가·지표에는 반영하되 확정된 정규장 캔들 몸통은 보존한다.
                point["candle_close"] = point["close"]
            else:
                if point.get("high") is not None:
                    point["high"] = max(float(point["high"]), float(value))
                if point.get("low") is not None:
                    point["low"] = min(float(point["low"]), float(value))
            point.update(
                {
                    "close": float(value),
                    "live": True,
                    "extended": bool(market_status.get("include_extended")),
                }
            )
        else:
            point = {
                "date": today,
                "close": float(value),
                "live": True,
                "extended": bool(market_status.get("include_extended")),
            }
        latest_rsi = next((item for item in reversed(adjusted_rsi) if item is not None), None)
        if latest_rsi is not None:
            point["rsi"] = latest_rsi
        # 진입 점수도 RSI처럼 라이브 가격으로 당일 값을 다시 계산한다.
        latest_entry = (
            next((item for item in reversed(entry_score_series(adjusted_rows)) if item is not None), None)
            if entry_scoring else None
        )
        if latest_entry is not None:
            point["entry_score"] = latest_entry
        overlay = adjusted_overlays.get(today) or {}
        point.update(
            {
                key: item
                for key, item in overlay.items()
                if key.startswith("bb_") and item is not None
            }
        )
        if existing is None:
            points.append(point)


PERFORMANCE_INDEXES = ("SP500", "NASDAQ", "KOSPI", "NIKKEI225")
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


def _rebase_twr(points: list[dict]) -> None:
    """구간 첫 점의 twr을 1.0으로 맞춘다."""
    if not points:
        return
    base = float(points[0].get("twr") or 1.0) or 1.0
    for point in points:
        point["twr"] = float(point.get("twr") or 1.0) / base


def load_account_performance(
    account_ids: list[str] | None = None,
    *,
    detail: bool = False,
    range_key: str | None = None,
    start: str | None = None,
    end: str | None = None,
) -> dict:
    """성과차트 데이터 — account_value_snapshots(역산 포지션·거래 재생·일별 환율) 기준.

    예전에는 현재 잔고를 과거에 그대로 고정하고 현재 환율을 곱했다. 이제는
    계좌별 스냅샷을 그대로 읽어 합산한다(조회 시 재계산 없음). 계좌마다 거래
    캘린더가 달라(한국·미국 휴장일) 날짜 합집합 위에서 각 계좌의 마지막 값을
    이월해 더한다. 값은 보유 증권 평가액(KRW). 거래 현금·외부 입출금 누계는
    points에 함께 실어 두어 나중에 현금 포함 성과·TWR을 프런트가 조합할 수 있다.
    """
    cleaned_account_ids = clean_account_ids(account_ids)
    account_filter, params = account_filter_clause(cleaned_account_ids)
    start_date, end_date = performance_date_bounds(range_key, start, end)

    with connect() as conn:
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
        selected = [int(row["id"]) for row in account_rows]
        snapshot_rows = []
        if selected:
            placeholders = ",".join("?" for _ in selected)
            snapshot_rows = conn.execute(
                f"""
                SELECT account_id, date, holdings_value_krw, trade_cash_krw, flow_krw
                FROM account_value_snapshots
                WHERE account_id IN ({placeholders})
                ORDER BY account_id, date
                """,
                selected,
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

    # 계좌별 날짜→값, 그리고 날짜 합집합 위에서 이월 합산
    per_account: dict[str, dict[str, tuple[float, float, float]]] = {}
    for row in snapshot_rows:
        per_account.setdefault(str(row["account_id"]), {})[row["date"]] = (
            float(row["holdings_value_krw"] or 0.0),
            float(row["trade_cash_krw"] or 0.0),
            float(row["flow_krw"] or 0.0),
        )
    all_dates = sorted({d for series in per_account.values() for d in series})
    # 모든 선택 계좌에 값이 생긴 날부터 — 그 전엔 합계가 계좌 일부만 담아 왜곡된다
    coverage_start = max((min(series) for series in per_account.values() if series), default=None)
    carried: dict[str, tuple[float, float, float]] = {}
    points: list[dict] = []
    account_points: dict[str, list[dict]] = {aid: [] for aid in per_account} if detail else {}
    for day in all_dates:
        for aid, series in per_account.items():
            if day in series:
                carried[aid] = series[day]
                if detail:
                    account_points[aid].append({
                        "date": day,
                        "value": series[day][0],
                        "trade_cash": series[day][1],   # 시간가중 체인이 흐름을 알아야 매수가 수익으로 잡히지 않는다
                        "flow": series[day][2],
                    })
        if coverage_start and day < coverage_start:
            continue
        if start_date and day < start_date:
            continue
        if end_date and day > end_date:
            continue
        if len(carried) < len(per_account):
            continue
        value = sum(item[0] for item in carried.values())
        if value > 0:
            points.append({
                "date": day,
                "value": value,
                "trade_cash": sum(item[1] for item in carried.values()),
                "flow": sum(item[2] for item in carried.values()),
            })
    # 시간가중 지수 — 선택 계좌 전부에 현금 입출금이 있으면 정식(외부 흐름만),
    # 아니면 증권 기준(매수·매도를 외부 흐름으로). 체인은 전체 이력에서 잇고
    # 표시 구간 첫 점을 1.0으로 다시 맞춘다(구간 밖 수익률이 안으로 새지 않게).
    has_flows = {aid: any(abs(item[2]) > 1e-9 for item in series.values()) for aid, series in per_account.items()}
    twr_basis = "full" if per_account and all(has_flows.values()) else "securities"
    if points:
        chained = twr_index(points, twr_basis)
        for point, growth in zip(points, chained):
            point["twr"] = growth
        _rebase_twr(points)
    if detail:
        for aid, series in account_points.items():
            for point, growth in zip(series, twr_index(series, "full" if has_flows.get(aid) else "securities")):
                point["twr"] = growth
            # 보유가 생기기 전(입금만 있고 종목은 없던 구간)은 선으로 그리지 않는다 —
            # 합산 points가 value>0부터 시작하는 것과 같은 기준
            held_start = next((p["date"] for p in series if p["value"] > 0), None)
            account_points[aid] = [
                p for p in series
                if (not held_start or p["date"] >= held_start)
                and (not start_date or p["date"] >= start_date)
                and (not end_date or p["date"] <= end_date)
            ]
            _rebase_twr(account_points[aid])

    account_names = {
        str(row["id"]): f"{row['member']} · {account_label(row['member'], row['account_type'], row['name'])}"
        for row in account_rows
    }
    # 비교지수는 계좌 선이 그려지는 구간으로 자른다. 지수는 daily_prices 전체를
    # 들고 있어서(2016~) 기간 '전체'에선 X축이 계좌 이력보다 훨씬 앞에서 시작하고,
    # 프런트가 첫 점 기준으로 리베이스하므로 지수만 다른 출발선에서 그려진다.
    series_starts = [points[0]["date"]] if points else []
    if detail:
        series_starts += [pts[0]["date"] for pts in account_points.values() if pts]
    chart_start = min(series_starts) if series_starts else None
    indexes: dict[str, dict] = {}
    for ticker, rows_iter in groupby(index_rows, key=lambda row: row["ticker"]):
        indexes[ticker] = {
            "ticker": ticker,
            "name": MARKET_INDEXES.get(ticker, {}).get("name", ticker),
            "points": [
                {"date": row["date"], "value": float(row["close"])}
                for row in rows_iter
                if not chart_start or row["date"] >= chart_start
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
        "holdings_count": sum(1 for row in holding_rows if row["ticker"] and float(row["qty"] or 0) > 0),
        "basis": "snapshot",
        "twr_basis": twr_basis,
        "coverage_start": coverage_start,
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

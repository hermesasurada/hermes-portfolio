from __future__ import annotations

from .tickers import normalize_tickers

from datetime import datetime, timedelta

from .db import connect
from .dividend_raise import dividend_raise_status
from .fundamentals import fetch_fundamentals
from .paths import KST
from .prices import build_market_snapshot, latest_prices
from .risk_reward import risk_reward_score
from .technical_stats import (
    PRICE_ADJUSTED_LOOKBACK_DAYS,
    calculate_price_adjusted_indicators,
    load_technical_stats_cache,
)
from .us_live_quotes import us_market_status


def load_stats(tickers: list[str], us_extended: bool = False) -> dict:
    clean_tickers = normalize_tickers(tickers)
    if not clean_tickers:
        return {
            "stats": {},
            "us_extended": bool(us_extended),
            "updated": datetime.now(KST).isoformat(timespec="seconds"),
        }
    market_status = us_market_status()
    apply_extended = bool(
        us_extended
        and not market_status.get("is_regular")
        and not market_status.get("is_closed")
    )
    ticker_rows = []
    prices = {}
    price_rows: dict[str, list] = {ticker: [] for ticker in clean_tickers}
    with connect() as conn:
        technical = load_technical_stats_cache(conn, clean_tickers)
        placeholders_names = ",".join("?" for _ in clean_tickers)
        ticker_meta = {
            row["ticker"]: dict(row)
            for row in conn.execute(
                f"SELECT ticker, name, category FROM tickers WHERE ticker IN ({placeholders_names})",
                clean_tickers,
            )
        }
        ticker_names = {ticker: row["name"] for ticker, row in ticker_meta.items()}
        # The stats tab must stay read-only/low-latency. Fundamental refreshes
        # and RSI/BB/performance refreshes are handled by price/watchlist jobs.
        fundamentals = fetch_fundamentals(conn, clean_tickers, refresh_stale=False)
        raise_status = dividend_raise_status(conn, clean_tickers, datetime.now(KST).date())
        if apply_extended:
            placeholders = ",".join("?" for _ in clean_tickers)
            ticker_rows = conn.execute(
                f"""
                SELECT ticker, COALESCE(NULLIF(display_name, ''), name) AS name, currency
                FROM tickers
                WHERE ticker IN ({placeholders})
                ORDER BY ticker
                """,
                clean_tickers,
            ).fetchall()
            prices = latest_prices(conn, clean_tickers)
            cutoff = (datetime.now(KST).date() - timedelta(days=PRICE_ADJUSTED_LOOKBACK_DAYS)).isoformat()
            rows = conn.execute(
                f"""
                SELECT ticker, date, close, high, low
                FROM daily_prices
                WHERE ticker IN ({placeholders})
                  AND date >= ?
                  AND close IS NOT NULL
                ORDER BY ticker, date
                """,
                [*clean_tickers, cutoff],
            ).fetchall()
            for row in rows:
                price_rows[row["ticker"]].append(row)

    if apply_extended and ticker_rows:
        snapshot = build_market_snapshot(
            prices,
            ticker_rows,
            include_extended=True,
            market_status=market_status,
        )
        if snapshot["market_status"].get("include_extended"):
            for row in ticker_rows:
                ticker = row["ticker"]
                price_record = snapshot["prices"].get(ticker, {})
                current_price = price_record.get("price")
                extended_price = price_record.get("extended_price")
                current_date = price_record.get("date")
                if (
                    current_price is None
                    or extended_price is None
                    or not current_date
                    or float(current_price) != float(extended_price)
                    or not price_rows.get(ticker)
                ):
                    continue
                technical[ticker] = {
                    **technical.get(ticker, {}),
                    **calculate_price_adjusted_indicators(
                        price_rows[ticker],
                        float(current_price),
                        str(current_date),
                    ),
                }

    stats: dict[str, dict] = {}
    for ticker in clean_tickers:
        merged = {
            **technical.get(ticker, {}),
            **fundamentals.get(ticker, {}),
        }
        score, basis, quality = risk_reward_score(
            merged.get("risk_reward"),
            merged.get("asset_class"),
        )
        merged["risk_reward_score"] = score
        merged["risk_reward_basis"] = basis
        merged["risk_reward_quality"] = quality
        merged["dividend_raise"] = raise_status.get(ticker)   # 분기배당 기업 증액 확정·예상(목록 배당율 강조)
        merged.pop("trade_timing", None)   # 매매참고(실험적) 폐지(2026-10-16) — 옛 캐시에 남은 값은 내보내지 않는다
        stats[ticker] = merged

    return {
        "updated": datetime.now(KST).isoformat(timespec="seconds"),
        "us_extended": bool(us_extended),
        "stats": stats,
    }


QUOTE_STATS_PERIODS = ("one_week", "one_month", "three_month", "ytd")


def _quote_stats_round(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 2) if number == number and abs(number) != float("inf") else None


def _quote_stats_from_prices(ticker: str) -> dict:
    """technical cache가 없는 종목(수집 대상 밖) — daily_prices로 같은 함수(calculate_technical_stats)를 바로 돌린다."""
    from .listing_dates import load_listing_dates
    from .technical_stats import TECHNICAL_LOOKBACK_DAYS, calculate_technical_stats

    cutoff = (datetime.now(KST).date() - timedelta(days=TECHNICAL_LOOKBACK_DAYS)).isoformat()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT ticker, date, close, high, low
            FROM daily_prices
            WHERE ticker = ? AND date >= ? AND close IS NOT NULL
            ORDER BY date
            """,
            [ticker, cutoff],
        ).fetchall()
        list_date = load_listing_dates(conn, [ticker]).get(ticker)
    if list_date:
        rows = [row for row in rows if row["date"] >= list_date]
    return calculate_technical_stats(rows) if rows else {}


def empty_quote_stats() -> dict:
    return {
        "rsi": {key: None for key in ("day", "week", "month")},
        "bollinger_pband": {key: None for key in ("day", "week", "month")},
        "performance": {key: None for key in QUOTE_STATS_PERIODS},
    }


def load_quote_stats(ticker: str, us_extended: bool = False) -> dict:
    """티커칩 시세 팝오버(wm·sa·td·xw)용 RSI·BB·기간 등락률 — /api/chart 응답의 quote_stats(2026-11-07).

    목록 표와 같은 경로(load_stats: technical cache + 연장 시세 보정)를 쓰므로 포트폴리오 화면과 숫자가 같다.
    performance는 가격 기준(차트 지표 팝업과 같음, 목록 기간 수익률은 배당 포함 performance_tr).
    계산할 수 없는 값은 None.
    """
    clean = normalize_tickers([ticker])
    stats: dict = {}
    if not clean:
        return empty_quote_stats()
    stats = load_stats(clean, us_extended=us_extended)["stats"].get(clean[0]) or {}
    if not isinstance(stats.get("rsi"), dict):
        stats = {**_quote_stats_from_prices(clean[0]), **stats}
    rsi = stats.get("rsi") or {}
    band = stats.get("bollinger_pband") or {}
    performance = stats.get("performance") or {}
    return {
        "rsi": {key: _quote_stats_round(rsi.get(key)) for key in ("day", "week", "month")},
        "bollinger_pband": {key: _quote_stats_round(band.get(key)) for key in ("day", "week", "month")},
        "performance": {key: _quote_stats_round(performance.get(key)) for key in QUOTE_STATS_PERIODS},
    }

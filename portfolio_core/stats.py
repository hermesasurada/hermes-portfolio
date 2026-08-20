from __future__ import annotations

from datetime import datetime, timedelta

from .db import connect
from .fundamentals import fetch_fundamentals
from .paths import KST
from .prices import build_market_snapshot, latest_prices
from .entry_reward import entry_risk_reward_score
from .risk_reward import risk_reward_score
from .technical_stats import (
    PRICE_ADJUSTED_LOOKBACK_DAYS,
    calculate_price_adjusted_indicators,
    load_technical_stats_cache,
)
from .us_live_quotes import us_market_status


def load_stats(tickers: list[str], us_extended: bool = False) -> dict:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
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
        # The stats tab must stay read-only/low-latency. Fundamental refreshes
        # and RSI/BB/performance refreshes are handled by price/watchlist jobs.
        fundamentals = fetch_fundamentals(conn, clean_tickers, refresh_stale=False)
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
                SELECT ticker, date, close
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
        rsi = merged.get("rsi") or {}
        bands = merged.get("bollinger_pband") or {}
        performance = merged.get("performance") or {}
        merged["entry_risk_reward"] = entry_risk_reward_score(
            merged.get("drawdown_52w"),
            merged.get("atr_pct"),
            rsi.get("day"),
            bands.get("day"),
            performance.get("three_month"),
            performance.get("six_month"),
        )
        stats[ticker] = merged

    return {
        "updated": datetime.now(KST).isoformat(timespec="seconds"),
        "us_extended": bool(us_extended),
        "stats": stats,
    }

from __future__ import annotations

from datetime import datetime

from .db import connect
from .fundamentals import fetch_fundamentals
from .paths import KST
from .technical_stats import load_technical_stats_cache


BETA_BENCHMARK = "SP500"   # ^GSPC, daily_prices ticker key
BETA_WINDOW = 180          # rolling trading-day window (참고 stats.py와 동일)


def _returns(closes: list[float]) -> list[float]:
    return [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes)) if closes[i - 1]]


def _beta_pair(stock_returns: list[float], mkt_returns: list[float]) -> tuple[float | None, float | None]:
    """β = cov(stock, mkt)/var(mkt) (시장회귀 베타),
    β″ = std(stock)/std(mkt) (상대변동성 = 수정베타)."""
    n = min(len(stock_returns), len(mkt_returns))
    if n < 30:
        return None, None
    sr, mr = stock_returns[-n:], mkt_returns[-n:]
    mean_s = sum(sr) / n
    mean_m = sum(mr) / n
    var_m = sum((x - mean_m) ** 2 for x in mr) / n
    var_s = sum((x - mean_s) ** 2 for x in sr) / n
    if var_m <= 0:
        return None, None
    cov = sum((sr[i] - mean_s) * (mr[i] - mean_m) for i in range(n)) / n
    beta = round(cov / var_m, 2)
    beta_adj = round((var_s ** 0.5) / (var_m ** 0.5), 2)
    return beta, beta_adj


def load_beta_stats(conn, tickers: list[str]) -> dict[str, dict]:
    """종목별 β(시장회귀)·β″(상대변동성)을 daily_prices에서 직접 산출.
    벤치마크는 S&P500(^GSPC). 네트워크 불필요, 항상 최신."""
    bench_rows = conn.execute(
        "SELECT date, close FROM daily_prices WHERE ticker = ? AND close IS NOT NULL ORDER BY date DESC LIMIT 400",
        (BETA_BENCHMARK,),
    ).fetchall()
    if len(bench_rows) < 40:
        return {}
    bench = {row[0]: float(row[1]) for row in bench_rows}
    result: dict[str, dict] = {}
    for ticker in tickers:
        if ticker == BETA_BENCHMARK:
            continue
        rows = conn.execute(
            "SELECT date, close FROM daily_prices WHERE ticker = ? AND close IS NOT NULL ORDER BY date DESC LIMIT 400",
            (ticker,),
        ).fetchall()
        stock = {row[0]: float(row[1]) for row in rows}
        common = sorted(set(stock) & set(bench))[-(BETA_WINDOW + 1):]
        if len(common) < 40:
            continue
        beta, beta_adj = _beta_pair(
            _returns([stock[d] for d in common]),
            _returns([bench[d] for d in common]),
        )
        if beta is None and beta_adj is None:
            continue
        result[ticker] = {"beta": beta, "beta_adj": beta_adj}
    return result


def load_stats(tickers: list[str]) -> dict:
    clean_tickers = sorted({ticker.strip().upper() for ticker in tickers if ticker and ticker.strip()})
    if not clean_tickers:
        return {"stats": {}, "updated": datetime.now(KST).isoformat(timespec="seconds")}
    with connect() as conn:
        technical = load_technical_stats_cache(conn, clean_tickers)
        # The stats tab must stay read-only/low-latency. Fundamental refreshes
        # and RSI/BB/performance refreshes are handled by price/watchlist jobs.
        fundamentals = fetch_fundamentals(conn, clean_tickers, refresh_stale=False)
        betas = load_beta_stats(conn, clean_tickers)
    return {
        "updated": datetime.now(KST).isoformat(timespec="seconds"),
        "stats": {
            ticker: {
                **technical.get(ticker, {}),
                **fundamentals.get(ticker, {}),
                **betas.get(ticker, {}),
            }
            for ticker in clean_tickers
        },
    }

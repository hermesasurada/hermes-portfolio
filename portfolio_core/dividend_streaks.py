"""연속 배당 지급·증액 연수 — 미국 상장종목 전용.

지급 연수는 yfinance 전체 배당 이력(상장 이래)로 직접 센다. 연도별 지급
유무만 보므로 정확하다(검증: KO·PG·JNJ 64년, O 32년, T 42년).

증액 연수는 지급 데이터만으로 재현이 안 된다 — 공식 기록은 선언 기준에
스핀오프 승계·수작업 예외가 들어간다(KO 2001년 두 분기 병합지급, XOM
2020~21 동결의 지급시점 배치, ABBV의 애보트 시절 승계). 그래서 공식 값을
주는 StockAnalysis 배당 페이지의 infoTable.years를 1순위로 쓰고, 그 값이
없을 때만(주로 ETF) 연도별 회차 중앙값 비교로 근사한다.

값이 연 단위로 변하므로 REFRESH_DAYS 스로틀을 두고 배당 일배치에 편승한다.
"""

from __future__ import annotations

import re
import time
import urllib.error
from datetime import datetime
from statistics import median

from .db import connect, ensure_stats_cache_table
from .dividend_sources import STOCKANALYSIS_HEADERS, _fetch_text
from .paths import KST
from .tickers import asset_class

REFRESH_DAYS = 7
# yfinance 배당 이력은 1962년(CRSP 데이터 시작)보다 과거로 가지 않는다.
# 스트릭이 그 언저리 첫 해까지 닿으면 실제로는 더 길 수 있다 → '이상' 표기.
YF_HISTORY_FLOOR_YEAR = 1965
GROWTH_EPSILON = 1.005  # 분할조정 반올림 노이즈를 인상으로 세지 않는 문턱


def us_streak_candidates(conn) -> list[tuple[str, bool]]:
    """미국 상장 주식·ETF(접미사 없는 USD 종목). (ticker, is_etf) 쌍."""
    return [
        (row["ticker"], asset_class(row["ticker"], row["name"] or "") == "etf")
        for row in conn.execute(
            """
            SELECT ticker, name FROM tickers
            WHERE category = 'overseas' AND COALESCE(currency, '') = 'USD'
              AND ticker NOT LIKE '%.%'
            ORDER BY ticker
            """
        )
    ]


def streaks_from_yearly(yearly: dict[int, list[float]], current_year: int) -> dict:
    """연도별 지급액 리스트 → 지급/증액 스트릭. 판정은 완결 연도(작년)까지."""
    if not yearly:
        return {"pay_years": None, "pay_floor": 0, "growth_years": None}
    med = {year: median(values) for year, values in yearly.items() if values}
    first_year = min(yearly)
    last_done = current_year - 1

    pay = 0
    year = last_done
    while year in yearly and sum(yearly[year]) > 0:
        pay += 1
        year -= 1
    pay_floor = int(pay > 0 and (last_done - pay + 1) <= first_year <= YF_HISTORY_FLOOR_YEAR)

    growth = 0
    year = last_done
    # 작년 지급이 없으면(배당 중단: INTC 2024) 두 스트릭 모두 0에서 시작한다.
    while year in med and year - 1 in med and med[year] > med[year - 1] * GROWTH_EPSILON:
        growth += 1
        year -= 1
    return {"pay_years": pay or None, "pay_floor": pay_floor, "growth_years": growth}


def _yearly_dividends(ticker: str) -> dict[int, list[float]]:
    import yfinance as yf

    series = yf.Ticker(ticker).dividends
    yearly: dict[int, list[float]] = {}
    if series is None or len(series) == 0:
        return yearly
    for stamp, amount in series.items():
        value = float(amount)
        if value > 0:
            yearly.setdefault(stamp.year, []).append(value)
    return yearly


def fetch_sa_growth_years(ticker: str) -> float | None | str:
    """StockAnalysis infoTable의 연속 증액 연수. 'missing'이면 페이지 없음."""
    for kind in ("stocks", "etf"):
        url = f"https://stockanalysis.com/{kind}/{ticker.lower()}/dividend/"
        try:
            html = _fetch_text(url, STOCKANALYSIS_HEADERS)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue
            raise
        match = re.search(r'years:"([^"]*)"', html)
        if not match:
            continue
        text = match.group(1).strip().lower()
        if text in {"n/a", "-", ""}:
            # 개별주 페이지의 n/a는 '증액 스트릭 없음'(MMM·T 삭감 이력)이지만,
            # ETF 페이지는 이 값을 아예 제공하지 않아 항상 n/a다(SCHD 실측)
            # → ETF는 자체계산 폴백.
            return 0.0 if kind == "stocks" else "missing"
        try:
            return float(text)
        except ValueError:
            continue
    return "missing"


def reconcile_pay_with_growth(pay_years, pay_floor, growth_years):
    """증액 연수가 지급 연수보다 길 수 없다 — 증액했다면 그 해에 지급도 한 것.

    지급은 yfinance 이력(상장·데이터 한계에 잘림), 증액은 SA 공식 기록
    (스핀오프 이전 승계 포함)이라 소스 기준이 달라 모순이 생긴다
    (ABBV: yf 지급 13년 vs 공식 증액 54년). 증액 기록을 지급의 하한
    증거로 삼아 끌어올리고, 실제로는 더 길 수 있으므로 '+'를 붙인다.
    """
    if pay_years is None or growth_years is None:
        return pay_years, pay_floor
    if growth_years > pay_years:
        return float(growth_years), 1
    return pay_years, pay_floor


def refresh_dividend_streaks(max_age_days: int = REFRESH_DAYS, pause_seconds: float = 0.25) -> int:
    """미국 상장종목의 연속 지급·증액 연수를 갱신한다. 갱신한 종목 수 반환."""
    now = datetime.now(KST)
    with connect() as conn:
        ensure_stats_cache_table(conn)
        candidates = us_streak_candidates(conn)
        stale: list[tuple[str, bool]] = []
        for ticker, is_etf in candidates:
            row = conn.execute(
                "SELECT streaks_fetched_at FROM ticker_stats_cache WHERE ticker = ?",
                (ticker,),
            ).fetchone()
            fetched_at = row["streaks_fetched_at"] if row else None
            if fetched_at:
                try:
                    age = now - datetime.fromisoformat(fetched_at)
                    if age.days < max_age_days:
                        continue
                except ValueError:
                    pass
            stale.append((ticker, is_etf))

    updated = 0
    for ticker, is_etf in stale:
        try:
            yearly = _yearly_dividends(ticker)
            streaks = streaks_from_yearly(yearly, now.year)
            growth = streaks["growth_years"]
            # SA 공식 값은 개별주만 — ETF 페이지는 years를 제공하지 않아(n/a)
            # '스트릭 없음'과 구분이 안 된다(SCHD 실측). ETF는 자체계산 유지.
            if yearly and not is_etf:
                official = fetch_sa_growth_years(ticker)
                if official != "missing" and official is not None:
                    growth = official
            streaks["pay_years"], streaks["pay_floor"] = reconcile_pay_with_growth(
                streaks["pay_years"], streaks["pay_floor"], growth
            )
        except Exception as exc:  # noqa: BLE001 — 종목 하나가 전체를 막지 않게
            print(f"  x {ticker} streaks: {type(exc).__name__}: {exc}")
            continue
        with connect() as conn:
            conn.execute(
                """
                UPDATE ticker_stats_cache
                SET dividend_streak_years = ?, dividend_streak_floor = ?,
                    dividend_growth_streak_years = ?, streaks_fetched_at = ?
                WHERE ticker = ?
                """,
                (
                    streaks["pay_years"],
                    streaks["pay_floor"],
                    growth if streaks["pay_years"] is not None else None,
                    now.isoformat(timespec="seconds"),
                    ticker,
                ),
            )
            if conn.total_changes == 0:
                # 펀더멘털 캐시 행이 아직 없는 신규 종목 — 스트릭만 먼저 심는다.
                conn.execute(
                    """
                    INSERT OR IGNORE INTO ticker_stats_cache
                      (ticker, version, fetched_ts, fetched_at, source,
                       dividend_streak_years, dividend_streak_floor,
                       dividend_growth_streak_years, streaks_fetched_at)
                    VALUES (?, 0, 0, '', 'unknown', ?, ?, ?, ?)
                    """,
                    (
                        ticker,
                        streaks["pay_years"],
                        streaks["pay_floor"],
                        growth if streaks["pay_years"] is not None else None,
                        now.isoformat(timespec="seconds"),
                    ),
                )
            conn.commit()
        updated += 1
        time.sleep(pause_seconds)
    return updated

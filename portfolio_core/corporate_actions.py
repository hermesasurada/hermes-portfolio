from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Iterable

from .db import connect, ensure_stock_split_tables
from .dates import now_kst_text, parse_iso_date, positive_float
from .paths import KST
from .tickers import normalize_yfinance_symbol

SPLIT_CACHE_HOURS = 24

# 미조정 주당 금액(선언 당시 단위)을 주는 소스 — 이후 분할만큼 소급 나눗셈 필요
UNADJUSTED_DIVIDEND_SOURCES = {"polygon", "nasdaq", "opendart"}


def entitlement_date(event: Any) -> date | None:
    """배당 귀속일 — 기준일 > 배당락일 > 지급일 우선."""
    return (
        parse_iso_date(event["record_date"])
        or parse_iso_date(event["ex_date"])
        or parse_iso_date(event["pay_date"])
    )


def split_adjusted_amount(
    amount: float,
    event_date: date,
    source: str | None,
    splits: list[dict],
) -> tuple[float, float]:
    """미조정 소스의 주당 배당금을 이후 분할 누적비로 나눠 현재 주식 단위로.
    (조정된 금액, 적용 비율) 반환 — daily_prices의 분할보정 가격과 단위 일치."""
    if str(source or "").lower() not in UNADJUSTED_DIVIDEND_SOURCES:
        return amount, 1.0
    factor = 1.0
    for split in splits:
        split_date = parse_iso_date(split["split_date"])
        ratio = positive_float(split["ratio"])
        if split_date and split_date > event_date and ratio:
            factor *= ratio
    return (amount / factor, factor) if abs(factor - 1.0) > 1e-12 else (amount, 1.0)


def dividend_event_information_score(event: Any) -> tuple[int, int]:
    """중복 배당 행 중 기준일·지급일이 더 충실한 행을 고른다."""
    date_fields = sum(
        parse_iso_date(event[field]) is not None
        for field in ("record_date", "pay_date", "declaration_date")
    )
    source_priority = {
        "polygon": 3,
        "nasdaq": 2,
        "stockanalysis": 2,
        "yf-history": 1,
    }.get(str(event["source"] or "").lower(), 0)
    return date_fields, source_priority


def dedupe_dividend_event_rows(event_rows: list, splits: list[dict] | None = None) -> list:
    """소스 간 이중 저장된 같은 배당을 병합한다. 두 유형만:

    ① 교차통화: 같은 배당이 상장지별 통화·하루 차이로 저장(RACE EUR/USD).
       통화가 다르고 귀속일 3일 이내면 병합.
    ② 동일통화: 출처가 다르고 분할보정 후 금액이 사실상 같으며(±1%)
       귀속일 3일 이내면 병합(ETN polygon/yf-history $1.04 하루 차이).

    같은 출처의 근접 배당(COST 특별 $7 + 정기 $0.5, 2일 차)이나 금액이 다른
    근접 분배(DGRW)는 실제 별도 배당이므로 절대 합치지 않는다.
    정보(기준일·지급일)가 더 완전한 행을 남긴다.
    """
    splits = splits or []
    deduped: list = []
    for event in event_rows:
        event_date = entitlement_date(event)
        currency = str(event["currency"] or "").upper()
        source = str(event["source"] or "").lower()
        adjusted, _factor = (
            split_adjusted_amount(float(event["amount"]), event_date, event["source"], splits)
            if event_date is not None and event["amount"] is not None
            else (None, 1.0)
        )
        duplicate_index = None
        for index in range(len(deduped) - 1, -1, -1):
            previous = deduped[index]
            previous_date = entitlement_date(previous)
            if event_date and previous_date and (event_date - previous_date).days > 3:
                break
            if not (event_date and previous_date and abs((event_date - previous_date).days) <= 3):
                continue
            previous_currency = str(previous["currency"] or "").upper()
            if currency and previous_currency and currency != previous_currency:
                duplicate_index = index
                break
            previous_source = str(previous["source"] or "").lower()
            previous_adjusted, _pf = (
                split_adjusted_amount(
                    float(previous["amount"]), previous_date, previous["source"], splits
                )
                if previous["amount"] is not None
                else (None, 1.0)
            )
            if (
                source != previous_source
                and adjusted is not None
                and previous_adjusted is not None
                and previous_adjusted > 0
                and abs(adjusted - previous_adjusted) / previous_adjusted <= 0.01
            ):
                duplicate_index = index
                break
        if duplicate_index is None:
            deduped.append(event)
            continue
        if dividend_event_information_score(event) > dividend_event_information_score(deduped[duplicate_index]):
            deduped[duplicate_index] = event
    return sorted(deduped, key=lambda event: entitlement_date(event) or date.min)


def _split_cache_due(fetched_at: str | None) -> bool:
    if not fetched_at:
        return True
    try:
        fetched = datetime.strptime(fetched_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)
    except ValueError:
        return True
    return datetime.now(KST) - fetched > timedelta(hours=SPLIT_CACHE_HOURS)


def fetch_yahoo_stock_splits(ticker: str) -> list[tuple[str, float]]:
    import yfinance as yf

    symbol = normalize_yfinance_symbol(ticker)
    if not symbol:
        return []
    series = yf.Ticker(symbol).get_splits(period="max")
    if series is None or series.empty:
        return []
    return [
        (index.strftime("%Y-%m-%d"), float(ratio))
        for index, ratio in series.items()
        if ratio is not None and float(ratio) > 0 and abs(float(ratio) - 1.0) > 1e-12
    ]


def refresh_stock_splits(tickers: Iterable[str], force: bool = False) -> dict[str, int]:
    clean_tickers = sorted({str(ticker).strip().upper() for ticker in tickers if str(ticker).strip()})
    if not clean_tickers:
        return {}

    with connect() as conn:
        ensure_stock_split_tables(conn)
        placeholders = ",".join("?" for _ in clean_tickers)
        cache_rows = conn.execute(
            f"""
            SELECT ticker, fetched_at
            FROM ticker_split_cache
            WHERE ticker IN ({placeholders})
            """,
            clean_tickers,
        ).fetchall()
        fetched_at = {row["ticker"]: row["fetched_at"] for row in cache_rows}

    due = [
        ticker for ticker in clean_tickers
        if force or _split_cache_due(fetched_at.get(ticker))
    ]
    results: dict[str, int] = {}
    for ticker in due:
        now = now_kst_text()
        try:
            splits = fetch_yahoo_stock_splits(ticker)
            with connect() as conn:
                ensure_stock_split_tables(conn)
                existing_count = conn.execute(
                    "SELECT COUNT(*) FROM stock_splits WHERE ticker = ?", (ticker,)
                ).fetchone()[0]
                if splits or not existing_count:
                    conn.execute("DELETE FROM stock_splits WHERE ticker = ?", (ticker,))
                    conn.executemany(
                        """
                        INSERT INTO stock_splits
                          (ticker, split_date, ratio, source, fetched_at)
                        VALUES (?, ?, ?, 'yfinance', ?)
                        """,
                        [(ticker, split_date, ratio, now) for split_date, ratio in splits],
                    )
                conn.execute(
                    """
                    INSERT INTO ticker_split_cache (ticker, fetched_at, status)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ticker) DO UPDATE SET
                        fetched_at = excluded.fetched_at,
                        status = excluded.status
                    """,
                    (ticker, now, f"ok:{len(splits)}"),
                )
                conn.commit()
            results[ticker] = len(splits)
        except Exception as exc:
            with connect() as conn:
                ensure_stock_split_tables(conn)
                conn.execute(
                    """
                    INSERT INTO ticker_split_cache (ticker, fetched_at, status)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ticker) DO UPDATE SET
                        fetched_at = excluded.fetched_at,
                        status = excluded.status
                    """,
                    (ticker, now, f"error:{type(exc).__name__}"),
                )
                conn.commit()
            print(f"[splits] {ticker} failed: {type(exc).__name__}: {exc}")
    return results


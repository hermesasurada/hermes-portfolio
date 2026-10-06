from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from typing import Any, Iterable

from .db import connect, ensure_stock_split_tables
from .dates import now_kst_text, parse_iso_date, positive_float
from .paths import KST
from .tickers import normalize_yfinance_symbol

SPLIT_CACHE_HOURS = 24

# 미조정 주당 금액(선언 당시 단위)을 주는 소스 — 이후 분할만큼 소급 나눗셈 필요
UNADJUSTED_DIVIDEND_SOURCES = {"polygon", "nasdaq", "opendart"}

# 야후가 아직 반영하지 않은 분할을 직접 넣은 행(stock_splits.source). 야후 이력(배당·가격)은
# 야후가 아는 분할로만 소급 조정돼 있으므로, 수동 분할은 야후 배당에도 나눗셈을 적용한다.
# 야후가 같은 분할을 반영하면 갱신 때 수동 행을 지운다(refresh_stock_splits).
# 예: 1321.T 1:100(2026-10-05 분할 후 가격 거래 시작) — 야후가 분할 기록 없이 가격만 1/100.
MANUAL_SPLIT_SOURCE = "manual"
MANUAL_SPLIT_MATCH_DAYS = 10   # 야후 분할이 수동 분할과 같은 건으로 볼 날짜 차


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
    unadjusted = str(source or "").lower() in UNADJUSTED_DIVIDEND_SOURCES
    factor = 1.0
    for split in splits:
        if not unadjusted and _split_source(split) != MANUAL_SPLIT_SOURCE:
            continue
        split_date = parse_iso_date(split["split_date"])
        ratio = positive_float(split["ratio"])
        if split_date and split_date > event_date and ratio:
            factor *= ratio
    return (amount / factor, factor) if abs(factor - 1.0) > 1e-12 else (amount, 1.0)


def _split_source(split: Any) -> str:
    try:
        return str(split["source"] or "").lower()
    except (KeyError, IndexError):
        return ""


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


GHOST_WINDOW_DAYS = 5


def _dedupe_preference(event: Any) -> tuple:
    """중복 중 남길 행: 정보가 충실한 행 → 배당락일이 기준일과 맞는 행(CL polygon 2024:
    기준일·지급일이 같은데 배당락일만 3달 앞선 사본이 있다) → 같으면 먼저 온 행."""
    ex_date = parse_iso_date(event["ex_date"])
    record_date = parse_iso_date(event["record_date"])
    ex_gap = abs((record_date - ex_date).days) if ex_date and record_date else 0
    return (*dividend_event_information_score(event), -ex_gap)


def _unadjusted_ghost(event: Any, previous: Any) -> Any | None:
    """규칙 ④: 둘 중 '지급일 없고 금액이 상대의 정수배(≥2)'인 행을 돌려준다. 아니면 None."""
    for ghost, real in ((event, previous), (previous, event)):
        if parse_iso_date(ghost["pay_date"]) is not None or parse_iso_date(real["pay_date"]) is None:
            continue
        ghost_amount = positive_float(ghost["amount"])
        real_amount = positive_float(real["amount"])
        if not ghost_amount or not real_amount:
            continue
        multiple = ghost_amount / real_amount
        if round(multiple) >= 2 and abs(multiple - round(multiple)) / round(multiple) <= 0.005:
            return ghost
    return None


def dedupe_dividend_event_rows(event_rows: list, splits: list[dict] | None = None) -> list:
    """소스 간 이중 저장된 같은 배당을 병합한다. 두 유형만:

    ① 교차통화: 같은 배당이 상장지별 통화·하루 차이로 저장(RACE EUR/USD).
       통화가 다르고 귀속일 3일 이내면 병합.
    ② 동일통화: 출처가 다르고 분할보정 후 금액이 사실상 같으며(±1%)
       귀속일 3일 이내면 병합(ETN polygon/yf-history $1.04 하루 차이).
    ③ 같은 출처의 복제: 금액이 사실상 같고(±1%) 지급일이 같으며(둘 다 있음)
       귀속일 3일 이내면 병합. 야후가 일본 ETF 배당을 배당락일·기준일로 두 번
       준다(1489.T 2024-10-04·07 ¥38 지급 11/15, 2640.T 반기마다).
    ④ 같은 출처의 분할 미반영 유령: 귀속일 5일 이내, 지급일 없는 행의 금액이
       지급일 있는 행의 정수배(2배 이상, ±0.5%)면 미조정 사본으로 보고 버린다
       (1489.T 2023-01-10 ¥145 = 01-06 ¥4.83 × 30, 야후 원본에 있다).

    같은 출처의 근접 배당(COST 특별 $7 + 정기 $0.5, 2일 차)이나 금액이 다른
    근접 분배(DGRW)는 실제 별도 배당이므로 절대 합치지 않는다 — ③은 지급일까지
    같아야 하고, ④는 정확한 정수배에 한쪽만 지급일이 없을 때만이다.
    정보(기준일·지급일)가 더 완전한 행을 남긴다(같으면 먼저 온 = 이른 날짜).
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
        ghost_found = False
        for index in range(len(deduped) - 1, -1, -1):
            previous = deduped[index]
            previous_date = entitlement_date(previous)
            if event_date and previous_date and (event_date - previous_date).days > GHOST_WINDOW_DAYS:
                break
            if not (event_date and previous_date):
                continue
            gap = abs((event_date - previous_date).days)
            previous_source = str(previous["source"] or "").lower()
            if source == previous_source and gap <= GHOST_WINDOW_DAYS:
                ghost = _unadjusted_ghost(event, previous)
                if ghost is not None:
                    if ghost is previous:   # 앞 행이 유령이면 지금 행으로 바꾼다
                        deduped[index] = event
                    ghost_found = True
                    break
            if gap > 3:
                continue
            previous_currency = str(previous["currency"] or "").upper()
            if currency and previous_currency and currency != previous_currency:
                duplicate_index = index
                break
            previous_adjusted, _pf = (
                split_adjusted_amount(
                    float(previous["amount"]), previous_date, previous["source"], splits
                )
                if previous["amount"] is not None
                else (None, 1.0)
            )
            same_amount = (
                adjusted is not None
                and previous_adjusted is not None
                and previous_adjusted > 0
                and abs(adjusted - previous_adjusted) / previous_adjusted <= 0.01
            )
            same_pay_date = (
                parse_iso_date(event["pay_date"]) is not None
                and parse_iso_date(event["pay_date"]) == parse_iso_date(previous["pay_date"])
            )
            if same_amount and (source != previous_source or same_pay_date):
                duplicate_index = index
                break
        if ghost_found:
            continue
        if duplicate_index is None:
            deduped.append(event)
            continue
        if _dedupe_preference(event) > _dedupe_preference(deduped[duplicate_index]):
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
                    "SELECT COUNT(*) FROM stock_splits WHERE ticker = ? AND source != ?",
                    (ticker, MANUAL_SPLIT_SOURCE),
                ).fetchone()[0]
                if splits or not existing_count:
                    conn.execute(
                        "DELETE FROM stock_splits WHERE ticker = ? AND source != ?",
                        (ticker, MANUAL_SPLIT_SOURCE),
                    )
                    # 야후가 수동 분할을 반영했으면 수동 행을 지운다. 야후 배당 이력도 그 분할로
                    # 소급 조정되므로, 배당 캐시를 만료시켜 다음 수집에서 조정된 금액으로 덮게 한다
                    # (그 사이 하루 정도는 미조정 금액이 남을 수 있다).
                    superseded = [
                        row["split_date"] for row in conn.execute(
                            "SELECT split_date FROM stock_splits WHERE ticker = ? AND source = ?",
                            (ticker, MANUAL_SPLIT_SOURCE),
                        ).fetchall()
                        if any(
                            parse_iso_date(row["split_date"]) and parse_iso_date(split_date)
                            and abs((parse_iso_date(row["split_date"]) - parse_iso_date(split_date)).days)
                            <= MANUAL_SPLIT_MATCH_DAYS
                            for split_date, _ratio in splits
                        )
                    ]
                    if superseded:
                        conn.executemany(
                            "DELETE FROM stock_splits WHERE ticker = ? AND split_date = ? AND source = ?",
                            [(ticker, day, MANUAL_SPLIT_SOURCE) for day in superseded],
                        )
                        try:
                            conn.execute("DELETE FROM ticker_dividend_cache WHERE ticker = ?", (ticker,))
                        except sqlite3.OperationalError:   # 배당 캐시 표가 없는 최소 스키마
                            pass
                    conn.executemany(
                        """
                        INSERT OR REPLACE INTO stock_splits
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


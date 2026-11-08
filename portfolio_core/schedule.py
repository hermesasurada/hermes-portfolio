from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta

from .dates import today_kst
from .db import connect
from .dates import shift_months
from .dividend_schedule import consolidated_dividend_events, event_schedule_date
from .earnings_history import collapse_near_earnings_events
from . import company_events, etf_holdings
from .dividend_schedule import parse_date
from .tickers import asset_class, ticker_scope


def _default_logo(ticker: str, _name: str) -> dict[str, str | None]:
    return {"text": ticker[:2].upper(), "url": None}


def _include_schedule_ticker(ticker: str, name: str, category: str | None, currency: str | None) -> bool:
    """한국 ETF도 넣는다(2026-11-08 사용자 지시: 일정 팝업에서 전체/개별/ETF를 고른다). 지수·암호화폐는 뺀다."""
    return ticker_scope(ticker, name, category, currency) in {"kr_stock", "kr_etf", "overseas"}


def _ticker_kind(ticker: str, *names: str | None) -> str:
    """일정 팝업의 개별/ETF 구분. 이름으로 안 잡히는 일본 ETF는 구성종목 수집 결과로 잡는다."""
    if any(asset_class(ticker, name or "") == "etf" for name in names) or ticker in etf_holdings._cache():
        return "etf"
    return "stock"


def load_schedule(
    logo_hint_fn: Callable[[str, str], dict] | None = None,
) -> dict:
    """Return DB-backed earnings and dividend dates for the calendar modal."""
    logo_hint = logo_hint_fn or _default_logo
    today = today_kst()
    first_of_month = today.replace(day=1)
    start = shift_months(first_of_month, -12)
    end = shift_months(first_of_month, 13) - timedelta(days=1)

    with connect() as conn:
        # Schema/backfill run at startup and when earnings are collected. A GET
        # must not acquire the SQLite writer lock, even for INSERT OR IGNORE.
        ticker_rows = conn.execute(
            """
            SELECT t.ticker,
                   COALESCE(NULLIF(t.display_name, ''), t.name, t.ticker) AS name,
                   t.name AS raw_name,
                   t.category,
                   t.currency,
                   t.next_earnings_date,
                   s.market_cap
            FROM tickers t
            LEFT JOIN ticker_stats_cache s ON s.ticker = t.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND t.ticker IS NOT NULL
              AND TRIM(t.ticker) <> ''
            ORDER BY t.ticker
            """
        ).fetchall()
        ticker_rows = [
            row
            for row in ticker_rows
            if _include_schedule_ticker(row["ticker"], row["name"], row["category"], row["currency"])
        ]
        owned = {
            str(row["ticker"]).upper()
            for row in conn.execute(
                """
                SELECT DISTINCT ticker
                FROM holdings
                WHERE COALESCE(qty, 0) > 0
                  AND ticker IS NOT NULL
                """
            ).fetchall()
        }
        earnings_rows = conn.execute(
            """
            SELECT e.ticker, e.earnings_date, e.source, e.observed_at
            FROM earnings_events e
            JOIN tickers t ON t.ticker = e.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND date(e.earnings_date) BETWEEN ? AND ?
            ORDER BY date(e.earnings_date), e.ticker
            """,
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        actual_rows = conn.execute(
            """
            SELECT d.ticker, d.ex_date, d.pay_date, d.amount, d.currency,
                   d.source, d.fetched_at, d.declaration_date, d.record_date
            FROM dividend_events d
            JOIN tickers t ON t.ticker = d.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND date(COALESCE(d.pay_date, d.ex_date)) BETWEEN ? AND ?
            ORDER BY date(COALESCE(d.pay_date, d.ex_date)), d.ticker
            """,
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        history_rows = conn.execute(
            """
            SELECT d.ticker, d.ex_date, d.pay_date, d.amount, d.currency,
                   d.source, d.fetched_at, d.declaration_date, d.record_date
            FROM dividend_events d
            JOIN tickers t ON t.ticker = d.ticker
            WHERE t.category IN ('kr', 'overseas')
              AND d.amount IS NOT NULL
              AND d.amount > 0
            ORDER BY d.ticker, date(COALESCE(d.pay_date, d.ex_date))
            """
        ).fetchall()

    ticker_meta = {
        str(row["ticker"]).upper(): {
            "ticker": str(row["ticker"]).upper(),
            "name": row["name"] or row["ticker"],
            "currency": row["currency"],
            "market_cap_currency": row["currency"],
            "market_cap": row["market_cap"],
            "earnings_date": row["next_earnings_date"],
            "kind": _ticker_kind(str(row["ticker"]).upper(), row["raw_name"], row["name"]),
        }
        for row in ticker_rows
    }
    earnings_rows = collapse_near_earnings_events(
        [dict(row) for row in earnings_rows],
        {
            ticker: meta["earnings_date"]
            for ticker, meta in ticker_meta.items()
            if meta.get("earnings_date")
        },
    )
    earnings = []
    for event in earnings_rows:
        ticker = str(event["ticker"]).upper()
        meta = ticker_meta.get(ticker)
        if not meta:
            continue
        earnings.append(
            {
                **meta,
                "earnings_date": str(event["earnings_date"])[:10],
                "source": event["source"],
                "owned": ticker in owned,
                "logo": logo_hint(ticker, meta["name"]),
            }
        )
    earnings.sort(key=lambda row: (row["earnings_date"], row["ticker"]))

    # 배당은 기준일과 지급일을 나눠 싣는다(2026-11-08 사용자 지시). 기준일은 record_date, 없으면 ex_date.
    # date는 예전 소비자를 위해 지급일(없으면 배당락일)을 그대로 둔다.
    dividends = []
    for event in consolidated_dividend_events(actual_rows, history_rows):
        schedule_date = event_schedule_date(event)
        base_date = parse_date(event.get("record_date") or event.get("ex_date"))
        in_range = [day for day in (schedule_date, base_date) if day and start <= day <= end]
        if not in_range:
            continue
        ticker = str(event["ticker"]).upper()
        meta = ticker_meta.get(ticker)
        if not meta:
            continue
        estimated_source = str(event.get("source") or "").startswith("estimated")
        dividends.append(
            {
                "date": schedule_date.isoformat() if schedule_date else None,
                "pay_date": event["pay_date"] and str(event["pay_date"])[:10],
                "base_date": base_date.isoformat() if base_date else None,
                "base_kind": "record" if event.get("record_date") else "ex",
                "ex_date": event.get("ex_date") and str(event["ex_date"])[:10],
                "ticker": ticker,
                "name": meta["name"],
                "kind": meta["kind"],
                "market_cap_currency": meta["market_cap_currency"],
                "market_cap": meta["market_cap"],
                "owned": ticker in owned,
                "estimated": bool(event.get("pay_date_estimated")),
                "base_estimated": bool(event.get("ex_date_estimated")) or estimated_source,
                "amount": event.get("amount"),
                "currency": event.get("currency"),
                "logo": logo_hint(ticker, meta["name"]),
            }
        )

    dividends.sort(key=lambda row: (row["date"] or row["base_date"], row["ticker"]))
    return {
        "today": today.isoformat(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "earnings": earnings,
        "dividends": dividends,
        "catalysts": _catalysts(ticker_meta, owned, start, end, logo_hint),
    }


def _catalysts(ticker_meta: dict, owned: set[str], start, end, logo_hint) -> list[dict]:
    """증류 리포트의 날짜 확정(일 단위) 촉매. 실적 역주입분(portfolio_db)은 실적 일정과 겹쳐 뺀다.
    근거 감사가 캘린더에서 뺀 사건(calendar_unsupported)도 넣지 않는다. 제목만 싣는다."""
    try:
        companies = company_events._cache().get("companies") or {}
    except Exception:
        return []
    rows = []
    for ticker, entry in companies.items() if isinstance(companies, dict) else ():
        if not isinstance(entry, dict):
            continue
        meta = ticker_meta.get(str(ticker).upper())
        if not meta:
            continue
        for event in entry.get("events") or []:
            if not isinstance(event, dict) or event.get("kind") != "catalyst":
                continue
            if event.get("attribution") == company_events.PORTFOLIO_ATTRIBUTION or event.get("audit") == "calendar_unsupported":
                continue
            if event.get("date_precision") != "day":
                continue
            day = parse_date(event.get("date"))
            if not day or day < start or day > end:
                continue
            rows.append({
                "date": day.isoformat(),
                "ticker": meta["ticker"],
                "name": meta["name"],
                "kind": meta["kind"],
                "market_cap_currency": meta["market_cap_currency"],
                "market_cap": meta["market_cap"],
                "owned": meta["ticker"] in owned,
                "title": company_events_plain(event.get("title")),
                "logo": logo_hint(meta["ticker"], meta["name"]),
            })
    rows.sort(key=lambda row: (row["date"], row["ticker"]))
    return rows


def company_events_plain(text) -> str:
    """볼트 위키링크 [[대상|표시]] → 표시, [[대상]] → 대상"""
    import re
    text = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", str(text or ""))
    return re.sub(r"\[\[([^\]]*)\]\]", r"\1", text).strip()

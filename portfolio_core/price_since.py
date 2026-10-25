"""기준 시각 이후 등락률 묶음 조회 — 지식증류 뷰어(8768)의 '리포트 생성 이후' 열(2026-10-25 사용자 요청).

기준가: 기준 시각(리포트 생성 시각)에 이미 확정돼 있던 마지막 종가. 시장마다 종가가 확정되는 한국 시각이 달라서
(아시아 당일 16:00, 유럽 다음 날 01:00, 미국 다음 날 06:00) 그 시각이 기준 시각보다 앞선 날 중 가장 최근 일자의
daily_prices 종가를 쓴다. 현재가: 보유·차트 화면과 같은 스냅샷(build_market_snapshot — 장중엔 미국·한국 실시간 캐시)의
정규장 가격. 외부 조회는 포트폴리오 서비스가 원래 하던 실시간 캐시 갱신뿐이며 이 함수가 새로 부르는 외부 API는 없다.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from .db import connect
from .paths import KST
from .prices import build_market_snapshot, latest_prices, price_view
from .tickers import normalize_tickers
from .us_live_quotes import us_market_status

MAX_TICKERS = 800
_ASIA = (".KS", ".KQ", ".T", ".HK", ".SS", ".SZ", ".TW", ".TWO", ".SI", ".AX", ".NS", ".BO")
_EUROPE = (".DE", ".PA", ".AS", ".L", ".SW", ".MI", ".MC", ".BR", ".ST", ".CO", ".HE", ".OL", ".VI", ".LS", ".IR", ".F")


def close_lag_hours(ticker: str) -> tuple[int, int]:
    """(종가가 확정되는 날짜 오프셋, 그날의 한국 시각) — 아시아 당일 16시, 유럽 다음 날 1시, 미국 다음 날 6시."""
    upper = (ticker or "").upper()
    if upper.endswith(_ASIA):
        return 0, 16
    if upper.endswith(_EUROPE):
        return 1, 1
    return 1, 6


def base_cutoff_date(ticker: str, since: datetime) -> str:
    """기준 시각에 종가가 확정돼 있던 마지막 '거래일 후보' 날짜(이 날짜 이하의 마지막 종가가 기준가)."""
    local = since.astimezone(KST)
    offset, hour = close_lag_hours(ticker)
    # 날짜 d의 종가 확정 시각 = (d + offset일) hour시. 그 시각 <= since 인 가장 큰 d
    shifted = local - timedelta(hours=hour)
    return (shifted.date() - timedelta(days=offset)).isoformat()


def parse_since(value: str) -> datetime:
    text = (value or "").strip()
    if not text:
        raise ValueError("since is required")
    if len(text) == 10:                       # 날짜만 오면 그날 장 마감 뒤(23:59 KST)로 본다
        return datetime.fromisoformat(text + "T23:59:00+09:00")
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=KST)


def load_price_since(tickers: list[str], since: str) -> dict:
    """{since, as_of, items: {ticker: {base_date, base_price, current_price, current_date, change_pct, currency}}}"""
    moment = parse_since(since)
    clean = normalize_tickers(tickers)[:MAX_TICKERS]
    items: dict[str, dict] = {}
    if not clean:
        return {"since": moment.isoformat(), "as_of": datetime.now(KST).isoformat(timespec="seconds"), "items": items}
    with connect() as conn:
        placeholders = ",".join("?" for _ in clean)
        meta_rows = conn.execute(
            f"""SELECT ticker, COALESCE(NULLIF(display_name, ''), name) AS name, currency, category
                FROM tickers WHERE ticker IN ({placeholders})""",
            clean,
        ).fetchall()
        meta = {row["ticker"]: row for row in meta_rows}
        base: dict[str, tuple[str, float]] = {}
        for ticker in clean:
            row = conn.execute(
                """SELECT date, close FROM daily_prices INDEXED BY idx_daily_prices_ticker_date_desc
                   WHERE ticker = ? AND close IS NOT NULL AND date <= ?
                   ORDER BY date DESC LIMIT 1""",
                (ticker, base_cutoff_date(ticker, moment)),
            ).fetchone()
            if row and row["close"]:
                base[ticker] = (row["date"], float(row["close"]))
        prices = latest_prices(conn, clean)
    snapshot = build_market_snapshot(prices, list(meta.values()), include_extended=False,
                                     market_status=us_market_status())
    for ticker in clean:
        row = meta.get(ticker)
        currency = (row["currency"] if row and row["currency"] else "") or ""
        view = price_view(ticker, currency, snapshot)
        record = view["price_record"] or {}
        current = record.get("regular_price")
        if current is None:
            current = view["current_price"]
        base_date, base_price = base.get(ticker, ("", None))
        change_pct = None
        if current is not None and base_price:
            change_pct = (float(current) / base_price - 1.0) * 100.0
        items[ticker] = {
            "base_date": base_date, "base_price": base_price,
            "current_price": float(current) if current is not None else None,
            "current_date": record.get("date") or "",
            "change_pct": change_pct, "currency": currency,
        }
    return {"since": moment.isoformat(), "as_of": datetime.now(KST).isoformat(timespec="seconds"), "items": items}

from __future__ import annotations

from dataclasses import asdict, dataclass

from .dates import parse_iso_date, positive_float
from .tickers import ticker_currency


@dataclass(frozen=True)
class DividendEvent:
    ticker: str
    ex_date: str
    pay_date: str | None
    amount: float | None
    currency: str
    source: str
    declaration_date: str | None = None
    record_date: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _date_text(value) -> str | None:
    parsed = parse_iso_date(value)
    return parsed.isoformat() if parsed else None


def normalize_dividend_event(ticker: str, raw: dict) -> DividendEvent | None:
    ex_date = _date_text(raw.get("ex_date"))
    if ex_date is None:
        return None
    amount = raw.get("amount")
    return DividendEvent(
        ticker=str(raw.get("ticker") or ticker).strip().upper(),
        ex_date=ex_date,
        pay_date=_date_text(raw.get("pay_date")),
        amount=positive_float(amount) if amount is not None else None,
        currency=str(raw.get("currency") or ticker_currency(ticker)).upper(),
        source=str(raw.get("source") or "unknown").lower(),
        declaration_date=_date_text(raw.get("declaration_date")),
        record_date=_date_text(raw.get("record_date")),
    )


def normalize_dividend_events(ticker: str, events: list[dict]) -> list[dict]:
    """소스별 결과를 저장 가능한 단일 계약으로 정규화하고 병합한다."""
    merged: dict[str, dict] = {}
    for raw in events:
        event = normalize_dividend_event(ticker, raw)
        if event is None:
            continue
        item = event.to_dict()
        previous = merged.get(event.ex_date, {})
        merged[event.ex_date] = {
            **previous,
            **{key: value for key, value in item.items() if value is not None},
        }
    return [merged[key] for key in sorted(merged)]

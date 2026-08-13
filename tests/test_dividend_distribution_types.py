import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_core.dividends import (
    _aggregate_annual_dividends,
    _attributed_history_events,
    _history_year_rows,
)


def _event(ex_date: str, amount: float) -> dict:
    return {
        "record_date": ex_date,
        "ex_date": ex_date,
        "pay_date": ex_date,
        "declaration_date": None,
        "amount": amount,
        "source": "polygon",
    }


def test_tsll_capital_gain_is_an_extra_payment_not_a_regular_dividend():
    rows = [
        _event("2025-03-25", 0.08448),
        _event("2025-06-24", 0.08962),
        _event("2025-09-23", 0.08933),
        _event("2025-12-10", 0.57939),
        _event("2025-12-23", 0.11222),
    ]

    events, _ = _attributed_history_events(rows, "TSLL", False, 5)
    annual = _aggregate_annual_dividends(events)

    assert annual[2025]["payments"] == 4
    assert round(annual[2025]["amount"], 5) == 0.37565
    assert len(annual[2025]["events"]) == 5

    capital_gain = next(event for event in events if event["date"].isoformat() == "2025-12-10")
    assert capital_gain["is_special"] is True
    assert capital_gain["distribution_type"] == "capital_gain"

    payload_rows = _history_year_rows(
        annual,
        {2025: annual[2025]["amount"]},
        {2025},
        4,
        None,
        2026,
        False,
        {2025: 4},
    )
    assert payload_rows[0]["payments"] == 4
    assert payload_rows[0]["total_payments"] == 5
    assert next(
        detail for detail in payload_rows[0]["payments_detail"]
        if detail["ex_date"] == "2025-12-10"
    )["distribution_type"] == "capital_gain"


if __name__ == "__main__":
    test_tsll_capital_gain_is_an_extra_payment_not_a_regular_dividend()
    print("1/1 passed")

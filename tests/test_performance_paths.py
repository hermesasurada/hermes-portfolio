#!/usr/bin/env python3
"""Network-free checks for web compression and range-limited chart payloads."""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_core.charts import price_chart_date_bounds, price_chart_points_for_range
from portfolio_web_server import accepts_gzip, gzip_response_body


def test_accepts_gzip() -> None:
    assert accepts_gzip("gzip, deflate, br")
    assert accepts_gzip("br, *;q=0.5")
    assert not accepts_gzip(None)
    assert not accepts_gzip("br")
    assert not accepts_gzip("gzip;q=0")
    assert not accepts_gzip("*;q=1, gzip;q=0")


def test_gzip_response_body() -> None:
    raw = (b'{"ticker":"NVDA","value":123.45},' * 400)
    compressed, used = gzip_response_body(raw, "application/json; charset=utf-8", "gzip")
    assert used
    assert len(compressed) < len(raw) / 4
    unchanged, used = gzip_response_body(raw, "image/png", "gzip")
    assert not used
    assert unchanged == raw


def test_price_chart_range() -> None:
    first = date(2020, 1, 1)
    points = [
        {"date": (first + timedelta(days=index)).isoformat(), "close": float(index + 1)}
        for index in range(2200)
    ]
    one_year, start, end = price_chart_points_for_range(points, "1y")
    assert start is not None and end is None
    assert 365 <= len(one_year) <= 368
    assert one_year[-1] == points[-1]
    assert len(one_year) < len(points) / 5

    custom, start, end = price_chart_points_for_range(
        points,
        "custom",
        "2021-03-01",
        "2021-03-31",
    )
    assert (start, end) == (date(2021, 3, 1), date(2021, 3, 31))
    assert custom[0]["date"] == "2021-03-01"
    assert custom[-1]["date"] == "2021-03-31"


def test_invalid_custom_range() -> None:
    try:
        price_chart_date_bounds([], "custom", "2026-08-10", "2026-08-01")
    except ValueError:
        return
    raise AssertionError("reversed custom range was accepted")


def main() -> None:
    tests = [value for key, value in sorted(globals().items()) if key.startswith("test_")]
    for test in tests:
        test()
        print(f"  PASS  {test.__name__}")
    print(f"\n{len(tests)}/{len(tests)} passed")


if __name__ == "__main__":
    main()

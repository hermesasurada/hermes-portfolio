"""뉴스 배당 → 임시 배당 이벤트 한 번에(sa 배당선언 + wm 회사 배당 공시, 2026-11-23).

크론 `Portfolio SA Dividends`(80df99c16662, `20,50 * * * *`)가 `scripts/run_collector.sh sa-dividends`로 부른다.
두 출처는 따로 돈다 — 한쪽이 실패해도 다른 쪽은 넣고, 실패가 있으면 종료 코드 1로 래퍼가 전체 출력을 남긴다.

  python3 -m portfolio_core.news_dividends [--days 7] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import sys

from . import sa_dividends, wm_dividends


def main() -> int:
    ap = argparse.ArgumentParser(description="sa·wm 배당 뉴스 → 임시 배당 이벤트")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    out, failed = {}, False
    for name, mod in (("sa", sa_dividends), ("wm", wm_dividends)):
        try:
            out[name] = mod.import_recent(args.days, dry_run=args.dry_run)
        except Exception as exc:  # noqa: BLE001 — 한 출처 실패가 다른 출처를 막지 않게
            out[name] = {"error": f"{type(exc).__name__}: {exc}"}
            failed = True
    print(json.dumps(out, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

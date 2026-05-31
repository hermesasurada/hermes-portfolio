#!/usr/bin/env python3
"""sync_watch_tickers.py — holdings.json에서 신규 티커를 watch_tickers.json에 자동 추가.

watch_tickers.json 구조:
{
  "fx": ["USDKRW", "EURKRW", "JPYKRW"],
  "crypto": ["BTC"],
  "overseas": ["TSLA", "NVDA", ...],
  "kr": ["005930.KS", "000660.KS", ...]
}

규칙:
- holdings에 새 티커 추가 → 자동으로 watch_tickers에 추가
- holdings에서 티커 삭제해도 watch_tickers는 유지 (수동으로만 삭제)
- fx/crypto는 자동 동기화 대상 아님
"""

import json
import sys
from pathlib import Path

DATA_DIR = Path.home() / ".hermes" / "data" / "portfolio_v2"
HOLDINGS_FILE = DATA_DIR / "holdings.json"
WATCH_FILE = DATA_DIR / "watch_tickers.json"


def load_watch() -> dict:
    if WATCH_FILE.exists():
        try:
            return json.loads(WATCH_FILE.read_text())
        except Exception:
            pass
    return {"fx": ["USDKRW", "EURKRW", "JPYKRW"], "crypto": ["BTC"], "overseas": [], "kr": []}


def save_watch(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for key in ("fx", "crypto", "overseas", "kr"):
        if key in data:
            data[key] = sorted(set(data[key]))
    WATCH_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def extract_tickers_from_holdings() -> tuple:
    if not HOLDINGS_FILE.exists():
        print(f"ERROR: {HOLDINGS_FILE} not found")
        sys.exit(1)

    holdings = json.loads(HOLDINGS_FILE.read_text())
    kr, overseas = set(), set()

    for m in holdings.get("members", {}).values():
        for a in m.get("accounts", {}).values():
            for h in a.get("holdings", []):
                t = h["ticker"]
                if t == "BTC":
                    continue
                if t.endswith((".KS", ".KQ")):
                    kr.add(t)
                else:
                    overseas.add(t)

    for s in holdings.get("standalone", {}).values():
        for h in s.get("holdings", []):
            t = h["ticker"]
            if t == "BTC":
                continue
            if t.endswith((".KS", ".KQ")):
                kr.add(t)
            else:
                overseas.add(t)

    return overseas, kr


def main():
    watch = load_watch()
    overseas_from_holdings, kr_from_holdings = extract_tickers_from_holdings()

    added_overseas = overseas_from_holdings - set(watch.get("overseas", []))
    added_kr = kr_from_holdings - set(watch.get("kr", []))

    if added_overseas:
        watch.setdefault("overseas", [])
        watch["overseas"].extend(added_overseas)
        print(f"  + overseas 추가: {sorted(added_overseas)}")

    if added_kr:
        watch.setdefault("kr", [])
        watch["kr"].extend(added_kr)
        print(f"  + kr 추가: {sorted(added_kr)}")

    if added_overseas or added_kr:
        save_watch(watch)
        print(f"✅ watch_tickers.json 업데이트: overseas {len(watch['overseas'])}개, kr {len(watch['kr'])}개")
    else:
        print(f"✅ 변경 없음 — overseas {len(watch.get('overseas', []))}개, kr {len(watch.get('kr', []))}개")


if __name__ == "__main__":
    main()

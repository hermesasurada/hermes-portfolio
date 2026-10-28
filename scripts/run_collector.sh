#!/bin/bash

set -u

job=${1:-}
python=${PORTFOLIO_PYTHON:-/opt/homebrew/bin/python3}
project=${PORTFOLIO_PROJECT:-"$HOME/projects/hermes-portfolio"}
log_dir=${PORTFOLIO_LOG_DIR:-"$HOME/Library/Logs/hermes"}

case "$job" in
  dividends)
    log_name=portfolio-dividends.log
    command=("$python" collect_prices.py --dividends-only)
    ;;
  sa-dividends)
    # SA 배당선언 기사 → 임시 배당 이벤트(2026-10-28, portfolio_core/sa_dividends.py). sa-collect(:00·:30) 뒤.
    log_name=portfolio-sa-dividends.log
    command=("$python" -m portfolio_core.sa_dividends --days 7)
    ;;
  price-crypto)
    log_name=portfolio-price-crypto.log
    command=("$python" collect_quotes.py --category crypto)
    ;;
  price-kr)
    log_name=portfolio-price-kr.log
    command=("$python" collect_quotes.py --category kr)
    ;;
  price-overseas)
    log_name=portfolio-price-overseas.log
    command=("$python" collect_quotes.py --category fx,overseas,index)
    ;;
  price-daily-kr)
    log_name=portfolio-price-daily-kr.log
    command=("$python" collect_prices.py --category kr --skip-dividends --skip-splits)
    ;;
  price-daily-overseas)
    log_name=portfolio-price-daily-overseas.log
    command=("$python" collect_prices.py --category fx,crypto,overseas,index --skip-dividends --skip-splits)
    ;;
  *)
    printf 'Unknown portfolio collector job: %s\n' "$job" >&2
    exit 2
    ;;
esac

mkdir -p "$log_dir"
output=$(
  cd "$project" &&
    "${command[@]}" 2>&1
)
status=$?

# 성공은 한 줄(마지막 출력 줄)만, 실패는 전체 출력을 남긴다 — 분 단위 수집기 로그가 수백 MB로 자라던 것 방지.
if [ "$status" -eq 0 ]; then
  printf '[%s] exit=0 %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$(printf '%s\n' "$output" | grep -v '^$' | tail -1)" >> "$log_dir/$log_name"
else
  {
    printf '\n[%s] exit=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$status"
    printf '%s\n' "$output"
  } >> "$log_dir/$log_name"
fi

if [ "$status" -ne 0 ]; then
  printf '%s\n' "$output"
fi

exit "$status"

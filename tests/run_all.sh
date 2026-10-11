#!/bin/bash
# 전체 테스트 한 번에: python 13 + node 39, 약 6초. 실패한 파일만 FAIL로 찍고 종료 코드로 알린다.
# HOME을 임시 폴더로 바꿔 운영 데이터(~/.hermes)에는 어떤 테스트도 닿지 못하게 한다.
cd "$(dirname "$0")/.." || exit 1
export PYTHONPATH=.
export HOME="$(mktemp -d /tmp/portfolio-test-home.XXXXXX)"
trap 'rm -rf "$HOME"' EXIT
failed=0
for f in tests/test_*.py; do
  if ! out=$(python3 "$f" 2>&1); then failed=$((failed+1)); echo "FAIL $f"; echo "$out" | tail -15; fi
done
for f in tests/test_*.js; do
  if ! out=$(node "$f" 2>&1); then failed=$((failed+1)); echo "FAIL $f"; echo "$out" | tail -15; fi
done
total=$(ls tests/test_*.py tests/test_*.js | wc -l | tr -d ' ')
echo "$((total-failed))/$total files passed"
exit $((failed > 0))

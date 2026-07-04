# Portfolio v2 — 작업 규칙

솔로 프로젝트. 코드는 이 repo, **데이터(DB·로고)는 `~/.hermes/data/`** (stock_history.db).
커밋은 묻지 말고 바로 수행하고 `git push origin main`까지.

## 배포/반영
- **프런트(js/css/html)**: 서버가 no-store로 서빙 → 브라우저 새로고침만으로 반영. `?v=` 캐시버전 금지(효과 0, 관리 부담만).
- **백엔드(.py)**: 라이브 서버 재시작 필요 → `launchctl kickstart -k gui/$(id -u)/com.yhandhs.portfolio-web` (pkill+직접실행 금지 — KeepAlive가 재점유).
- 라이브는 Tailscale `100.109.86.85:8765` (localhost 아님). 테스트: `python3 tests/test_portfolio_core.py` (pytest 불필요).

## 절대 불변 (UI)
- **상승=빨강(`--up`), 하락=파랑(`--down`)** — 한국 관례. 변경 금지.
- **테이블 세로 스크롤바는 숨김, 가로만 표시**: `::-webkit-scrollbar { width:0; height:8px }`.
  - webkit 함정 ①: 축 pseudo(`:vertical`)에 width를 주면 무시됨 — 반드시 `::-webkit-scrollbar`에 width/height.
  - webkit 함정 ②: 표준 `scrollbar-width`/`scrollbar-color`를 선언하면 Chrome이 `::-webkit-scrollbar*` 전체를 무시 → 선언 금지.
- 색상은 CSS 변수 토큰만 사용(하드코딩 hex 지양). 네이버 그린(#03c75a) 등 브랜드색은 예외.

## 프런트 구조 규칙 (classic script, 빌드 없음)
- 티커 링크·배당이력 버튼 클릭은 **app.js의 문서 위임 한 곳**에서만 처리. 렌더 후 개별 addEventListener 재바인딩 금지(리스너 누적 사고 이력).
- 정렬 상태의 단일 진실은 `sortState`. 전역 sortKey/sortDir 부활 금지. 정렬은 `sortRows` 한 곳.
- 관심목록 테이블 고정컬럼은 **CSS sticky만**(detail/dividend는 JS pc-frozen) — 이중 시스템 금지.
- 관심목록 컬럼 폭의 권위는 `<colgroup>`.
- 각 JS 파일 끝의 로드 마커(`window.__loaded`)와 index.html의 부트 검사·에러 배너를 유지할 것. **인라인 스크립트 주석에도 닫는 script 태그 문자열을 절대 쓰지 말 것**(HTML 파서가 태그로 해석해 그 지점에서 잘림).

## 데이터 정합성 규칙 (backend)
- `daily_prices.close`는 **raw 시장 종가**(배당 미조정, `auto_adjust=False`). 성과·기술지표는 가격수익률 기준.
- 분할 보정(`repair_split_adjusted_daily_prices`)은 `stock_splits` 비율만 사용하고, 단절 발견 시 **옛 스케일 연속 구간만** 나눔(역단절에서 멈춤 — "이전 전체 나누기"는 부분 재유입 시 ÷4로 무너지는 실사고 이력).
- 스파이크 가드(`sanitize_price_spikes`)는 "튀었다 복귀"만 제거 — 실제 급락·분할은 보존.
- 두 보정 모두 매 저장 시 **최근 윈도만** 검사(저장분 최소일−30일). 전체 스캔은 백필이 자동 담당.
- FX 환율은 `prices.fx_rates()` 단일 정본(FX_TICKERS 자동 파생) — 수동 dict 재구성 금지(CNY/TWD 누락 사고 이력).
- 수집 스크립트는 `collector_lock`(flock) 필수. cron 겹침 방지.
- DB 접근은 `with connect() as conn:` — connect()는 contextmanager로 close까지 보장(FD 누수 사고 이력).

## 크론/운영
- `collect_quotes.py`(분 단위 시세), `collect_prices.py`(일배치), `collect_prices.py --dividends-only`(배당 일배치), `portfolio_healthcheck.py`.
- 로고: 신규 종목은 hydrate가 자동 수집. 일괄은 `download_portfolio_logos.py`(core cache_logo 위임, 기본 보존 모드). 다크 로고 분류는 `detect_dark_logos.py`(/usr/bin/python3, PIL) — json 갱신 시 mtime으로 자동 반영(재시작 불필요).

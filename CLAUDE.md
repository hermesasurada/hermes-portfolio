# Portfolio v2 — 작업 규칙

솔로 프로젝트. 코드는 이 repo, **데이터(DB·로고)는 `~/.hermes/data/`** (stock_history.db).
커밋은 묻지 말고 바로 수행하고 `git push origin main`까지.

## 배포/반영
- **프런트(js/css/html)**: 서버가 no-store로 서빙 → 브라우저 새로고침만으로 반영. `?v=` 캐시버전 금지(효과 0, 관리 부담만).
- **백엔드(.py)**: 라이브 서버 재시작 필요 → `launchctl kickstart -k gui/$(id -u)/com.yhandhs.portfolio-web` (pkill+직접실행 금지 — KeepAlive가 재점유).
- 라이브는 Tailscale `100.109.86.85:8765`(사용자 기기용). **브라우저 패널 검증은 `http://localhost:8765`로**(서버는 0.0.0.0 바인드라 동일 서비스) — Tailscale IP는 사이트 권한 프롬프트가 작업마다 떠서 자동화가 막힌다. 테스트: `python3 tests/test_portfolio_core.py` (pytest 불필요).

## 절대 불변 (UI)
- **상승=빨강(`--up`), 하락=파랑(`--down`)** — 한국 관례. 변경 금지.
- **테이블 세로 스크롤바는 숨김, 가로만 표시**: `::-webkit-scrollbar { width:0; height:8px }`.
  - webkit 함정 ①: 축 pseudo(`:vertical`)에 width를 주면 무시됨 — 반드시 `::-webkit-scrollbar`에 width/height.
  - webkit 함정 ②: 표준 `scrollbar-width`/`scrollbar-color`를 선언하면 Chrome이 `::-webkit-scrollbar*` 전체를 무시 → 선언 금지.
- 색상은 CSS 변수 토큰만 사용(하드코딩 hex 지양). 네이버 그린(#03c75a) 등 브랜드색은 예외.
- **테마 = '쿨 블루'(2026-08 전면 교체, 사용자 확정)**: 라이트=`--bg #f4f8ff`+화이트 패널+잉크 `#10233f`+브랜드 블루 `#2563eb`, 다크=네이비(`--bg #07111f`). 전서체 산세리프(Pretendard) — 구 Noto Serif KR @font-face는 정적 호환용으로만 보존(헤딩에 재적용 금지). 이전 '따뜻한 서재'(크림/세피아/램프그린, ~0163287) 복귀는 사용자 지시 없이 금지. 글래스 블러(backdrop-filter)·블루 글로우는 현행 유지.

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

## 애널리스트 컨센서스 (외부 서비스 의존)
- 관심목록 '컨센서스' 5컬럼 + 종목 상세화면 하단 블록은 **analyst-reports 서비스(8767)** 의 `/api/quote`에 의존. 대시보드 백엔드가 `127.0.0.1:8767`로 **프록시**(`/api/quote`)해 브라우저 CORS·IP 하드코딩을 없앤다 — 프런트는 `apiFetchQuotes`로 same-origin 호출.
- 8767이 죽어도 프록시가 `{}`를 반환해 **컨센서스만 빠지고 대시보드는 정상**. 공용 로직은 `app-consensus.js`(로드 마커·부트 검사 목록에 포함).
- fx/index/crypto는 컨센서스 없음 → 조회 스킵, 컬럼 자동 숨김. 매수=상승=빨강 관례 유지.
- 상세화면 '리포트 상세' 버튼은 **8767 대시보드의 리포트 모달을 iframe으로 그대로 임베드**(`http://{location.hostname}:8767/?embed=1&ticker=X`). 포팅 아님 — analyst-reports repo `static/index.html`의 임베드 모드(크롬 숨김·해당 티커 모달 자동 오픈·`.ov` 딤 끔)에 의존하므로 그 파일을 지우거나 임베드 분기를 건드리면 깨진다. 닫기는 iframe→`postMessage({type:"ar-modal-close"})`(포트폴리오는 `:8767` origin만 신뢰) → `openReportModal`/`closeReportModal`(app-consensus.js). 8767 모달을 개선하면 여기도 자동 반영.

## 성과 스냅샷 (API만, 화면 미노출 — 2026-09 진행 중)
- `account_value_snapshots`(계좌·일자별 `holdings_value_krw`/`trade_cash_krw`/`flow_krw`)가 성과차트의 정본. 조회 시 재계산 금지 — 다시 만드는 건 **거래 입력·수정·삭제, 현금 입출금 변경, 일배치(당일 점)** 뿐(`performance_snapshots.rebuild_account_snapshots`).
- 기준일 = `accounts.history_start`(없으면 **전 계좌 공통 최초 거래일** — 계좌별로 다르면 합산 차트가 가장 늦은 계좌부터만 그려지므로). 기초 포지션 = **현재 잔고 − 기준일 이후 순거래**로 역산 → 이력이 부분적인 연금 계좌도 재생이 잔고에 도달한다. **거래 수량은 분할 후 기준으로 입력돼 있으므로 분할 환산 금지**(141쌍 대조 실측).
- 성과차트 계좌 선은 **시간가중(TWR)** — `twr_index()`가 일별 수익률을 체인(흐름은 장 시작 유입=분모). 선택 계좌 전부에 현금 입출금이 있으면 정식(외부 흐름만, 총자산=증권+현금, 기준일 현금 0 규약 → 기준일 보유 현금은 기준일자 입금으로 입력), 아니면 증권 기준(매수·매도를 외부 흐름으로). 범례에 기준 표기. **계좌별 시리즈 포인트에도 trade_cash·flow를 실어야 한다**(빠지면 매수가 수익으로 잡혀 +1120% 실사고).
- 현금 입출금은 `account_cash_flows`(입금 +, 출금 −, 계좌 통화 기본)에 넣고, 스냅샷이 그날 환율로 KRW 환산. 엔드포인트: `GET /api/performance/snapshots`, `GET/POST /api/cash-flows`, `POST /api/cash-flows/delete`, `POST /api/performance/rebuild`. 기존 `/api/account-performance`·성과차트 UI는 아직 그대로.

## 크론/운영
- `collect_quotes.py`(분 단위 시세), `collect_prices.py`(일배치), `collect_prices.py --dividends-only`(배당 일배치), `portfolio_healthcheck.py`.
- 로고: 신규 종목은 hydrate가 자동 수집. 일괄은 `download_portfolio_logos.py`(core cache_logo 위임, 기본 보존 모드). 다크 로고 분류는 `detect_dark_logos.py`(/usr/bin/python3, PIL) — json 갱신 시 mtime으로 자동 반영(재시작 불필요).

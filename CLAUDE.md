# Portfolio v2 — 작업 규칙

솔로 프로젝트. 코드는 이 repo, **데이터(DB·로고)는 `~/.hermes/data/`**(stock_history.db). 커밋은 묻지 말고 바로 하고 `git push origin main`까지.
운영 규칙·불변식은 `AGENTS.md`, 각 규칙의 **근거·사고 이력·데이터 보정 기록은 `docs/DECISIONS.md`**(여기선 한 줄 요약만).

## 배포/반영
- 프런트(js/css/html): no-store 서빙 → 새로고침만. `?v=` 캐시버전 금지.
- 백엔드(.py): `launchctl kickstart -k gui/$(id -u)/com.yhandhs.portfolio-web` (pkill 금지 — KeepAlive가 재점유).
- 브라우저 검증은 `http://localhost:8765`(Tailscale IP는 권한 프롬프트로 자동화가 막힌다).
- 테스트: `tests/run_all.sh`(python 13 + node 39, 약 5초, 임시 HOME·임시 DB — 운영 데이터에 닿지 않음). 개별은 저장소 루트에서 `PYTHONPATH=. python3 tests/x.py` / `node tests/x.js`.

## UI 불변
- **상승=빨강(`--up`), 하락=파랑(`--down`)**. 변경 금지.
- 표 세로 스크롤바 숨김·가로만: `::-webkit-scrollbar { width:0; height:8px }`. 축 pseudo에 width 금지, 표준 `scrollbar-width` 선언 금지(webkit이 전체 무시).
- 모바일(≤980px) 표 글자 크기는 `--grid-fs`·`--grid-fs-sub`·`--grid-fs-chip`·`--grid-fs-tiny` 네 변수로만. 개별 px 금지. 테스트 `test_mobile_grid_scale.js`.
- 모바일 표 밀도는 가로 위주: 행 높이 `--list-row-height` 40px 유지, `--col-scale`(0.84)·`--grid-pad-x`로 열을 더 담는다. **`--col-scale`은 계좌표 CSS·관심목록 colgroup·JS 표 전체 폭 세 곳이 함께** 타야 한다. `thead th` 높이 규칙에 `:is()`로 #id 섞지 말 것.
- 색은 CSS 토큰만(브랜드색 예외). 테마 '화이트·슬레이트', 평면, Pretendard. 표·사이드바·히어로 숫자는 `--grid-num-font`(tnum), `--chart-num-font`(Roboto Mono)는 차트 축·툴팁 전용. 카드화 금지.
- 전광판: 세 면(계좌·지수·환율) 한 자리, 점 3개 + 다음 버튼. PC에서 일곱 칸이 들어가면 전부 펼침(`syncHeroLayout`, 실측 판정). 지수·환율 칸은 `repeat(3, minmax(0,1fr))`, 좁은 화면은 세 줄. 환율 칸 등락은 **금액(원)**, 엔화는 **100엔 기준**(`HERO_FX_UNITS`). 칸 클릭은 app.js 문서 위임. 스와이프에 `setPointerCapture`·pointerdown `preventDefault` 금지. 테스트 `test_hero_summary.js`, `test_hero_combined.js`.
- 팝업(`dialog.watch-modal`)은 UA `:modal`의 `position: fixed`에 기댄다 — 전역 `body > :not(dialog)` relative 규칙에 dialog를 다시 넣지 말 것(넣으면 팝업이 문서에 붙어 배경과 함께 스크롤). 열려 있는 동안 `html:has(dialog.watch-modal[open])`이 뒤 화면 스크롤을 잠근다. 팝업 높이는 `100dvh` 기준(100vh는 모바일 주소창만큼 넘친다).
- 관심목록 그룹·종목 편집 컨트롤은 **항상 보인다**(편집 토글 부활 금지). 모바일은 검색 상시, 섹터·통화·지수는 '필터' 버튼으로 접음. 테스트 `test_design_controls.js`.

## 프런트 구조 (classic script, 빌드 없음)
- 티커 링크·배당이력 버튼 클릭은 **app.js 문서 위임 한 곳**. 렌더 안 addEventListener 재바인딩 금지.
- 정렬 단일 진실 `sortState`, 비교는 `compareListRows` 한 곳, 결측 후순위 키는 `MISSING_LAST_SORT_KEYS` 한 목록. 테스트 `test_list_sort.js`.
- 연장 정렬 묶음: 연장가 있음 → 없고 정규장 진행 중 → 없고 장 종료·휴장(`extendedSortTier`, 방향 무관). 테스트 `test_extended_sort.js`.
- 주기 갱신은 `scheduleAutoRefresh` 한 곳. 테스트 `test_auto_refresh.js`.
- 값 없음(null·undefined·"")은 어디서나 null — `Number(null)=0` 함정. `optionalNumber`/`finiteChartNumber`/`finiteMetric` 규칙 동일. 테스트 `test_numeric_missing.js`.
- 거래 수정 시 잔고에 반영됐던 거래의 유형·수량·단가가 바뀌면 `#txEditHoldingsModal`로 한 번 묻는다. 서버는 되돌리기+재적용을 한 트랜잭션으로. 테스트 `test_transaction_edit_holdings.js`.
- 거래내역 API는 전체 이력(200건 제한 금지), 프런트에서 필터 후 20건씩. 테스트 `test_transaction_filter.js`.
- 배당이력 팝업 PC 최소 너비 600px.
- 관심목록 고정열은 CSS sticky만(로고·종목명, 삭제 열 고정 금지). 종목명 `left`는 `--interest-logo-col`. 셀은 `overflow: hidden`, 등락 열은 세션 배지 자리 `padding-right: 9px`.
- 표는 기본 12행 + 헤더만 보이고 안에서 스크롤. 높이는 `syncTableViewportRows()`가 실측(rAF 금지). 테스트 `test_table_viewport_rows.js`.
- 배당 탭: 당월 포함 3개월만 펼침(`dividendMonthCollapsed`), 매달 1~5일은 전월부터 표시(서버 `dividend_list_start`), '오늘' 마커는 지급일<오늘과 그 이후 사이(`isPastPayment`). 배당 수량은 **배당락일 기준 보유분**(`entitled_quantity`, 배당락 뒤 매도는 받고 매수는 못 받음; 미국 거래는 미국 장 날짜로 기록). 테스트 `test_dividend_month_collapse.js`, `test_dividend_today_marker.js`.
- 배당 탭 주당배당금·목록 배당율: 분기배당 개별 기업의 공시 증액=빨강 굵게(그 회차 지급 전이면 파랑 굵게), 공시 전 다음 회차 증액 예상(작년 같은 분기 증액)=주황 굵게(`dividend_raise.py`, 목록은 stats `dividend_raise`). 테스트 `test_dividend_raise.py`, `test_dividend_raise_marker.js`.
- '배당 포함' 토글(`detailStorage.dividendReturns`): 기간 수익률을 서버 `performance_tr`로, 품질 P는 `perfText`가 흐리게. 테스트 `test_dividend_returns.js`.
- 관심목록 스크리닝(`app-interest-screen.js`): 수치 열 조건 최대 5개 AND, 표에 보이는 단위로 입력(소수 보관 열은 %÷100, 시총 B$), 값 없음은 탈락(배당율만 0%), 저장은 `detailStorage.interestScreen`. 테스트 `test_interest_screen.js`.
- **종목 태그**(2026-10-12, `app-ticker-tags.js`·서버 `ticker_tags.py`·표 `ticker_tags`): 종목(티커)마다 자유 태그, 서버 저장이라 기기 공통. 편집은 차트 헤더(태그 칩 + ✎, 입력 `#반도체 #CPU`, 쓰던 태그 제안), 종목당 10개·20자. 필터는 컨트롤 영역 '태그'(섹터와 같은 패널, **선택한 태그 중 하나라도 가진 종목 = OR**)로 세부내역·배당·관심목록에 공통 적용, 선택은 `detailStorage.tagFilter`(이 브라우저). 차트의 태그 칩을 누르면 그 태그로 거른 목록으로 돌아간다. **목록에는 태그를 보이지 않는다**(2026-10-15 사용자 지시 — 칩은 차트 헤더에서만, 차트 헤더의 태그는 로고 밑 별도 행). 수집 대상에서 빼도 태그는 남는다. 테스트 `test_ticker_tags.js`, `test_ticker_tags_clean_store_and_count`.
- 관심목록 컬럼 폭 권위는 `<colgroup>`. 60행 초과 그룹은 창 렌더링(`renderInterestRowsWindow`): 행 높이는 그려진 행 평균, 이름 열 폭은 행 데이터 전체(`syncTickerNameColumnWidth`), 그릴 구간은 목록 길이 안으로, 목록 구성이 바뀌면 스크롤 맨 위. `#interestRows tr` 전수 순회 금지. 테스트 `test_interest_virtual_rows.js`.
- 차트에서 목록으로 돌아오면 스크롤 복원(`rememberListScroll`/`restoreListScroll`). 테스트 `test_list_scroll_restore.js`.
- 휴장일 행 등락금액은 `→0`(`isHolidayPreviousSession`), 환율 적용 시 환율 변동분은 표기. 테스트 `test_holiday_change_amount.js`.
- 차트 툴팁 등락은 `changePercentParts` 공유(SVG는 parts로 조립). 테스트 `test_chart_moving_averages.js`.
- 배당 연속지급·증액 단위는 `Y`(`dividendStreakText`).
- 각 JS 파일 끝 로드 마커 + index.html 부트 검사 유지(기대 목록은 script 태그에서 파생). 인라인 스크립트 주석에 닫는 script 태그 문자열 금지.

### 차트
- 개별종목 차트 헤더: PC는 가격을 종목명 옆에(`.chart-price-summary { margin-right: auto }`).
- 라이브 점(`_append_market_chart_point`)은 `ichi_*`까지 옮긴다. 일목 구름은 색이 바뀌는 봉에서 교차점 공유. 선행 26봉 x축 자리는 구름을 그릴 때만 예약. 테스트 `test_chart_ichimoku.{py,js}`.
- 일목선(따뜻한 색, 계단선)과 이평선(차가운 색)은 **같은 색 금지**(`test_chart_line_distinction.js`). 전환·기준선은 `vector-effect: non-scaling-stroke`로 화면 두께, 980px 이하 0.7. 선 끝 이름표 '전환·기준·20·50·200'은 선행 26봉 자리가 있을 때만.
- 기준선 예상경로: 서버 `_kijun_flat_projection` → `ichi_kijun_flat`, 현재가에 닿는 봉에 'N거래일 뒤'.
- 차트 컨트롤: 980px 이하 두 줄(1줄 형태·단위·기간·매수·매도·?, 2줄 보조지표·이동평균선), 버튼 26px. '?'는 `#chartHelpModal`, **설명 문구는 개조식 명사형**. 모바일 CSS 테스트는 `h.mediaBlocks(css, '(max-width: 980px)')`로 블록 전부를 읽는다.
- 환율 차트는 BB·일목·이평선 사용 안 함(`chartOverlaysApply`, 컨트롤은 disabled). 테스트 `test_fx_chart_overlays.js`.
- 가격축 눈금은 `denseLowerChartScale(values, target, max)`(PC 9/11, 좁은 화면 7/8). 테스트 `test_chart_axis_density.js`.
- RSI 칸 높이는 가격 칸의 보조(모바일 126·PC 67). 끝 눈금이 30·50·70과 15 이내면 숫자 생략, 현재값 표시와 겹치는 눈금 숫자도 생략.

## 데이터 정합성 (backend)
- `daily_prices.close`는 raw 종가(`auto_adjust=False`). 분할 보정은 `stock_splits` 비율로 옛 스케일 연속 구간만. 스파이크 가드는 '튀었다 복귀'만 제거, 이력 맨 앞 1~5행 다른 스케일은 제거, 스케일 변화 뒤에도 검사 계속. 분할 보정은 거래량(×)·adj_close(÷)도 맞춘다.
- 야후가 분할 없이 가격만 바꾼 경우(1321.T) `stock_splits`에 `source='manual'`로 넣는다. 수동 분할은 야후 배당에도 적용되고 야후 갱신이 지우지 않는다.
- 배당 중복 병합(`dedupe_dividend_event_rows`): 교차통화, 이종 출처 같은 금액, **같은 출처라도 금액·지급일 같고 3일 이내**, 5일 이내 정수배 분할 미반영 사본. 저장이 아니라 읽을 때 거른다.
- 미국 종목은 Polygon 상장일(`ticker_listing_dates`, 종목당 한 번) 이전 배당을 버린다(티커 재사용 종목).
- FX 환율은 `prices.fx_rates()` 단일 정본, 야후 심볼은 `fx_yahoo_symbol()` — 손수 사전 금지.
- 수집 스크립트는 `collector_lock` 필수. 일부러 건너뛴 실행(09시 이전 한국)은 `collector_runs`를 기록하지 않는다.
- **한국 휴장 달력(`korean_exchange_holidays`)이 틀리면 데이터가 오염된다**(개장일을 휴장으로 보면 직전 거래일 행을 덮어씀). 대체공휴일: 설날·추석은 일요일·겹침만, 나머지 공휴일은 토·일·겹침. 근로자의 날(5/1)은 KRX 휴장이되 대체 없음. `dividend_schedule`도 이 달력 하나를 쓴다(자체 목록 금지). 테스트 `test_korean_substitute_holidays_follow_public_holiday_rules`, `test_korean_calendar_closes_on_labor_day_*`.
- 평일 09시 이전 한국 실시간 시세는 기록하지 않는다(코스피 개장 전 예상지수). 코스피 일봉은 야후 ^KS11 우선, FDR은 백필만.
- 가격 정체 점검은 같은 거래소가 함께 멈추면 휴장으로 본다(`stale_price_rows`, 12일 초과면 경보).
- DB 접근은 `with connect() as conn:`. 기본 표 DDL은 `portfolio_core/schema.sql`(`ensure_base_tables`).
- β·β″는 같은 기준지수(한국 KODEX 200TR, 그 외 S&P 500). 국내 기준 이력이 없으면 둘 다 결측. 문구는 `format.js` `BETA_TOOLTIP`/`BETA_ADJ_TOOLTIP` 한 곳.
- 변동성 손익비: 비겹침 창 5y/3y/1y 가중 0.4/0.3/0.3, 기간점수(초과수익÷변동성)를 ±2로 자르고 없는 창은 0점(재분배 금지). 자세한 산식은 `risk_reward.py` 모듈 설명.
- 배당 귀속연도는 '최근 인상월 직전' 결산월, 예외는 `FISCAL_END_MONTH_OVERRIDES`(NVDA 3, JPM 9).
- 해외 배당 지급일은 StockAnalysis에서 **빈 칸만** 보강(금액 금지 — 분할 미보정). 코스닥은 `kosdaq`, 복수 종류주는 하이픈→점. 일본만 `estimated_jp_pay_date`로 추정 표시.

## 성과 스냅샷
- 거래·입출금 변경은 `BEGIN IMMEDIATE` 후 같은 연결로 `rebuild_account_snapshots_in_transaction`까지 한 트랜잭션. 조회 시 재계산 금지.
- 기준일 = `accounts.history_start`(없으면 전 계좌 공통 최초 거래일). 기초 포지션은 현재 잔고 − 기준일 이후 순거래 역산. 원장 수량·단가는 일봉과 같은 분할 보정 단위.
- 고정환율 선: 통화별 기준일 환율 r0, 외화 계좌의 원화 입출금은 `amount × r0/r_day`. 범례는 '계좌 · 강조'와 '비교지수' 두 줄, 고정환율 칩은 계좌 줄 끝. 원화 계좌만 선택하면 점선은 생략(실제 선과 같음). 테스트 `test_performance_fixed_fx.js`.
- 비교지수 순서 S&P 500 → 나스닥 → 코스피 → 니케이(`PERF_INDEX_META`), 색은 지수에 고정.
- 계좌 선은 TWR. 선택 계좌 전부에 입출금이 있으면 full, 아니면 securities. **계좌별 시리즈 포인트에도 trade_cash·flow 필수.** 입출금 존재가 데이터 완전성 인증은 아니다.
- 입출금은 만원 단위 원문 ×10,000 KRW, 계좌1 입금도 currency='KRW'. **배당은 성과 계산에 넣지 않는다**(검산 차이를 배당으로 설명하지 말 것). 검산은 전 구간 현금잔고 ≥ 0. 계좌별 보정 이력(현물 증여·보정 입금·원장 대체 등)은 `docs/DECISIONS.md`.
- `scripts/repair_transaction_split_units.py`는 5종목 청산 거래 전용 수동 도구(기본 dry-run).

## 외부 서비스·운영
- 컨센서스는 analyst-reports(8767)를 `/api/quote`로 프록시. 죽으면 `{}` → 컨센서스만 빠진다. '리포트 상세'는 8767 모달을 iframe 임베드(`?embed=1&ticker=`, `postMessage ar-modal-close`).
- 크론: `collect_quotes.py`(분 단위), `collect_prices.py`(일배치·`--dividends-only`), `portfolio_healthcheck.py`. 래퍼 `scripts/run_collector.sh`는 성공 시 한 줄만 로그.
- 로고: 신규 종목은 hydrate 자동, 일괄은 `download_portfolio_logos.py`, 다크 분류 `detect_dark_logos.py`(/usr/bin/python3).

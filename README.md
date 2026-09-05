# hermes-portfolio

다중 계좌·다중 통화 포트폴리오 관리 시스템.

`stock_history.db` 기반으로 보유 종목·거래내역·시세를 관리하고, 로컬 웹 대시보드와
시세 수집기를 제공합니다.

웹 요청은 DB 캐시를 읽고, 가격·기술지표·펀더멘털·배당 갱신은 수집기에서 수행합니다.
시장 가격 해석은 `portfolio_core.prices`의 공용 스냅샷을 사용하며 신규 종목 조회와
데이터 채우기는 각각 `ticker_lookup.py`, `hydration.py`가 담당합니다.

관심목록의 열 순서·헤더·너비·셀 표시는 `portfolio_static/app-interest-columns.js`에서
함께 정의하며, 값이 없는 열은 렌더링하지 않습니다. 일정 조회는 읽기 전용이고
스키마 준비와 실적 이력 보강은 서버 초기화·수집 경로에서 수행합니다.

거래·잔고·현금 입출금 변경과 해당 계좌 성과 스냅샷은 같은 DB 트랜잭션에서
저장합니다. 스냅샷 계산/저장이 실패하면 원장 변경도 롤백됩니다. 일배치·수동
재계산도 읽기 전에 쓰기 잠금을 잡아 동시 거래를 놓친 결과가 덮어써지지 않게 합니다.

## 구성

| 영역 | 파일 |
|------|------|
| 웹 서버 | `portfolio_web_server.py` (HTTP, `ThreadingHTTPServer`) |
| 프런트엔드 | `portfolio_static/` (상태·API·차트 렌더·차트 지표·거래·관심목록을 순수 JS로 분리) |
| 코어 패키지 | `portfolio_core/` (portfolio, transactions, prices, charts, stats, watchlist, logos, db, tickers, constants …) |
| 분 단위 시세 | `collect_quotes.py` (Yahoo/Naver 배치 스냅샷) |
| 일봉·통계 보정 | `collect_prices.py` |
| 유틸 | `download_portfolio_logos.py` |
| 테스트 | `tests/test_portfolio_core.py` (의존성 없이 `python3 tests/test_portfolio_core.py`) |

## 데이터 위치

코드와 분리되어 `~/.hermes/data/` 에 보관됩니다 (`portfolio_core/paths.py`):
- `~/.hermes/data/stock_history.db` — 가격/보유/거래 DB
- `~/.hermes/data/portfolio_v2/` — 로고 캐시, logo_fallbacks.json

## 실행

```bash
# 웹 대시보드 (launchd: com.yhandhs.portfolio-web 로 상시 구동)
python3 portfolio_web_server.py --host 127.0.0.1 --port 8765

# 저호출 현재가 스냅샷 (분 단위 cron)
python3 collect_quotes.py --category fx,crypto,overseas,index
python3 collect_quotes.py --category kr

# 일봉·기술지표·펀더멘털·실적일 보정 (일 배치)
python3 collect_prices.py --category fx,crypto,overseas,index
python3 collect_prices.py --category kr
```

## 테스트

```bash
python3 tests/test_portfolio_core.py
python3 tests/test_refactor_performance.py
python3 tests/test_atomic_writes.py
python3 tests/test_transaction_split_repair.py
node tests/test_interest_columns.js
```

## 과거 거래 단위 보정

`python3 scripts/repair_transaction_split_units.py`는 검토된 LCID·ETHU·SSO·USD·TQQQ의
거래 수량/단가와 분할 보정 일봉의 단위를 점검합니다. 기본은 조회만 수행합니다.
`--apply`는 원본 DB·변경 전 원장을 데이터 폴더의 `backups/`에 보관한 뒤,
거래대금을 보존하며 원장과 해당 계좌 스냅샷을 함께 갱신합니다. 이미 보정된 거래는
유지하며, 모호한 단위나 미청산/불균형 포지션은 거절합니다. 자동 수집용이 아닙니다.

# hermes-portfolio

다중 계좌·다중 통화 포트폴리오 관리 시스템.

`stock_history.db` 기반으로 보유 종목·거래내역·시세를 관리하고, 로컬 웹 대시보드와
시세 수집기를 제공합니다.

## 구성

| 영역 | 파일 |
|------|------|
| 웹 서버 | `portfolio_web_server.py` (HTTP, `ThreadingHTTPServer`) |
| 프런트엔드 | `portfolio_static/` (index.html, app.js, app-charts.js, styles.css …) |
| 코어 패키지 | `portfolio_core/` (portfolio, transactions, prices, charts, stats, watchlist, logos, db, tickers, constants …) |
| 시세 수집 | `collect_prices.py` |
| 유틸 | `download_portfolio_logos.py` |
| 테스트 | `tests/test_portfolio_core.py` (의존성 없이 `python3 tests/test_portfolio_core.py`) |

## 데이터 위치

코드와 분리되어 `~/.hermes/data/` 에 보관됩니다 (`portfolio_core/paths.py`):
- `~/.hermes/data/stock_history.db` — 가격/보유/거래 DB
- `~/.hermes/data/portfolio_v2/` — 로고 캐시, price_cache.json, logo_fallbacks.json

## 실행

```bash
# 웹 대시보드 (launchd: com.yhandhs.portfolio-web 로 상시 구동)
python3 portfolio_web_server.py --host 127.0.0.1 --port 8765

# 시세 수집 (cron)
python3 collect_prices.py --category fx,crypto,overseas,index
python3 collect_prices.py --category kr
```

## 테스트

```bash
python3 tests/test_portfolio_core.py
```

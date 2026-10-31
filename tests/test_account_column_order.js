const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../portfolio_static', file), 'utf8');
const html = read('index.html');
const table = html.slice(html.indexOf('id="detailTableWrap"'), html.indexOf('id="interestTableWrap"'));
const headers = [...table.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)].map(m => m[0]);
const source = read('app-holdings.js');
const body = source.slice(source.indexOf('<tr class="${tableRowClass(r)}">'), source.indexOf('// 다음 렌더의 펄스'));
const cells = [...body.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)].map(m => m[0]);
assert.equal(headers.length, 43);
assert.equal(cells.length, headers.length);
assert.match(headers[40], /data-key="market_cap_usd">시총\/AUM/);
assert.match(headers[41], /data-key="next_earnings_date">실적일/);
assert.match(headers[42], />거래</);
assert.match(cells[40], /marketCapMarkup\(r\)/);
assert.match(cells[41], /earningsText\(r.next_earnings_date\)/);
assert.match(cells[42], /tx-pick/);
assert.match(headers[9], /dividend_yield/);
assert.match(headers[13], /risk_reward_score/);
assert.match(headers[14], /entry_risk_reward/);
// 매매참고(실험적) 열 폐지(2026-10-16) — 진입손익비 바로 다음이 β
assert.match(headers[15], /data-key="beta"/);
assert.doesNotMatch(html + source, /trade_timing|tradeTimingMarkup/);
assert.match(headers[17], /rsi_day/);
assert.match(headers[22], /bb_month/);
assert.match(headers[23], /ma20_pct/);
assert.match(headers[29], /perf_1w/);
// 추세 수익률(2026-10-23)은 5년 수익률 바로 오른쪽, 10년 앞
assert.match(headers[36], /perf_5y/);
assert.match(headers[37], /data-key="trend_return"/);
assert.match(cells[37], /trendReturnText\(r.trend_return\)/);
assert.match(headers[38], /data-key="trend_r2"/);   // 추세 R²는 별도 열(2026-10-23)
assert.match(cells[38], /trendR2Text\(r.trend_r2\)/);
assert.match(headers[39], /perf_10y/);
// 평단 배당율(추정, 2026-10-31)은 계좌표에만, 5년 배당성장 바로 오른쪽 — 보유 없는 행은 '-'
assert.match(headers[10], /dividend_growth_5y/);
assert.match(headers[11], /data-key="yield_on_cost"[\s\S]*평단[\s\S]*배당율/);
assert.match(cells[11], /noPosition \? "-" : yieldOnCostMarkup\(r\)/);
const interestColumns = read('app-interest-columns.js');
assert.doesNotMatch(interestColumns, /yield_on_cost/);
const css = read('styles.css');
assert.match(css, /td:nth-child\(12\) \{ min-width: calc\(62px \* var\(--col-scale, 1\)\); \} \/\* 평단 배당율/);
// 폭은 --col-scale 배율을 타되 기본값(데스크톱)은 원래 값 그대로다.
assert.match(css, /td:nth-child\(42\) \{ min-width: calc\(60px \* var\(--col-scale, 1\)\); \} \/\* 실적일/);
assert.match(css, /td:nth-child\(41\) \{ min-width: calc\(76px \* var\(--col-scale, 1\)\); \} \/\* 시총\/AUM/);
console.log('Account headers, cells and widths aligned; market cap and earnings date precede trade action.');

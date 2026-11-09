const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../portfolio_static', file), 'utf8');
const html = read('index.html');
const table = html.slice(html.indexOf('id="detailTableWrap"'), html.indexOf('id="interestTableWrap"'));
// 2행 헤더(2026-11-07): 첫 행 = 묶음 밖 열(rowspan=2) + 묶음 라벨(colspan), 둘째 행 = 묶음 안 열.
// 열 순서대로 펼친다 — 라벨 자리에 둘째 행의 열을 colspan만큼 끼운다.
const headRows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)].map(x => x[0]));
assert.equal(headRows.length, 2);
const leafQueue = [...headRows[1]];
const headers = headRows[0].flatMap(th => {
  const span = th.match(/colspan="(\d+)"/);
  return span ? leafQueue.splice(0, Number(span[1])) : [th];
});
assert.equal(leafQueue.length, 0);
assert.ok(headRows[0].filter(th => !/colspan/.test(th)).every(th => /rowspan="2"/.test(th)), '묶음 밖 열은 rowspan=2');
assert.match(headRows[0].join(''), /colspan="6"[^>]*data-detail-group="dividend">배당<[\s\S]*colspan="3"[^>]*data-detail-group="trend">추세</);
const source = read('app-holdings.js');
const body = source.slice(source.indexOf('<tr class="${tableRowClass(r)}">'), source.indexOf('// 다음 렌더의 펄스'));
const cells = [...body.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)].map(m => m[0]);
assert.equal(headers.length, 46);
assert.equal(cells.length, headers.length);
assert.match(headers[43], /data-key="market_cap_usd">시총\/AUM/);
assert.match(headers[44], /data-key="next_earnings_date">실적일/);
assert.match(headers[45], />거래</);
assert.match(cells[43], /marketCapMarkup\(r\)/);
assert.match(cells[44], /earningsText\(r.next_earnings_date\)/);
assert.match(cells[45], /tx-pick/);
// 배당 묶음(배당율·성장·평단 배당율)은 P/B 다음(2026-11-07, 관심목록과 같은 배치)
assert.match(headers[9], /drawdown_52w/);
assert.match(headers[10], /risk_reward_score/);
assert.match(headers[24], /price_to_book/);
assert.match(headers[25], /class="group-start" data-key="dividend_yield"/);
assert.match(cells[25], /class="group-start">\$\{dividendYieldMarkup\(r\)\}/);
// 진입 손익비 열 폐지(2026-11-07) — 변동성 손익비 바로 다음이 β
assert.match(headers[11], /data-key="beta"/);
assert.doesNotMatch(html + source, /entry_risk_reward|entryRewardText/);
assert.doesNotMatch(html + source, /trade_timing|tradeTimingMarkup/);
assert.match(headers[13], /rsi_day/);
assert.match(headers[18], /bb_month/);
assert.match(headers[19], /ma20_pct/);
assert.match(headers[31], /perf_1w/);
// 5년 → 10년 → 추세 수익률 → 이탈폭 → 강도(2026-11-07)
assert.match(headers[38], /perf_5y/);
assert.match(headers[39], /perf_10y/);
assert.match(cells[39], /perf_10y/);
assert.match(headers[40], /data-key="trend_return"/);
assert.match(cells[40], /class="group-start">\$\{trendReturnText\(r.trend_return\)\}/);
assert.match(headers[41], /data-key="trend_deviation"/);
assert.match(cells[41], /trendDeviationText\(r.trend_deviation\)/);
assert.match(headers[42], /data-key="trend_strength"/);
assert.match(cells[42], /trendStrengthText\(r.trend_strength\)/);
// 평단 배당율(추정, 2026-10-31)은 계좌표에만, 5년 배당성장 바로 오른쪽 — 보유 없는 행은 '-'
assert.match(headers[26], /dividend_growth_5y/);
assert.match(headers[27], /data-key="yield_on_cost"[\s\S]*평단[\s\S]*배당율/);
assert.match(cells[27], /noPosition \? "-" : yieldOnCostMarkup\(r\)/);
const interestColumns = read('app-interest-columns.js');
assert.doesNotMatch(interestColumns, /yield_on_cost/);
const css = read('styles.css');
assert.match(css, /td:nth-child\(28\) \{ min-width: calc\(54px \* var\(--col-scale, 1\)\); \} \/\* 평단 배당율/);
// 폭은 --col-scale 배율을 타되 기본값(데스크톱)은 원래 값 그대로다.
assert.match(css, /td:nth-child\(45\) \{ min-width: calc\(48px \* var\(--col-scale, 1\)\); \} \/\* 실적일/);
assert.match(css, /td:nth-child\(44\) \{ min-width: calc\(70px \* var\(--col-scale, 1\)\); \} \/\* 시총\/AUM/);
// 연속지급·연속증액·배당성향(2026-11-07) — 평단 배당율 다음, 배당 묶음 6열
assert.match(headers[28], /data-key="dividend_streak_years"/);
assert.match(cells[28], /dividendStreakText\(r.dividend_streak_years, r.dividend_streak_floor\)/);
assert.match(headers[29], /data-key="dividend_growth_streak_years"/);
assert.match(cells[29], /dividendStreakText\(r.dividend_growth_streak_years\)/);
assert.match(headers[30], /data-key="payout_ratio"/);
assert.match(cells[30], /fractionPercentText\(r.payout_ratio\)/);
assert.match(html, /colspan="6"[^>]*data-detail-group="dividend"/);
console.log('Account headers, cells and widths aligned; market cap and earnings date precede trade action.');

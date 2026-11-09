// ETF 구성종목 팝업(2026-11-04): 버튼 표시 조건과 표 이스케이프·기타 자산 묶음.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.equal(run('etfWeightText({weight: null})'), '-');
assert.equal(run('etfWeightText({weight: 12.34})'), '12.3%');
assert.equal(run('etfWeightText({weight: 1.234})'), '1.23%');
assert.equal(run('etfWeightText({weight: 5, estimated: true})'), '약 5.00%');

const data = `{source: "KODEX 공식", url: "https://x.test/f?a=1&b=2", as_of: "2026-11-03", complete: true,
  items: [{symbol: "NVDA", name: "<b>NVIDIA</b>", weight: 30}, {symbol: "", name: "무티커", weight: null}],
  others: [{symbol: "", name: "현금", weight: 1}]}`;
const table = run(`etfHoldingsTableMarkup(${data})`);
assert.match(table, /&lt;b&gt;NVIDIA&lt;\/b&gt;/);
assert.match(table, /현금·채권·파생 등/);
assert.match(table, /etf-holdings-other/);
assert.match(table, /<th>누적<\/th>/);
// 누적: 표 순서대로 끝까지 더하고, 비중 없는 행은 '-'로 두며 합계를 건드리지 않는다
const cumulative = [...table.matchAll(/etf-holdings-cumulative">([^<]*)</g)].map(match => match[1]);
assert.deepEqual(cumulative, ['30.0%', '-', '31.0%']);
const estimatedTable = run(`etfHoldingsTableMarkup({items: [{name: "A", weight: 5, estimated: true}, {name: "B", weight: 5}], others: []})`);
assert.deepEqual([...estimatedTable.matchAll(/etf-holdings-cumulative">([^<]*)</g)].map(match => match[1]), ['약 5.00%', '약 10.0%']);
const summary = run(`etfHoldingsSummaryMarkup(${data})`);
assert.match(summary, /href="https:\/\/x\.test\/f\?a=1&amp;b=2"/);
assert.match(summary, /전체 3개/);
assert.doesNotMatch(summary, /상위 10개/);   // 10개 이하면 합계가 뜻이 없다
const many = Array.from({ length: 11 }, (_, i) => ({ weight: 2 }));
assert.match(run(`etfHoldingsSummaryMarkup({source: "X", items: ${JSON.stringify(many)}, others: []})`), /상위 10개 20\.0%/);
// 일부만 공개된 출처는 '전체'라고 쓰지 않고, https가 아닌 주소는 링크로 만들지 않는다
const partial = run(`etfHoldingsSummaryMarkup({source: "yfinance", url: "javascript:alert(1)", as_of: "", complete: false, items: [{weight: 1}], others: []})`);
assert.match(partial, /공개된 1개/);
assert.doesNotMatch(partial, /href=/);

// 버튼: ETF만, 성과·비교 화면에서는 숨김
const button = { classList: { hidden: null, toggle(_, v) { this.hidden = v; } }, dataset: {} };
ctx.document.getElementById = id => (id === 'chartEtfHoldings' ? button : null);
ctx.__button = button;
const sync = payload => { run(`syncChartEtfButton(${JSON.stringify(payload)})`); return button.classList.hidden; };
assert.equal(sync({ ticker: 'SMH', name: 'VanEck', has_etf_holdings: true }), false);
assert.equal(button.dataset.ticker, 'SMH');
assert.equal(sync({ ticker: 'AAPL', has_etf_holdings: false }), true);
assert.equal(sync(null), true);
run('chartComparePayloads = [{ticker: "SPY"}]');
assert.equal(sync({ ticker: 'SMH', has_etf_holdings: true }), true);
run('chartComparePayloads = []');
run('performanceChartOpen = true');
assert.equal(sync({ ticker: 'SMH', has_etf_holdings: true }), true);

// 편입 ETF(2026-11-09): 개수 배지, 비교·성과 화면 숨김, 이름 이스케이프·차트 링크, 일부 공개 표시
run('performanceChartOpen = false');
const exposureButton = { classList: { hidden: null, toggle(_, v) { this.hidden = v; } }, dataset: {}, innerHTML: '', title: '' };
ctx.document.getElementById = id => (id === 'chartEtfExposure' ? exposureButton : null);
const syncExposure = payload => { run(`syncChartExposureButton(${JSON.stringify(payload)})`); return exposureButton.classList.hidden; };
assert.equal(syncExposure({ ticker: 'NVDA', name: 'NVIDIA', etf_exposure_count: 7 }), false);
assert.match(exposureButton.innerHTML, /편입 ETF <span class="company-events-badge">7<\/span>/);
assert.equal(exposureButton.dataset.ticker, 'NVDA');
assert.equal(syncExposure({ ticker: 'XYZ', etf_exposure_count: 0 }), true);
assert.equal(syncExposure(null), true);
run('chartComparePayloads = [{ticker: "SPY"}]');
assert.equal(syncExposure({ ticker: 'NVDA', etf_exposure_count: 3 }), true);
run('chartComparePayloads = []');
const exposure = `{collected: 90, partial: 8, items: [
  {etf: "SMH", name: "<i>VanEck</i>", weight: 19.2, estimated: false, as_of: "2026-11-03", complete: true, held: true},
  {etf: "0131V0.KS", name: "1Q", weight: 3, estimated: true, as_of: "", complete: false, held: false}]}`;
const exposureTable = run(`etfExposureTableMarkup(${exposure})`);
assert.match(exposureTable, /&lt;i&gt;VanEck&lt;\/i&gt;/);
assert.match(exposureTable, /class="ticker-link etf-exposure-link"[^>]*data-chart-ticker="SMH"/);
assert.match(exposureTable, /보유/);
assert.match(exposureTable, /약 3\.00%/);
assert.match(exposureTable, />- \*</);   // 기준일 없음 + 일부 공개 표시
assert.equal(run('etfAsOfText("2026-11-03", 2026)'), '11-03');
assert.equal(run('etfAsOfText("2025-12-31", 2026)'), '2025-12-31');
assert.equal(run('etfAsOfText("", 2026)'), '-');
const exposureSummary = run(`etfExposureSummaryMarkup(${exposure})`);
assert.match(exposureSummary, /수집된 ETF 90개 중 2개 편입/);
assert.match(exposureSummary, /보유 ETF 1개/);
assert.match(exposureSummary, /일부만 공개된 ETF 8개/);

// 당일 등락 열(2026-11-09): 티커 다음, 값 없으면 '-', 기준일은 title
const changeTable = run(`etfHoldingsTableMarkup({items: [{symbol: "NVDA", name: "N", weight: 5, change_pct: 1.234, change_date: "2026-11-09"}, {symbol: "", name: "X", weight: 1}], others: []})`);
assert.match(changeTable, /<th>티커<\/th><th>등락<\/th><th>비중<\/th>/);
assert.match(changeTable, /class="etf-day-change" title="2026-11-09 종가 기준"><span class="[^"]*">.*1\.23%/);
assert.match(changeTable, /class="etf-day-change">-</);
const changeExposure = run(`etfExposureTableMarkup({items: [{etf: "SMH", name: "S", weight: 3, change_pct: -0.5, complete: true}]})`);
assert.match(changeExposure, /<th>티커<\/th><th>등락<\/th><th>비중<\/th>/);
assert.match(changeExposure, /etf-holdings-symbol">SMH<\/td>\s*<td class="etf-day-change">/);
console.log('etf holdings view ok');

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
console.log('etf holdings view ok');

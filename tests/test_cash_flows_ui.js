const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ window: {}, Intl });
vm.runInContext(`function esc(s) { return String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }`, context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../portfolio_static/app-cash-flows.js"), "utf8"), context);
const run = code => vm.runInContext(code, context);
assert.match(run("cashFlowsTableMarkup(buildCashFlowsMatrix([{id: 1, name: '해외주식'}], []))"), /<strong>해외주식<\/strong>/);
run(`
  const accounts = [{id: 1, memberName: 'Test', name: '<Account>'}, {id: 2, name: 'Empty'}];
  const flows = [
    {id: 1, account_id: 1, flow_date: '2024-01-01', amount: 100, currency: 'KRW'},
    {id: 2, account_id: 1, flow_date: '2024-01-01', amount: -100, currency: 'KRW'},
    {id: 3, account_id: 1, flow_date: '2024-02-01', amount: 12.34, currency: 'USD', note: '<note>'},
    {id: 4, account_id: 1, flow_date: '2024-02-01', amount: 500, currency: 'KRW'},
    {id: 5, account_id: 3, flow_date: '2024-01-15', amount: -10, currency: 'EUR', account_name: 'Archived'},
  ];
  const matrix = buildCashFlowsMatrix(accounts, flows);
`);
assert.equal(run("matrix.accounts.length"), 3); // includes empty and missing account
assert.equal(run("matrix.rows.length"), 3); // only dates with entries, no generated calendar
assert.equal(run("matrix.rows[0].date"), "2024-02-01");
assert.equal(run("matrix.rows[2].cells.get('1').length"), 2); // zero-net date is retained
assert.equal(run("matrix.totals.get('1').length"), 4); // original entries kept for later editing
assert.match(run("cashFlowsAmountMarkup(matrix.rows[2].cells.get('1'))"), /flat\">0/);
const mixed = run("cashFlowsAmountMarkup(matrix.rows[0].cells.get('1'))");
assert.match(mixed, /\+12.34<small>USD/);
assert.match(mixed, /\+0<\/span>/);
assert.match(run("cashFlowsAmountMarkup([{amount: 10000, currency: 'KRW'}])"), /\+1<\/span>/);
assert.match(run("cashFlowsAmountMarkup([{amount: -12345678, currency: 'KRW'}])"), /−1,235<\/span>/);
assert.match(run("cashFlowsAmountMarkup([{amount: 3000, currency: 'KRW'}, {amount: 3000, currency: 'KRW'}])"), /\+1<\/span>/); // sum before rounding
assert.match(run("cashFlowsAmountMarkup([{amount: -5000, currency: 'KRW'}])"), /−1<\/span>/);
assert.match(run("cashFlowsAmountMarkup(matrix.totals.get('3'))"), /down\">−10/);
assert.match(run("cashFlowsAmountMarkup(undefined)"), /—/);
const html = run("cashFlowsTableMarkup(matrix)");
assert.match(html, /&lt;Account>/);
assert.doesNotMatch(html, /title=|&lt;note>/);
const special = run(`cashFlowsTableMarkup(buildCashFlowsMatrix(accounts, [
  {account_id: 1, flow_date: '2024-01-01', amount: 10000, currency: 'KRW', note: '일반 입금'},
  {account_id: 1, flow_date: '2024-01-01', amount: 20000, currency: 'KRW', note: '사용자 승인 추정 보정 <메모>'},
]))`);
assert.equal((special.match(/title=/g) || []).length, 1); // detail only, never annual total
assert.match(special, /title="20,000 KRW · 사용자 승인 추정 보정 &lt;메모>"/);
assert.doesNotMatch(special, /일반 입금/);
for (const note of ['현물 증여', '상장폐지 현금정산', '매수일 기준 추정 입금']) {
  assert.match(run(`cashFlowsTableMarkup(buildCashFlowsMatrix(accounts, [{account_id: 1, flow_date: '2024-01-01', amount: 10000, currency: 'KRW', note: ${JSON.stringify(note)}}]))`), /title=/);
}
assert.equal((html.match(/scope="col"/g) || []).length, 4);
assert.equal((html.match(/<td /g) || []).length, 12);
assert.match(html, /data-account-id="1" data-flow-date="2024-02-01"/);
assert.match(html, /<time datetime="2024-02-01">02-01<\/time>/);
assert.doesNotMatch(html, />2024-02-01<\/time>/);
const page = fs.readFileSync(path.join(__dirname, "../portfolio_static/index.html"), "utf8");
const popup = page.match(/<dialog[^>]*id="cashFlowsModal"[\s\S]*?<\/dialog>/)[0];
assert.doesNotMatch(popup, /cashFlowsRefresh|cashFlowsHelp|cash-flows-footnote|cash-flows-toolbar/);
const script = fs.readFileSync(path.join(__dirname, "../portfolio_static/app-cash-flows.js"), "utf8");
assert.doesNotMatch(script, /cashFlowsRefresh|data-cash-selection|cashSelection/);
assert.match(popup, /id="cashFlowsPrevYear"/);
assert.match(popup, /id="cashFlowsNextYear"/);
// Initialization must work with only the controls still present in the page.
const ids = [...page.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
context.document = {
  getElementById(id) {
    assert.ok(ids.includes(id), `Missing element: ${id}`);
    return { addEventListener() {} };
  },
};
run("initCashFlowsModal()");
assert.equal(run("buildCashFlowsMatrix(accounts, []).rows.length"), 0);
assert.equal(run("buildCashFlowsMatrix(accounts, []).accounts.length"), 2);
assert.equal(run("flows[0].amount"), 100); // no input mutation
assert.equal(run("filterCashFlowsMatrix(matrix, null) === matrix"), true);
assert.equal(run("filterCashFlowsMatrix(matrix, new Set(['3'])).accounts.length"), 1);
assert.equal(run("filterCashFlowsMatrix(matrix, new Set(['3'])).rows.length"), 1);
assert.equal(run("filterCashFlowsMatrix(matrix, new Set(['3'])).rows[0].date"), '2024-01-15');
assert.equal(run("filterCashFlowsMatrix(matrix, new Set(['1'])).count"), 4);
assert.equal(run("filterCashFlowsMatrix(matrix, new Set(['1'])).rows.map(r => r.date).join(',')"), '2024-02-01,2024-01-01');
assert.equal(run("filterCashFlowsMatrix(matrix, new Set(['2'])).rows.length"), 0);
assert.equal(run("filterCashFlowsMatrix(matrix, new Set()).accounts.length"), 0);
assert.equal(run("filterCashFlowsMatrix(matrix, new Set()).count"), 0);
run(`
  const annual = buildCashFlowsMatrix(accounts, [...flows,
    {account_id: 1, flow_date: '2023-12-31', amount: 30000, currency: 'KRW'},
    {account_id: 1, flow_date: '2025-01-01', amount: 50000, currency: 'KRW'},
  ]);
  const year2024 = filterCashFlowsMatrix(annual, new Set(['1']), 2024);
`);
assert.equal(run("year2024.count"), 4);
assert.equal(run("year2024.rows.map(r => r.date).join(',')"), '2024-02-01,2024-01-01');
assert.equal(run("year2024.totals.get('1').filter(e => e.currency === 'KRW').reduce((n,e) => n+e.amount,0)"), 500);
assert.equal(run("filterCashFlowsMatrix(annual, null, 2023).count"), 1);
assert.equal(run("filterCashFlowsMatrix(annual, null, 2026).count"), 0);
assert.equal(run("filterCashFlowsMatrix(annual, null, 2026).totals.size"), 0);
assert.equal(run("filterCashFlowsMatrix(annual, null, 2026).accounts.length"), 3);
assert.match(run("cashFlowsTableMarkup(year2024)"), /연간 순입금/);
console.log("cash flow matrix: grouping, totals, currencies, zero net, empty accounts and escaping passed");

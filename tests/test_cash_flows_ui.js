const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ window: {}, Intl });
vm.runInContext(`function esc(s) { return String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }`, context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../portfolio_static/app-cash-flows.js"), "utf8"), context);
const run = code => vm.runInContext(code, context);
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
assert.match(mixed, /\+500<small>원/);
assert.match(run("cashFlowsAmountMarkup(matrix.totals.get('3'))"), /down\">−10/);
assert.match(run("cashFlowsAmountMarkup(undefined)"), /—/);
const html = run("cashFlowsTableMarkup(matrix)");
assert.match(html, /&lt;Account>/);
assert.match(html, /&lt;note>/);
assert.equal((html.match(/scope="col"/g) || []).length, 4);
assert.equal((html.match(/<td /g) || []).length, 12);
assert.match(html, /data-account-id="1" data-flow-date="2024-02-01"/);
assert.equal(run("buildCashFlowsMatrix(accounts, []).rows.length"), 0);
assert.equal(run("buildCashFlowsMatrix(accounts, []).accounts.length"), 2);
assert.equal(run("flows[0].amount"), 100); // no input mutation
console.log("cash flow matrix: grouping, totals, currencies, zero net, empty accounts and escaping passed");

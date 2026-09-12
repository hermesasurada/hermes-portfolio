const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../portfolio_static');
const source = fs.readFileSync(path.join(root, 'app-tabs.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const elements = {};
const context = vm.createContext({
  document: {getElementById: id => elements[id] ||= {querySelector: () => null}},
  esc: String,
  fmt: new Intl.NumberFormat('en-US'),
  initDividendHistoryCollapsedYears: () => {},
  dividendHistoryYearCollapsible: () => false,
  collapsedDividendHistoryYears: new Set(),
  dividendHistoryPercent: String,
  dividendMoneyText: String,
  dividendAmountText: String,
  shortDateText: String,
});
vm.runInContext(source.slice(source.indexOf('function renderDividendHistory('),
  source.indexOf('async function openDividendHistory(')), context);
for (const frequency of [4, 12]) {
  context.renderDividendHistory({ticker: 'TEST', summary: {frequency}, rows: [{
    year: 2026, amount: 12345.6789, payments: 1, expected_payments: frequency,
    payments_detail: [{amount: 12345.6789, entitlement_date: '2026-01-01', pay_date: '2026-01-15'}],
  }]});
  const html = elements.dividendHistoryBody.innerHTML;
  assert.equal((html.match(/<th[ >]/g) || []).length, frequency === 12 ? 6 : 7);
  assert.equal(html.includes('history-count-cell'), frequency !== 12);
  assert.match(html, /12345\.6789/);
  assert.match(html, /2026-01-15/);
}
assert.match(css, /\.watch-modal\.dividend-history-modal\s*\{[^}]*width: fit-content;[^}]*max-width:/);
assert.match(css, /\.dividend-history-table\s*\{[^}]*width: max-content;[^}]*table-layout: auto;/);
assert.match(css, /\.dividend-history-table-wrap\s*\{[^}]*overflow-x: auto;/);
assert.doesNotMatch(css, /\.dividend-history-table (?:th|td):nth-child/);
console.log('Dividend history: content-sized columns, optional count and horizontal overflow passed.');

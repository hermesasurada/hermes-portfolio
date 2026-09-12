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
  dividendHistoryYearCollapsible: row => row.payments_detail.length > 1,
  collapsedDividendHistoryYears: new Set(),
  dividendHistoryPercent: String,
  dividendMoneyText: String,
  dividendAmountText: String,
  shortDateText: String,
});
vm.runInContext(source.slice(source.indexOf('function renderDividendHistory('),
  source.indexOf('async function openDividendHistory(')), context);
for (const frequency of [1, 2, 4, 12]) {
 for (const collapsed of [false, true]) {
  context.collapsedDividendHistoryYears.clear();
  if (collapsed) context.collapsedDividendHistoryYears.add('2026');
  context.renderDividendHistory({ticker: 'TEST', summary: {frequency}, rows: [{
    year: 2026, amount: 12345.6789, payments: 1, expected_payments: frequency,
    payments_detail: [
      {amount: 12345.6789, entitlement_date: '2026-01-01', pay_date: '2026-01-15'},
      {amount: 10, entitlement_date: '2026-02-01', pay_date: '2026-02-15', is_special: true},
      {amount: 20, entitlement_date: '2026-03-01', pay_date: '2026-03-15'},
    ],
  }]});
  const html = elements.dividendHistoryBody.innerHTML;
  assert.equal((html.match(/<th[ >]/g) || []).length, 6);
  assert.doesNotMatch(html, /history-count|횟수/);
  assert.match(html, /12345\.6789/);
  if (!collapsed) assert.match(html, /2026-01-15/);
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const width = [...row[1].matchAll(/<t[hd]\b([^>]*)>/g)].reduce((n, cell) =>
      n + Number(cell[1].match(/colspan="(\d+)"/)?.[1] || 1), 0);
    assert.equal(width, 6, 'Every normal, special and collapsed row spans six columns');
  }
 }
}
assert.match(css, /\.watch-modal\.dividend-history-modal\s*\{[^}]*width: fit-content;[^}]*max-width:/);
assert.match(css, /\.dividend-history-table\s*\{[^}]*width: max-content;[^}]*table-layout: auto;/);
assert.match(css, /\.dividend-history-table-wrap\s*\{[^}]*overflow-x: auto;/);
assert.doesNotMatch(css, /\.dividend-history-table (?:th|td):nth-child/);
console.log('Dividend history: six columns at all frequencies, special/collapsed rows and content sizing passed.');

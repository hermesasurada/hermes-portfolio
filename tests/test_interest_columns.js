// Pure render/schema checks; no browser, live API, or dependency installation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ window: {}, Set, Map });
vm.runInContext(`
  function esc(s) { return String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }
`, context);
const source = fs.readFileSync(path.join(__dirname, "../portfolio_static/app-interest-columns.js"), "utf8");
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);
assert.equal(run("INTEREST_TABLE_COLUMN_COUNT"), 57);
assert.equal(run("new Set(INTEREST_COLUMNS.map(c => c.key)).size"), 57);
assert.equal(run("visibleInterestColumns([]).length"), 5);
assert.equal(run("visibleInterestColumns([{ dividend_yield: 0 }]).some(c => c.key === 'dividend_yield')"), false);
assert.equal(run("visibleInterestColumns([{ free_cash_flow: 0 }]).some(c => c.key === 'free_cash_flow')"), true);
assert.equal(run("visibleInterestColumns([{ extended_change_pct: 1 }], true).some(c => c.key === 'extended_change_pct')"), false);
assert.equal(run("visibleInterestColumns([{ dividend_growth_5y: 3 }]).some(c => c.key === 'dividend_growth_5y')"), true);
const allHeaders = run("interestTableHead(INTEREST_COLUMNS)");
assert.equal((allHeaders.match(/data-interest-col=/g) || []).length, 57);
assert.equal((allHeaders.match(/data-interest-sort-key=/g) || []).length, 56);
const few = run("interestTableHead(visibleInterestColumns([{ rsi_week: 40, rsi_month: 45 }]))");
assert.match(few, /colspan="2" class="group-start" data-interest-group-head="momentum"/);
assert.doesNotMatch(few, /data-interest-col="16"/);
assert.match(few, /data-interest-col="17"/);
assert.equal((run("interestEmptyRow('none', INTEREST_COLUMNS)").match(/<td /g) || []).length, 57);
assert.match(run("interestEmptyRow('<unsafe>', visibleInterestColumns([]))"), /&lt;unsafe>/);
run(`
  const testCol = { innerHTML: '' }, testHead = { innerHTML: '' };
  const table = { dataset: {}, querySelector: s => s === 'colgroup' ? testCol : testHead };
  renderInterestFrame(table, visibleInterestColumns([]));
`);
assert.equal((run("testCol.innerHTML").match(/<col /g) || []).length, 5);
run("testHead.innerHTML = 'unchanged'; renderInterestFrame(table, visibleInterestColumns([]));");
assert.equal(run("testHead.innerHTML"), "unchanged");
console.log("interest column schema, visibility, header alignment and frame reuse ok");

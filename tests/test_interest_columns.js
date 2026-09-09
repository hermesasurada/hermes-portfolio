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
assert.equal(run("INTEREST_TABLE_COLUMN_COUNT"), 60);
// MM/DD in Roboto Mono needs room for both group-boundary paddings.
assert.equal(run("INTEREST_COLUMNS.find(c => c.key === 'next_earnings_date').width"), 60);
assert.equal(run("new Set(INTEREST_COLUMNS.map(c => c.key)).size"), 60);
assert.equal(run("INTEREST_COLUMNS.filter(c => c.numeric).length"), 56);
assert.equal(run("INTEREST_COLUMNS.filter(c => !c.numeric).map(c => c.key).join(',')"), 'logo,name,rating_rank,delete');
const numericCells = run("interestRowCells({}, {}, INTEREST_COLUMNS.map(c => ({...c, cell: () => 'test'})))");
assert.equal((numericCells.match(/numeric-cell/g) || []).length, 56);
assert.match(numericCells, /class="group-start numeric-cell"/);
assert.doesNotMatch(run("interestRowCells({}, {}, INTEREST_COLUMNS.filter(c => !c.numeric).map(c => ({...c, cell: () => 'text'})))"), /numeric-cell/);
assert.equal(run("visibleInterestColumns([]).length"), 5);
assert.equal(run("visibleInterestColumns([{ dividend_yield: 0 }]).some(c => c.key === 'dividend_yield')"), false);
assert.equal(run("visibleInterestColumns([{ free_cash_flow: 0 }]).some(c => c.key === 'free_cash_flow')"), true);
assert.equal(run("visibleInterestColumns([{ extended_change_pct: 1 }], true).some(c => c.key === 'extended_change_pct')"), false);
assert.equal(run("visibleInterestColumns([{ dividend_growth_5y: 3 }]).some(c => c.key === 'dividend_growth_5y')"), true);
const allHeaders = run("interestTableHead(INTEREST_COLUMNS)");
assert.equal((allHeaders.match(/data-interest-col=/g) || []).length, 60);
assert.equal((allHeaders.match(/data-interest-sort-key=/g) || []).length, 59);
const few = run("interestTableHead(visibleInterestColumns([{ rsi_week: 40, rsi_month: 45 }]))");
assert.match(few, /colspan="2" class="group-start" data-interest-group-head="momentum"/);
assert.doesNotMatch(few, /data-interest-col="16"/);
assert.match(few, /data-interest-col="17"/);
assert.equal((run("interestEmptyRow('none', INTEREST_COLUMNS)").match(/<td /g) || []).length, 60);
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

assert.equal(run("INTEREST_COLUMNS.slice(INTEREST_COLUMNS.findIndex(c => c.key === 'bb_month'), INTEREST_COLUMNS.findIndex(c => c.key === 'bb_month') + 5).map(c => c.key).join(',')"),
  'bb_month,ma20_pct,ma50_pct,ma200_pct,trailing_pe');
for (const period of [20, 50, 200]) {
  const key = `ma${period}_pct`;
  assert.equal(run(`visibleInterestColumns([{${key}: 0}]).some(c => c.key === '${key}')`), true);
  assert.equal(run(`visibleInterestColumns([{${key}: null}]).some(c => c.key === '${key}')`), false);
}
const root = path.join(__dirname, '../portfolio_static');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
assert.match(html, /data-key="bb_month"[\s\S]*?data-key="ma20_pct"[\s\S]*?data-key="ma50_pct"[\s\S]*?data-key="ma200_pct"[\s\S]*?data-key="trailing_pe"/);
for (const period of [20, 50, 200]) {
  const key = `ma${period}_pct`;
  assert.ok(read('app.js').includes(`"${key}"`));
  assert.ok(read('state.js').includes(`${key}: -1`));
  assert.ok(read('app-tabs.js').includes(`${key}: stats.${key}`));
  assert.ok(read('app-holdings.js').includes(`signedPercentText(r.${key}, 1)`));
}
// Exercise the real comparator: absent SMA stays last for both sort directions.
const holdings = read('app-holdings.js');
vm.runInContext(holdings.slice(holdings.indexOf('function listSortValue('), holdings.indexOf('function holdingChangeBasePrice(')), context);
const sortFunction = holdings.slice(holdings.indexOf('function sortRows('), holdings.indexOf('function syncFilterToggleControls('));
run(`const sortState = {detail:{key:'ma200_pct',dir:1}}; const activeDetailTab='detail';`);
vm.runInContext(sortFunction, context);
for (const dir of [1,-1]) {
  assert.equal(run(`sortState.detail.dir=${dir}; sortRows([{ma200_pct:null},{ma200_pct:0},{ma200_pct:-5},{ma200_pct:10}], 'detail').map(r=>r.ma200_pct).join(',')`), dir === 1 ? '-5,0,10,' : '10,0,-5,');
}

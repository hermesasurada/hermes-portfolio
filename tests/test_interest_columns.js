// Pure render/schema checks; no browser, live API, or dependency installation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("./harness");
// β·β″ 툴팁 문구는 format.js에 한 번만 정의돼 있다 — 컬럼 정의가 그걸 참조한다(전체 로드로 함께 들어온다).
const context = h.loadScripts(h.createContext());
const run = code => h.evaluate(context, code);
assert.equal(run("INTEREST_TABLE_COLUMN_COUNT"), 61);
// 헤더에 산식 툴팁이 붙어 있어야 한다(값만 보고는 무엇인지 알 수 없는 지표).
for (const [key, needle] of [["beta", "공분산"], ["beta_adj", "표준편차"]]) {
  const column = run(`INTEREST_COLUMNS.find(c => c.key === "${key}")`);
  assert.ok(column.title && column.title.includes(needle), `${key} 툴팁 없음`);
  assert.ok(column.title.includes("252거래일"), `${key} 툴팁에 계산 창이 없다`);
}
// MM/DD in Roboto Mono needs room for both group-boundary paddings.
assert.equal(run("INTEREST_COLUMNS.find(c => c.key === 'next_earnings_date').width"), 60);
assert.equal(run("new Set(INTEREST_COLUMNS.map(c => c.key)).size"), 61);
assert.equal(run("INTEREST_COLUMNS.filter(c => c.numeric).length"), 56);
assert.equal(run("INTEREST_COLUMNS.filter(c => !c.numeric).map(c => c.key).join(',')"), 'logo,name,trade_timing,rating_rank,delete');
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
assert.equal((allHeaders.match(/data-interest-col=/g) || []).length, 61);
assert.equal((allHeaders.match(/data-interest-sort-key=/g) || []).length, 60);
const few = run("interestTableHead(visibleInterestColumns([{ rsi_week: 40, rsi_month: 45 }]))");
assert.match(few, /colspan="2" class="group-start" data-interest-group-head="momentum"/);
assert.doesNotMatch(few, /data-interest-col="17"/);
assert.match(few, /data-interest-col="18"/);
assert.equal((run("interestEmptyRow('none', INTEREST_COLUMNS)").match(/<td /g) || []).length, 61);
assert.match(run("interestEmptyRow('<unsafe>', visibleInterestColumns([]))"), /&lt;unsafe&gt;/);
run(`
  const testCol = { innerHTML: '' }, testHead = { innerHTML: '' };
  const vars = {};
  const table = { dataset: {}, style: { setProperty: (k, v) => { vars[k] = v; } },
    querySelector: s => s === 'colgroup' ? testCol : testHead };
  renderInterestFrame(table, visibleInterestColumns([]));
`);
assert.equal((run("testCol.innerHTML").match(/<col /g) || []).length, 5);
// 종목명 열 sticky 오프셋이 쓰는 값 = 로고 열 colgroup 폭. 어긋나면 두 고정열
// 사이가 벌어져 가로 스크롤되는 데이터가 그 틈으로 비친다.
const logoVar = run("vars['--interest-logo-col']");
assert.match(logoVar, /^calc\(\d+px \* var\(--col-scale, 1\)\)$/);
assert.ok(run("testCol.innerHTML").includes(`width:${logoVar}"`), '로고 열 colgroup 폭과 변수가 달라졌다');
const css = fs.readFileSync(path.join(__dirname, '../portfolio_static/styles.css'), 'utf8');
assert.match(css, /left: var\(--interest-logo-col, 40px\);/);
assert.match(css, /width: var\(--interest-logo-col, 40px\);/);
run("testHead.innerHTML = 'unchanged'; renderInterestFrame(table, visibleInterestColumns([]));");
assert.equal(run("testHead.innerHTML"), "unchanged");
console.log("interest column schema, visibility, header alignment and frame reuse ok");
assert.equal(run("visibleInterestColumns([{trade_timing: null}]).some(c=>c.key==='trade_timing')"), false);
assert.equal(run("visibleInterestColumns([{trade_timing: {state:'wait'}}]).some(c=>c.key==='trade_timing')"), true);
assert.equal(run("INTEREST_COLUMNS[INTEREST_COLUMNS.findIndex(c=>c.key==='entry_risk_reward')+1].key"), 'trade_timing');

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
run(`sortState.detail = {key:'ma200_pct',dir:1}; activeDetailTab = 'detail';`);
for (const dir of [1,-1]) {
  assert.equal(run(`sortState.detail.dir=${dir}; sortRows([{ma200_pct:null},{ma200_pct:0},{ma200_pct:-5},{ma200_pct:10}], 'detail').map(r=>r.ma200_pct).join(',')`), dir === 1 ? '-5,0,10,' : '10,0,-5,');
}

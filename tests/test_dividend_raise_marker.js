// 배당 탭 주당배당금 증액 표시: 확정=빨강 굵게, 공시됐지만 지급 전=파랑 굵게, 공시 전 예상=주황 굵게, 툴팁에 근거.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const body = h.element();
const others = new Map();
ctx.document.getElementById = id => (id === 'dividendRows' ? body : (others.get(id) || others.set(id, h.element()).get(id)));
ctx.todayLocal = () => '2026-10-28';
ctx.schedulePcFrozenColumns = () => {};
ctx.scheduleTableViewportRows = () => {};
ctx.dividendSelectionKey = () => 'k';
const row = (ticker, pay, marker) => ({ticker, name: ticker, pay_date: pay, ex_date: pay, amount: 1.5, qty: 1, gross: 1, net: 1, net_krw: 1000, currency: 'USD', raise_marker: marker});
ctx.__rows = [
  row('UP', '2026-10-30', {kind: 'confirmed', pct: 10, yoy_pct: 12.5, previous_date: '2026-07-15', year_ago_date: '2025-10-15'}),
  row('SOON', '2026-11-20', {kind: 'expected', pct: 10.2, raised_date: '2025-11-20'}),
  row('FLAT', '2026-11-25', null),
  row('NEW', '2026-11-12', {kind: 'declared', pct: 8, yoy_pct: 8, previous_date: '2026-08-12', pay_date: '2026-11-12'}),
];
h.evaluate(ctx, `dividendLoadKey = 'k'; dividendData = {rows: __rows}; sortState.dividend = {key: 'pay_date', dir: 1}; dividendMonthOverrides = new Map();`);
ctx.renderDividendTable();
const tr = ticker => body.innerHTML.split('<tr').find(part => part.includes(`data-chart-ticker="${ticker}"`));
assert.match(tr('UP'), /class="dividend-raise-confirmed" title="배당 증액 확정 — 직전 회차\(07\/15\) 대비 \+10%, 작년 같은 분기 대비 \+12\.5%"/);
assert.match(tr('SOON'), /class="dividend-raise-expected" title="다음 회차 증액 예상 — 작년 같은 분기\(2025\.11\)에 \+10\.2% 증액/);
assert.doesNotMatch(tr('FLAT'), /dividend-raise-/);
assert.match(tr('NEW'), /class="dividend-raise-declared" title="배당 증액 공시, 지급 전\(11\/12 지급\) — 직전 회차\(08\/12\) 대비 \+8%/);

const css = fs.readFileSync(require('node:path').join(__dirname, '../portfolio_static/styles.css'), 'utf8');
assert.match(css, /\.dividend-raise-confirmed,\s*\.stat-yield-link\.dividend-raise-confirmed:hover \{\s*color: var\(--up\);\s*font-weight: 700;/);
assert.match(css, /\.dividend-raise-expected,\s*\.stat-yield-link\.dividend-raise-expected:hover \{\s*color: var\(--raise-expected\);\s*font-weight: 700;/);
assert.match(css, /\.dividend-raise-declared,\s*\.stat-yield-link\.dividend-raise-declared:hover \{\s*color: var\(--down\);\s*font-weight: 700;/);
// 배당율 링크 기본 규칙(color: inherit)보다 뒤에 와야 색이 이긴다
assert.ok(css.indexOf('.dividend-raise-confirmed,') > css.indexOf('.stat-yield-link {'), '증액 색 규칙은 배당율 링크 규칙 뒤');

// 목록(세부내역·관심목록) 배당율 칸도 같은 표시
const yieldCell = ctx.dividendYieldMarkup({ticker: 'UP', dividend_yield: 1.23, dividend_raise: {kind: 'confirmed', pct: 10, yoy_pct: 10, previous_date: '2026-07-15'}});
assert.match(yieldCell, /class="stat-yield-link dividend-raise-confirmed"[^>]*title="배당 증액 확정 — 직전 회차\(07\/15\) 대비 \+10%, 작년 같은 분기 대비 \+10% · 배당 이력 보기"/);
assert.match(ctx.dividendYieldMarkup({ticker: 'S', dividend_yield: 1, dividend_raise: {kind: 'expected', pct: 5, raised_date: '2025-12-22'}}), /stat-yield-link dividend-raise-expected/);
assert.match(ctx.dividendYieldMarkup({ticker: 'D', dividend_yield: 1, dividend_raise: {kind: 'declared', pct: 5, previous_date: '2026-08-01', pay_date: '2026-11-01'}}), /stat-yield-link dividend-raise-declared/);
assert.match(ctx.dividendYieldMarkup({ticker: 'F', dividend_yield: 1, dividend_raise: null}), /class="stat-yield-link" type="button" data-dividend-history="F" title="배당 이력 보기"/);
assert.equal(ctx.dividendYieldMarkup({ticker: 'N', dividend_yield: 0, dividend_raise: {kind: 'confirmed'}}), '-');
const holdings = fs.readFileSync(require('node:path').join(__dirname, '../portfolio_static/app-holdings.js'), 'utf8');
const interest = fs.readFileSync(require('node:path').join(__dirname, '../portfolio_static/app-interest-columns.js'), 'utf8');
assert.match(holdings, /dividendYieldMarkup\(r\)/);
assert.match(interest, /cell: \(r, group\) => dividendYieldMarkup\(r\)/);
assert.equal((css.match(/--raise-expected: #/g) || []).length, 2, '라이트·다크 토큰 모두 정의');
console.log('Dividend raise marker: dividend tab amount and list yield cells mark confirmed (red), declared-unpaid (blue) and expected (orange) raises');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../portfolio_static');
function element() {
  const classes = new Set();
  return { attrs: {}, textContent: '', checked: false,
    classList: {
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
  };
}
const ids = Object.fromEntries(['mobileFiltersToggle', 'currencyFilterControl',
  'interestSectorControl', 'interestSectorButton'].map(id => [id, element()]));
const body = element(), toolbar = element();
let renders = 0, closed = 0, currency = 'all';
const ctx = vm.createContext({ window: {},
  storageGet: () => null, heroSummaryStorage: {page: 'hero-page'},
  currencyFilterValue: () => currency,
  document: { body, getElementById: id => ids[id], querySelector: () => toolbar },
});
for (const file of ['app-holdings.js', 'app-interest-watchlists.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx);
}
ctx.renderInterestWatchlists = () => renders++;
ctx.closeInterestSectorPanel = () => closed++;
ctx.currencyFilterValue = () => currency;
// 편집 모드 없음: 그룹·종목 관리 컨트롤은 항상 보인다(2026-09-15 사용자 지시로 원복).
assert.equal(vm.runInContext('typeof setInterestEditMode', ctx), 'undefined');
assert.ok(!body.classList.contains('watchlist-editing'));
vm.runInContext('setMobileFiltersExpanded(true)', ctx);
assert.equal(ids.mobileFiltersToggle.attrs['aria-expanded'], 'true');
assert.ok(toolbar.classList.contains('filters-expanded'));
vm.runInContext('setMobileFiltersExpanded(false)', ctx);
assert.equal(ids.mobileFiltersToggle.attrs['aria-expanded'], 'false');
assert.equal(closed, 1);
const sync = () => vm.runInContext('syncMobileFilterIndicator()', ctx);
sync();
assert.equal(ids.mobileFiltersToggle.textContent, '필터');
currency = 'USD'; sync();
assert.equal(ids.mobileFiltersToggle.textContent, '필터 · 적용');
ids.currencyFilterControl.classList.add('hidden'); sync();
assert.equal(ids.mobileFiltersToggle.textContent, '필터'); // Inapplicable controls don't mark filtered.
ids.interestSectorButton.classList.add('filtering'); sync();
assert.equal(ids.mobileFiltersToggle.textContent, '필터 · 적용');
ids.interestSectorControl.classList.add('hidden'); sync();
assert.equal(ids.mobileFiltersToggle.textContent, '필터');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
// 숨김 게이트가 되살아나면 실패한다. 삭제(×) 열은 오른쪽 sticky로 항상 닿아야 한다.
assert.doesNotMatch(css, /watchlist-editing/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /interestEditToggle/);
assert.match(css, /#interestTableWrap \.interest-detail-list td\.interest-delete-col \{[^}]*position: sticky;[^}]*right: 0;/);
assert.match(css, /\.title-tools:not\(\.filters-expanded\) :is\(#interestSectorControl, #currencyFilterControl\)/);
for (const file of ['index.html','state.js','app.js','app-holdings.js','styles.css']) {
  assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'), /showIndexes|ignoreIndexes|function indexRows\(/);
}
assert.doesNotMatch(css, /SA News식|backdrop-filter: blur\(18px\)/);
assert.match(css, /--up: #dc3545/);
assert.match(css, /--down: #1976d2/);
console.log('Design controls: always-on watchlist editing, mobile expansion, active filters and palette invariants passed.');

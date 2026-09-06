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
const ids = Object.fromEntries(['interestEditToggle', 'mobileFiltersToggle', 'currencyFilterControl',
  'interestSectorControl', 'interestSectorButton', 'showIndexesControl', 'showIndexesToggle'].map(id => [id, element()]));
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
vm.runInContext('setInterestEditMode(true)', ctx);
assert.equal(ids.interestEditToggle.textContent, '완료');
assert.equal(ids.interestEditToggle.attrs['aria-pressed'], 'true');
assert.ok(body.classList.contains('watchlist-editing'));
vm.runInContext('editingInterestGroupId = 3; setInterestEditMode(false)', ctx);
assert.equal(ids.interestEditToggle.textContent, '편집');
assert.equal(vm.runInContext('editingInterestGroupId', ctx), null);
assert.equal(renders, 1); // Cancels only the unsaved editor; no API dependency.
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
ids.showIndexesToggle.checked = true; sync();
assert.equal(ids.mobileFiltersToggle.textContent, '필터 · 적용');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
assert.match(css, /body:not\(\.watchlist-editing\) :is\(#interestGroupForm, #interestMainItemForm,/);
assert.match(css, /\.title-tools:not\(\.filters-expanded\) :is\(#interestSectorControl, #currencyFilterControl, #showIndexesControl\)/);
assert.doesNotMatch(css, /SA News식|backdrop-filter: blur\(18px\)/);
assert.match(css, /--up: #dc3545/);
assert.match(css, /--down: #1976d2/);
console.log('Design controls: edit mode, mobile expansion, active filters and palette invariants passed.');

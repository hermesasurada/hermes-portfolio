const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../portfolio_static');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
assert.match(css, /\.hero-page-shell\s*\{\s*display: grid;\s*align-items: center;/);
assert.match(css, /\.hero-page-shell > \.hero-summary-page\s*\{\s*grid-area: 1 \/ 1;/);
assert.match(css, /\.hero-page-shell > \.hero-summary-page\.hidden\s*\{\s*display: block !important;\s*visibility: hidden;\s*pointer-events: none;/);
assert.doesNotMatch(css, /\.hero-page-shell\s*\{[^}]*\sheight: 64px;/); // min-height only
function element() {
  return { hidden: false, attrs: {},
    classList: { toggle(name, value) { this[name] = value; } },
    setAttribute(name, value) { this.attrs[name] = value; },
  };
}
const ids = Object.fromEntries(['heroPortfolioPage', 'heroIndexPage', 'heroFxPage', 'heroNext', 'heroValue', 'heroChange'].map(id => [id, element()]));
const value = element(), change = element();
const index = { dataset: { heroIndex: 'SP500' }, querySelector: selector => selector === '.hero-index-value' ? value : change };
const fxItems = ['USD','EUR','JPY'].map(currency => {
  const value = element(), change = element();
  return {dataset:{heroFx:currency},value,change,querySelector:selector => selector === '.hero-index-value' ? value : change};
});
let savedPage;
const context = vm.createContext({
  window: {}, data:{fx:{USD:1346.12,EUR:1562.34,JPY:8.59},fx_updated:'2026-09-05'},
  storageGet: () => null, storageSet: (key,value) => {savedPage=value;}, heroSummaryStorage: { page: 'hero-page' }, selectionMode: 'all', krw: n => String(n),
  document: { getElementById: id => ids[id], querySelectorAll: selector => selector === '[data-hero-fx]' ? fxItems : [index] },
  findTickerMeta: () => ({ current_price: 6000.12, change_pct: 1.23 }),
  fmt1: new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  fmt2: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  esc: s => String(s).replaceAll('<', '&lt;'),
});
vm.runInContext(fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8'), context);
context.findTickerMeta = () => ({ current_price: 6000.12, change_pct: 1.23 });
vm.runInContext('renderHeroSummaryPage()', context);
assert.equal(ids.heroIndexPage.classList.hidden, true);
assert.equal(ids.heroIndexPage.inert, true);
assert.equal(value.textContent, '6,000.1'); // populated while hidden
vm.runInContext('updateHeroSummary(new Map(), {value_krw: 10000, change_krw: 100}, [])', context);
assert.equal(ids.heroValue.textContent, '10000');
assert.equal(ids.heroValue.attrs['aria-label'], '총 평가액 · 전체 계좌');
assert.doesNotMatch(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /id="heroLabel"|id="heroIndexAsOf"/);
vm.runInContext('heroSummaryPage = "indexes"; renderHeroSummaryPage()', context);
assert.equal(ids.heroPortfolioPage.classList.hidden, true);
assert.equal(ids.heroPortfolioPage.inert, true);
assert.equal(ids.heroIndexPage.attrs['aria-hidden'], 'false');
assert.equal(ids.heroIndexPage.inert, false);
assert.equal(ids.heroNext.attrs['aria-label'], '환율 보기');
context.toggleHeroSummaryPage();
assert.equal(savedPage, 'fx');
assert.equal(ids.heroFxPage.classList.hidden, false);
assert.equal(ids.heroIndexPage.inert, true);
assert.equal(ids.heroPortfolioPage.inert, true);
assert.equal(ids.heroNext.attrs['aria-label'], '계좌 요약 보기');
assert.deepEqual(fxItems.map(item => item.value.textContent), ['1,346.12','1,562.34','8.59']);
assert.match(fxItems[2].title, /1 JPY 기준 원화/);
context.toggleHeroSummaryPage();
assert.equal(savedPage, 'portfolio');
assert.equal(ids.heroFxPage.inert, true);
context.data.fx = {};
context.findTickerMeta = () => null;
context.renderHeroSummaryPage();
assert.deepEqual(fxItems.map(item => item.value.textContent), ['조회불가','조회불가','조회불가']);
assert.equal(fxItems[0].change.textContent, '-');
for (const [pct, text, cls] of [[1.23, '▲ 1.23%', 'up'], [-1.23, '▼ 1.23%', 'down'], [0, '→ 0.00%', 'flat']]) {
  context.findTickerMeta = () => ({ current_price: 6000, change_pct: pct });
  vm.runInContext('renderHeroSummaryPage()', context);
  assert.equal(change.textContent, text);
  assert.equal(change.className, `hero-index-change pct-chip ${cls}`);
}
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.doesNotMatch(page, /id="heroPrev"/);
assert.match(page, /id="heroNext"/);
assert.doesNotMatch(page, /id="fxTop"/);
assert.match(page, /class="service-logo"/);
assert.ok(page.indexOf('id="heroFxPage"') > page.indexOf('id="heroIndexPage"'));
assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 34px;/);
assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 28px;/);
console.log('Hero shared sizing and inactive-page rendering checks passed.');

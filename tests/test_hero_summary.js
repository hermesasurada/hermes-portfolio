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
const ids = Object.fromEntries(['heroPortfolioPage', 'heroIndexPage', 'heroPrev', 'heroNext', 'heroIndexAsOf'].map(id => [id, element()]));
const value = element(), change = element();
const index = { dataset: { heroIndex: 'SP500' }, querySelector: selector => selector === '.hero-index-value' ? value : change };
const context = vm.createContext({
  window: {}, heroSummaryPage: 'portfolio', data: { price_updated_at: '2026-09-05 12:00' },
  document: { getElementById: id => ids[id], querySelectorAll: () => [index] },
  findTickerMeta: () => ({ current_price: 6000.12, change_pct: 1.23 }),
  fmt1: new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  fmt2: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  esc: s => String(s).replaceAll('<', '&lt;'),
});
vm.runInContext(fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8'), context);
vm.runInContext('renderHeroSummaryPage()', context);
assert.equal(ids.heroIndexPage.classList.hidden, true);
assert.equal(ids.heroIndexPage.inert, true);
assert.equal(value.textContent, '6,000.1'); // populated while hidden
assert.match(ids.heroIndexAsOf.innerHTML, /2026-09-05 12:00/);
vm.runInContext('heroSummaryPage = "indexes"; renderHeroSummaryPage()', context);
assert.equal(ids.heroPortfolioPage.classList.hidden, true);
assert.equal(ids.heroPortfolioPage.inert, true);
assert.equal(ids.heroIndexPage.attrs['aria-hidden'], 'false');
assert.equal(ids.heroIndexPage.inert, false);
console.log('Hero shared sizing and inactive-page rendering checks passed.');

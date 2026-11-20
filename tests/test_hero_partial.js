// 전광판 부분 펼침(2026-11-20 디자인 재검토 06): 일곱 칸은 안 들어가도 계좌 요약 + 한 묶음이 들어가면
// 계좌 요약은 늘 보이고 옆 묶음만 지수 ↔ 환율로 넘긴다. 그것도 안 들어가면 캐러셀.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../portfolio_static');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

assert.match(css, /\.hero-strip\.hero-combined\.hero-partial \.hero-summary-dots,\s*\.hero-strip\.hero-combined\.hero-partial \.hero-summary-nav \{ display: inline-flex; \}/);
assert.match(css, /\.hero-strip\.hero-partial \.hero-summary-dot\[data-hero-page="portfolio"\] \{ display: none; \}/);
assert.match(css, /\.hero-strip\.hero-partial:not\(\.hero-partial-fx\) \.hero-page-shell > \.hero-fx-page,\s*\.hero-strip\.hero-partial\.hero-partial-fx \.hero-page-shell > \.hero-index-page \{ display: none !important; \}/);

function classes() {
  const set = new Set();
  return { set, add: n => set.add(n), remove: n => set.delete(n), contains: n => set.has(n),
    toggle(n, force) { const on = force === undefined ? !set.has(n) : force; on ? set.add(n) : set.delete(n); return on; } };
}
const element = (extra = {}) => ({ attrs: {}, classList: classes(), dataset: {}, setAttribute(k, v) { this.attrs[k] = v; }, ...extra });
const strip = element();
const shell = element({ clientWidth: 1000 });
// 넘침은 배치 클래스에 따라 다르다: 일곱 칸(합침) / 계좌+지수 / 계좌+환율.
const widths = { combined: 1400, partial: 800, partialFx: 820 };
Object.defineProperty(shell, 'scrollWidth', { get() {
  const c = strip.classList;
  const w = !c.contains('hero-combined') ? 0 : !c.contains('hero-partial') ? widths.combined : c.contains('hero-partial-fx') ? widths.partialFx : widths.partial;
  return Math.max(w, this.clientWidth);
} });
const pages = { heroPortfolioPage: element(), heroIndexPage: element(), heroFxPage: element() };
const dots = ['portfolio', 'indexes', 'fx'].map(page => element({ dataset: { heroPage: page } }));
const next = element();
const ids = { heroStrip: strip, heroPageShell: shell, heroNext: next, ...pages };
const context = vm.createContext({
  window: {}, data: { fx: {} },
  storageGet: () => null, storageSet: () => {}, heroSummaryStorage: { page: 'hero-page' },
  document: { getElementById: id => ids[id], querySelectorAll: selector => (selector.includes('hero-summary-dot') ? dots : []) },
  findTickerMeta: () => null,
});
vm.runInContext(fs.readFileSync(path.join(root, 'format.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8'), context);
const hidden = () => Object.values(pages).map(p => p.classList.contains('hidden'));
const page = () => vm.runInContext('heroSummaryPage', context);
const currentDot = () => dots.find(dot => dot.attrs['aria-current'] === 'true')?.dataset.heroPage;

// 부분 펼침: 계좌 요약 + 지수가 보이고 환율은 숨는다. 클래스는 hero-combined + hero-partial.
vm.runInContext('renderHeroSummaryPage()', context);
assert.deepEqual([...strip.classList.set].sort(), ['hero-combined', 'hero-partial']);
assert.equal(vm.runInContext('heroCombined()', context), false, '부분 펼침은 넘길 면이 있다');
assert.equal(vm.runInContext('heroPartial()', context), true);
assert.deepEqual(hidden(), [false, false, true]);
assert.equal(pages.heroFxPage.inert, true);
assert.equal(currentDot(), 'indexes');
assert.equal(next.title, '환율 보기');

// 다음: 환율로. 계좌 요약은 그대로 보인다.
vm.runInContext('toggleHeroSummaryPage(1)', context);
assert.equal(page(), 'fx');
assert.equal(strip.classList.contains('hero-partial-fx'), true);
assert.deepEqual(hidden(), [false, true, false]);
assert.equal(currentDot(), 'fx');
assert.equal(next.title, '주요 지수 보기');
// 다시 다음: 지수로(두 면만 돈다).
vm.runInContext('toggleHeroSummaryPage(1)', context);
assert.equal(page(), 'indexes');
assert.equal(strip.classList.contains('hero-partial-fx'), false);
assert.deepEqual(hidden(), [false, false, true]);
vm.runInContext('toggleHeroSummaryPage(-1)', context);
assert.equal(page(), 'fx');

// 환율 묶음이 안 들어가면 부분 펼침을 쓰지 않는다(두 묶음 모두 들어가야 한다) → 캐러셀.
widths.partialFx = 1100;
vm.runInContext('syncHeroLayout()', context);
assert.deepEqual([...strip.classList.set], []);
assert.deepEqual(hidden(), [true, true, false]);   // 캐러셀: 현재 면(환율)만

// 넓어져 일곱 칸이 다 들어가면 합친 전광판.
widths.combined = 900; widths.partialFx = 820;
vm.runInContext('syncHeroLayout()', context);
assert.deepEqual([...strip.classList.set], ['hero-combined']);
assert.deepEqual(hidden(), [false, false, false]);

// 980px 이하는 부분 펼침을 쓰지 않는다.
widths.combined = 1400;
context.window.matchMedia = () => ({ matches: true });
vm.runInContext('syncHeroLayout()', context);
assert.equal(strip.classList.contains('hero-partial'), false);
console.log('hero partial ok');

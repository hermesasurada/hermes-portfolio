// PC 합친 전광판 — 일곱 칸이 한 줄에 들어가면 세 면을 모두 펼치고, 모자라면 캐러셀로 돌아간다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../portfolio_static');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

// ── CSS 계약 ──
// 칸은 <a class="ticker-link">라 뒤에 선언된 .ticker-link가 같은 특이도로 padding·border·width를 덮었다.
// 그리드 부모를 붙인 선택자가 기본·모바일 양쪽에 있어야 한다.
assert.match(css, /\.hero-index-grid > \.hero-index-item \{\s*display: grid;[^}]*padding: 0 14px;[^}]*border-left: 1px solid var\(--line\);/);
assert.doesNotMatch(css, /^\.hero-index-item \{/m, '특이도 낮은 기본 규칙이 돌아오면 .ticker-link에 다시 덮인다');
assert.match(css, /@media[^{]*980px[\s\S]*\.hero-index-grid > \.hero-index-item \{[^}]*border-left: 0;/);
// 합친 모드: 칸은 내용 폭 아래로 줄지 않고(max-content) 남는 폭만 나눈다 — 그래야 모자랄 때 넘치고, JS가 그 넘침으로 판정한다.
assert.match(css, /\.hero-strip\.hero-combined \.hero-page-shell \{[^}]*grid-template-columns: max-content minmax\(max-content, 1fr\) minmax\(max-content, 1fr\);/);
assert.match(css, /\.hero-strip\.hero-combined \.hero-index-grid \{[^}]*repeat\(3, minmax\(max-content, 1fr\)\)/);
// width:100%를 남기면 면의 margin-left가 트랙 밖으로 밀려 늘 넘친다(실측 오판 이력).
assert.match(css, /\.hero-strip\.hero-combined \.hero-page-shell > \.hero-summary-page \{ grid-area: auto; width: auto; \}/);
assert.match(css, /\.hero-strip\.hero-combined \.hero-summary-dots,\s*\.hero-strip\.hero-combined \.hero-summary-nav \{ display: none; \}/);
// 칩을 이름 옆으로 올리는 배치는 칸 안으로 한정 — 계좌 요약의 '총 평가액' 라벨도 .hero-index-name이다.
assert.match(css, /\.hero-strip\.hero-combined \.hero-index-item \.hero-index-name \{ grid-area: name; \}/);
assert.doesNotMatch(css, /\.hero-strip\.hero-combined \.hero-index-name \{/);

// ── JS 동작 ──
function classes(initial = []) {
  const set = new Set(initial);
  return { set,
    add: n => set.add(n), remove: n => set.delete(n), contains: n => set.has(n),
    toggle(n, force) { const on = force === undefined ? !set.has(n) : force; on ? set.add(n) : set.delete(n); return on; } };
}
function element(extra = {}) {
  return { attrs: {}, classList: classes(), setAttribute(k, v) { this.attrs[k] = v; }, ...extra };
}
let contentWidth = 1200;
const strip = element({ clientWidth: 1374 });
const shell = element({ clientWidth: 1300 });
// 객체 스프레드는 getter를 값으로 굳혀 버리므로 만든 뒤에 정의한다.
Object.defineProperty(shell, 'scrollWidth', { get() { return Math.max(contentWidth, this.clientWidth); } });
const pages = { heroPortfolioPage: element(), heroIndexPage: element(), heroFxPage: element() };
const ids = { heroStrip: strip, heroPageShell: shell, heroNext: element(), ...pages };
const context = vm.createContext({
  window: {}, data: { fx: {} },
  storageGet: () => null, storageSet: () => {}, heroSummaryStorage: { page: 'hero-page' },
  document: { getElementById: id => ids[id], querySelectorAll: () => [] },
  findTickerMeta: () => null,
  fmt1: new Intl.NumberFormat('en-US'), fmt2: new Intl.NumberFormat('en-US'),
});
vm.runInContext(fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8'), context);
const hidden = () => Object.values(pages).map(p => p.classList.contains('hidden'));
const inert = () => Object.values(pages).map(p => Boolean(p.inert));

// 들어가면 합친 모드: 세 면 모두 보이고 조작 가능(inert가 남으면 지수·환율 링크가 안 눌린다)
contentWidth = 1200;
vm.runInContext('renderHeroSummaryPage()', context);
assert.equal(strip.classList.contains('hero-combined'), true);
assert.deepEqual(hidden(), [false, false, false]);
assert.deepEqual(inert(), [false, false, false]);
assert.deepEqual(Object.values(pages).map(p => p.attrs['aria-hidden']), ['false', 'false', 'false']);
// 넘길 면이 없으므로 다음 버튼·스와이프 경로는 아무것도 바꾸지 않는다
vm.runInContext('toggleHeroSummaryPage()', context);
assert.equal(context.heroSummaryPage ?? vm.runInContext('heroSummaryPage', context), 'portfolio');
assert.deepEqual(hidden(), [false, false, false]);

// 모자라면(넘치면) 캐러셀로 복귀 — 현재 면만 보이고 나머지는 inert
contentWidth = 1400;
vm.runInContext('syncHeroLayout()', context);
assert.equal(strip.classList.contains('hero-combined'), false);
assert.deepEqual(hidden(), [false, true, true]);
assert.deepEqual(inert(), [false, true, true]);
vm.runInContext('toggleHeroSummaryPage()', context);
assert.equal(vm.runInContext('heroSummaryPage', context), 'indexes');
assert.deepEqual(hidden(), [true, false, true]);

// 다시 넓어지면 합친 모드로 — 판정 중 잠깐 붙인 클래스가 캐러셀 상태에 새지 않는다
contentWidth = 1300; // clientWidth와 같으면 들어간다(1px 허용)
vm.runInContext('syncHeroLayout()', context);
assert.equal(strip.classList.contains('hero-combined'), true);
assert.deepEqual(hidden(), [false, false, false]);
contentWidth = 1302;
assert.equal(vm.runInContext('heroFitsCombined(document.getElementById("heroStrip"))', context), false);
assert.equal(strip.classList.contains('hero-combined'), true, '측정은 원래 상태를 되돌려 놓는다');
console.log('Hero combined: fit-based switch, all pages interactive, carousel fallback, CSS specificity guard OK');

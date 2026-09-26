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
// 페이지 점 — 현재 면만 aria-current="true"가 된다.
const dots = ['portfolio', 'indexes', 'fx'].map(page => ({ ...element(), dataset: { heroPage: page } }));
const context = vm.createContext({
  window: {}, data:{fx:{USD:1346.12,EUR:1562.34,JPY:8.59},fx_updated:'2026-09-05'},
  storageGet: () => null, storageSet: (key,value) => {savedPage=value;}, heroSummaryStorage: { page: 'hero-page' }, selectionMode: 'all', krw: n => String(n),
  document: { getElementById: id => ids[id],
    querySelectorAll: selector => selector === '[data-hero-fx]' ? fxItems
      : selector.includes('hero-summary-dot') ? dots : [index] },
  findTickerMeta: () => ({ current_price: 6000.12, change_pct: 1.23 }),
  fmt1: new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  fmt2: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  esc: s => String(s).replaceAll('<', '&lt;'),
});
// 등락 방향 등 공용 서식은 실제 format.js를 쓴다 — 테스트가 심어 둔 스텁은 그 뒤에 다시 덮는다.
{
  const stubs = { ...context };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../portfolio_static/format.js'), 'utf8'), context);
  Object.assign(context, stubs);
}
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
// 점은 현재 면 하나만 켜진다.
assert.deepEqual(dots.map(dot => dot.attrs['aria-current']), ['false', 'true', 'false']);
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
for (const [pct, text, cls] of [[1.23, '▲ 1.23%', 'up'], [-1.23, '▼ 1.23%', 'down'], [0, '→ 0%', 'flat']]) {
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
// 요약 · 페이지 점 · 다음 버튼 세 칸(점 칸이 빠지면 점이 요약 폭을 먹는다).
assert.match(css, /grid-template-columns: minmax\(0, 1fr\) auto 34px;/);
assert.match(css, /grid-template-columns: minmax\(0, 1fr\) auto 28px;/);
// 지수·환율 칸은 균등 분할 — 예전 flex 최소폭 조합은 합이 넘치면 마지막 칸을 잘랐다.
assert.match(css, /\.hero-index-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
// 클릭하면 해당 지수·환율 차트로 — 표와 같은 .ticker-link 위임을 탄다.
for (const ticker of ['SP500', 'NASDAQ', 'KOSPI', 'USDKRW', 'EURKRW', 'JPYKRW']) {
  assert.ok(page.includes(`data-chart-ticker="${ticker}"`), `hero 링크 없음: ${ticker}`);
}
assert.equal((page.match(/class="ticker-link hero-index-item"/g) || []).length, 6);
assert.equal((page.match(/class="hero-summary-dot"/g) || []).length, 3);
// 전광판 스와이프가 칸 클릭을 삼키면 안 된다(2026-09-17 PC 무반응 회귀).
const holdings = fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8');
const carousel = holdings.slice(holdings.indexOf('function initHeroSummaryCarousel('),
  holdings.indexOf('function ', holdings.indexOf('function initHeroSummaryCarousel(') + 40));
// setPointerCapture를 걸면 뒤따르는 click의 target이 캡처 요소로 바뀌어
// 칸 안의 링크를 .ticker-link 위임이 못 찾는다(주석 언급은 제외하고 호출만 본다).
assert.doesNotMatch(carousel, /shell\.setPointerCapture/);
// pointerdown 처리기 안의 preventDefault는 click을 통째로 없앤다.
const pointerdownStart = carousel.indexOf('shell.addEventListener("pointerdown"');
const pointerdownBody = carousel.slice(pointerdownStart, carousel.indexOf('});', pointerdownStart));
assert.ok(pointerdownStart > 0);
assert.doesNotMatch(pointerdownBody, /preventDefault/);
// 링크 위에서 끌면 브라우저 기본 드래그가 포인터 시퀀스를 끊어 스와이프가 죽는다.
assert.match(carousel, /"dragstart", event => event\.preventDefault\(\)/);
assert.match(css, /a\.hero-index-item \{[^}]*-webkit-user-drag: none/);
// 스와이프 직후의 click은 삼켜 면 전환과 차트 이동이 겹치지 않게 한다.
assert.match(carousel, /if \(!swiped\) return;/);
console.log('Hero sizing, page dots, chart links and swipe-vs-click checks passed.');

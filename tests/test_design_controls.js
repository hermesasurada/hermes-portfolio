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
// 삭제(×) 열은 고정하지 않는다 — 오른쪽 sticky는 가로 스크롤 중 마지막 열을 덮는다.
assert.doesNotMatch(css, /\.interest-delete-col[^{]*\{[^}]*position: sticky/);
// 장 상태는 칩 모양으로(2026-11-20): 위첨자 '휴'·'종' 배지와 그 자리 패딩은 없앤다.
assert.doesNotMatch(css, /change-session-note|change-with-session/);
assert.doesNotMatch(css, /#interestTableWrap \.interest-detail-list td\[data-interest-col="2"\] \{\s*padding-right: 9px;/);
assert.match(css, /\.pct-chip\.session-closed,\s*\.pct-chip\.session-holiday \{\s*background: transparent;\s*outline: 1px solid[^}]*outline-offset: -1px;/);
assert.match(css, /\.pct-chip\.session-holiday \{ outline-style: dashed;/);
assert.match(css, /\.title-tools:not\(\.filters-expanded\) :is\(#interestSectorControl, #tagFilterControl, #currencyFilterControl\)/);
for (const file of ['index.html','state.js','app.js','app-holdings.js','styles.css']) {
  assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'), /showIndexes|ignoreIndexes|function indexRows\(/);
}
assert.doesNotMatch(css, /SA News식|backdrop-filter: blur\(18px\)/);
assert.match(css, /--up: #dc3545/);
assert.match(css, /--down: #1976d2/);
// 토글(연장·갱신·차트 머리 토글)의 hover 강조는 마우스 기기에서만 — 터치에선 탭 뒤 :hover가 남아
// 끈 상태가 켜짐처럼 보였다(2026-11-18, 모바일 연장 버튼).
for (const sel of ['.controls .us-price-control:hover', '.cycle-toggle-btn:hover', '.chart-head-toggle:hover']) {
  const at = css.indexOf(sel);
  assert.ok(at > 0, `${sel} 규칙 없음`);
  const before = css.slice(0, at);
  const open = before.lastIndexOf('@media (hover: hover) {');
  assert.ok(open > before.lastIndexOf('\n}'), `${sel}가 (hover: hover) 안에 없다`);
}
// 폰 폭 연장 버튼은 다른 순환 버튼(4px)보다 좌우 여백을 조금 더(2026-11-18)
assert.match(css, /@media \(max-width: 480px\) \{[^@]*\.controls \.ctrl-group \.us-price-control \{ padding: 0 7px; \}/);
// PC 개별종목 머리(2026-11-19): 이름·로고 크게, 정규·장외 가격 같은 크기, 태그는 가격 오른쪽, 컨센서스 3열×2줄
{
  const at = css.lastIndexOf('/* ── PC 개별종목 머리(2026-11-19');
  assert.ok(at > 0, 'PC 개별종목 머리 블록 없음');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  assert.match(block, /@media \(min-width: 981px\)/);
  assert.match(block, /strong#chartName \{ font-size: 24px; \}/);
  assert.match(block, /\.chart-icon-slot \.asset-icon \{ width: 60px; height: 60px;/);
  assert.match(block, /\.chart-price-row\.extended \.chart-price-current \{ font-size: 24px; \}/);
  assert.match(css, /\.chart-price-current \{ font-size: 24px; \}/);
  assert.match(block, /\.chart-identity > \.chart-tags \{ flex: 0 1 auto;/);
  assert.match(block, /\.consensus-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
}
console.log('Design controls: always-on watchlist editing, mobile expansion, active filters and palette invariants passed.');

// 디자인 재검토 07(2026-11-20): 보조 글자 대비, 좁은 화면의 터치 영역.
{
  const h = require('./harness');
  const lum = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const light = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const token = name => light.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
  for (const surface of ['bg', 'panel', 'surface-2']) {
    assert.ok(contrast(token('muted'), token(surface)) >= 4.5, `보조 글자 대비 ${surface}`);
  }
  const narrow = h.mediaBlocks(css, '(max-width: 980px)').map(block => block.text).join('\n');
  assert.match(narrow, /::before \{\s*content: "";\s*position: absolute;\s*inset: var\(--hit-y, 0px\) var\(--hit-x, 0px\);/);
  assert.match(narrow, /\.chart-head-toggle, \.chart-range-btn \{ --hit-y: -5px; --hit-x: -1px; \}/);
  // 태그 칩은 글자만 말줄임(칩이 넘침을 자르면 터치 영역도 잘린다).
  assert.match(css, /\.chart-tags \.tag-chip \{ overflow: visible; \}/);
  assert.match(h.readStatic('app-ticker-tags.js'), /class="tag-chip chart-tag"[^>]*><span>#\$\{esc\(tag\)\}<\/span><\/button>/);
}

// 디자인 재검토 02(2026-11-20): 선택·조작 색은 바이올렛, 데이터 색(하락 파랑·가격선)과 분리.
{
  const h = require('./harness');
  const light = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const darkStart = css.indexOf(':root[data-theme="dark"] {');
  const dark = css.slice(darkStart, css.indexOf('}', darkStart));
  const token = (block, name) => block.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
  for (const block of [light, dark]) {
    assert.equal(token(block, 'accent'), token(block, 'brand'));
    assert.equal(token(block, 'focus'), token(block, 'brand'));
    assert.notEqual(token(block, 'brand'), token(block, 'down'), '선택색과 하락색이 같으면 안 된다');
    assert.notEqual(token(block, 'brand'), token(block, 'chart-price'));
    const [r, g, b] = [1, 3, 5].map(i => parseInt(token(block, 'brand').slice(i, i + 2), 16));
    assert.ok(r > g && b > r, `선택색은 바이올렛 계열(파랑에 빨강이 섞임): ${token(block, 'brand')}`);
  }
  // 데이터 선은 선택색을 쓰지 않는다.
  assert.doesNotMatch(h.readStatic('app-charts.js'), /color: "var\(--brand\)"/);
  assert.match(h.readStatic('app.js'), /const chartCompareColors = \["var\(--chart-price\)"/);
  // RSI·BB 치우침은 글자색이 아니라 바탕 틴트.
  const ctx = h.loadScripts(h.createContext());
  const low = ctx.indicatorText(28, 'rsi');
  assert.match(low, /--tone: color-mix\(in srgb, var\(--down\) 26%, transparent\)/);
  assert.doesNotMatch(low, /style="color:/);
  assert.match(css, /\.indicator-tone \{[^}]*background: var\(--tone, transparent\);[^}]*color: var\(--ink\);/);
}

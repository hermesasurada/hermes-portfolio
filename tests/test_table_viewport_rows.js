// 표는 기본 12행 + 헤더까지만 보이고 나머지는 표 안에서 스크롤한다.
// 행 높이는 변수(--list-row-height)가 최소값이라 CSS 계산식으로는 어긋난다 — 실측값을 쓴다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../portfolio_static');
const holdings = fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

// CSS는 JS가 채우는 변수만 읽는다 — 식으로 계산하면 PC에서 10행이 9.5행이 된다.
assert.match(css, /max-height: var\(--list-rows-max-height, calc\(100vh - 190px\)\);/);
assert.doesNotMatch(css, /--list-visible-rows/);

const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
ctx.window.innerHeight = 900;
assert.equal(h.evaluate(ctx, 'LIST_VISIBLE_ROWS'), 12);

const makeWrap = (rowHeight, headHeight, { visible = true } = {}) => {
  const vars = {};
  const rect = h => ({ getBoundingClientRect: () => ({ height: h }) });
  return {
    vars,
    offsetParent: visible ? {} : null,
    style: { setProperty: (k, v) => { vars[k] = v; } },
    querySelector: sel => sel === 'tbody' ? { querySelector: () => rect(rowHeight) }
      : sel === 'thead' ? rect(headHeight) : null,
  };
};
const run = wraps => {
  ctx.document.querySelectorAll = () => wraps;
  h.evaluate(ctx, 'syncTableViewportRows()');
};

// PC: 헤더 48 + 47.5 × 12 + 2 = 620 (변수식 45 × 12면 588이라 11.4행이 된다)
const pc = makeWrap(47.5, 48);
run([pc]);
assert.equal(pc.vars['--list-rows-max-height'], '620px');
// 모바일: 헤더 34 + 40 × 12 + 2 = 516
const mobile = makeWrap(40, 34);
run([mobile]);
assert.equal(mobile.vars['--list-rows-max-height'], '516px');
// 관심목록은 헤더가 2행(22 + 34.8)이라 그만큼 더 잡는다 — 헤더를 재므로 자동이다.
const interest = makeWrap(47.5, 70);
run([interest]);
assert.equal(interest.vars['--list-rows-max-height'], '642px');
// A short viewport does not silently override the requested number of rows.
ctx.window.innerHeight = 500;
const short = makeWrap(47.5, 48);
run([short]);
assert.equal(short.vars['--list-rows-max-height'], '620px');
ctx.window.innerHeight = 900;
ctx.setListVisibleRows(20);
run([pc, mobile]);
assert.equal(pc.vars['--list-rows-max-height'], '1000px');
assert.equal(mobile.vars['--list-rows-max-height'], '836px');
assert.equal(ctx.localStorage.getItem('portfolio.detail.visibleRows'), '20');
assert.equal(ctx.document.getElementById('visibleRowsInput').value, '20');
const restored = h.createContext();
restored.localStorage.setItem('portfolio.detail.visibleRows', ctx.localStorage.getItem('portfolio.detail.visibleRows'));
h.loadScripts(restored);
assert.equal(h.evaluate(restored, 'selectedListVisibleRows'), 20);
assert.equal(restored.document.getElementById('visibleRowsInput').value, '20');
assert.equal(ctx.normalizeVisibleRows(null), 12);
assert.equal(ctx.normalizeVisibleRows('bad'), 12);
assert.equal(ctx.normalizeVisibleRows(''), 12);
assert.equal(ctx.normalizeVisibleRows(0), 1);
assert.equal(ctx.normalizeVisibleRows(1000), 100);
ctx.setListVisibleRows('');
assert.equal(h.evaluate(ctx, 'selectedListVisibleRows'), 20);
ctx.setListVisibleRows(12);
// 숨은 표는 건드리지 않는다(높이 0으로 굳는 것 방지).
const hidden = makeWrap(47.5, 48, { visible: false });
run([hidden]);
assert.equal(hidden.vars['--list-rows-max-height'], undefined);

// 렌더 직후 동기 호출 — rAF에 미루면 백그라운드 탭에서 높이가 늦게 잡힌다.
assert.match(holdings, /function scheduleTableViewportRows\(\) \{\s*\n\s*syncTableViewportRows\(\);/);
for (const file of ['app-tabs.js', 'app-interest-watchlists.js']) {
  assert.ok(fs.readFileSync(path.join(root, file), 'utf8').includes('scheduleTableViewportRows()'),
    `${file}에서 표를 그린 뒤 10행 뷰포트를 잡지 않는다`);
}
console.log('table viewport: configurable rows, persistence, validation and hidden-table guard ok');

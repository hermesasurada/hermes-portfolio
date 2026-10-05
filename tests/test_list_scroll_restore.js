// 목록 → 차트 → 목록: 차트를 여는 동안 표를 숨기고 행을 비워 스크롤이 0이 되므로, 열기 직전 위치를 되돌린다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());

const wraps = Object.fromEntries(['detailTableWrap', 'interestTableWrap', 'dividendTableWrap'].map(id => [id, h.element({id, scrollTop: 0, scrollLeft: 0})]));
const show = id => Object.entries(wraps).forEach(([key, el]) => el.classList.toggle('hidden', key !== id));
ctx.document.getElementById = id => wraps[id] || null;
let windowY = 0;
ctx.window.scrollY = 0;
ctx.window.scrollTo = (_, y) => { windowY = y; };
let windowRenders = 0;
ctx.renderInterestRowsWindow = () => { windowRenders += 1; };
const run = code => h.evaluate(ctx, code);

// 세부내역 표: 위치를 기억했다가 그대로 되돌린다(가로 스크롤 포함)
show('detailTableWrap');
Object.assign(wraps.detailTableWrap, {scrollTop: 600, scrollLeft: 200});
ctx.window.scrollY = 150;
run('chartTicker = null; performanceChartOpen = false; rememberListScroll()');
Object.assign(wraps.detailTableWrap, {scrollTop: 0, scrollLeft: 0});
run('restoreListScroll()');
assert.equal(wraps.detailTableWrap.scrollTop, 600);
assert.equal(wraps.detailTableWrap.scrollLeft, 200);
assert.equal(windowY, 150);

// 차트에서 다른 차트로 넘어가도 처음 목록 위치를 지킨다
Object.assign(wraps.detailTableWrap, {scrollTop: 480});
run('rememberListScroll()');
wraps.detailTableWrap.scrollTop = 0;
run('chartTicker = "NVDA"; rememberListScroll(); chartTicker = null; restoreListScroll()');
assert.equal(wraps.detailTableWrap.scrollTop, 480);

// 관심목록은 창 렌더링이라 되돌린 위치의 행을 바로 다시 그린다
show('interestTableWrap');
wraps.interestTableWrap.scrollTop = 6000;
run('rememberListScroll(); interestVirtual = {rows: []}');
wraps.interestTableWrap.scrollTop = 0;
run('restoreListScroll(); interestVirtual = null');
assert.equal(wraps.interestTableWrap.scrollTop, 6000);
assert.equal(windowRenders, 1);

// 차트에 있는 동안 다른 표로 바뀌었으면 그 표는 건드리지 않는다
wraps.interestTableWrap.scrollTop = 900;
run('rememberListScroll()');
show('detailTableWrap');
wraps.detailTableWrap.scrollTop = 0;
run('restoreListScroll()');
assert.equal(wraps.detailTableWrap.scrollTop, 0);

// 한 번 되돌리면 기억을 지운다
wraps.detailTableWrap.scrollTop = 77;
run('restoreListScroll()');
assert.equal(wraps.detailTableWrap.scrollTop, 77);

console.log('list scroll restore ok');

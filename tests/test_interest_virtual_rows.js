// 관심목록 창 렌더링 — 큰 그룹은 보이는 행(+여유분)만 그리고 나머지는 빈 행 높이로 채운다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());

const rows = Array.from({length: 258}, (_, i) => ({ticker: `T${i}`, name: `N${i}`}));
const body = h.element({childElementCount: 0});
Object.defineProperty(body, 'innerHTML', {
  get() { return this._html || ''; },
  set(v) { this._html = v; this.childElementCount = (v.match(/<tr/g) || []).length; },
});
const wrap = h.element({scrollTop: 0, clientHeight: 564});
wrap.querySelector = sel => (sel === 'thead' ? {offsetHeight: 70} : null);
ctx.document.getElementById = id => ({interestRows: body, interestTableWrap: wrap}[id] || null);
ctx.interestRowCells = row => `<td>${row.ticker}</td>`;
ctx.tableRowClass = () => '';
ctx.interestModeActive = () => true;
const setView = extra => { ctx.__view = {rows, columns: [{key: 'a'}, {key: 'b'}], group: {}, suppress: false, rowHeight: 47, start: 0, end: 0, ...extra};
  h.evaluate(ctx, 'interestVirtual = __view'); };
const view = () => h.evaluate(ctx, 'interestVirtual');
const render = force => h.evaluate(ctx, `renderInterestRowsWindow(${force})`);
const drawnTickers = () => [...body.innerHTML.matchAll(/<td>(T\d+)<\/td>/g)].map(m => m[1]);
const spacers = () => [...body.innerHTML.matchAll(/virtual-spacer[^>]*><td colspan="2" style="height:(\d+(?:\.\d+)?)px"/g)].map(m => Number(m[1]));

// 맨 위: 0행부터 (12행 + 여유 12행)까지, 아래는 빈 행 하나로 나머지 높이
setView(); render(true);
assert.equal(view().start, 0);
assert.equal(drawnTickers()[0], 'T0');
assert.ok(drawnTickers().length >= 24 && drawnTickers().length < 60, `그린 행 수: ${drawnTickers().length}`);
assert.equal(JSON.stringify(spacers()), JSON.stringify([(258 - view().end) * 47]));

// 중간: 보이는 첫 행 = floor((scrollTop - 헤더) / 행높이), 앞뒤 빈 행 높이 합 + 그린 행 = 전체 높이
wrap.scrollTop = 70 + 100 * 47;
render(false);
const v = view();
assert.equal(v.start, 100 - 12);
assert.ok(drawnTickers().includes('T100') && drawnTickers().includes('T111'));
assert.equal(spacers().reduce((a, b) => a + b, 0) + (v.end - v.start) * 47, 258 * 47);

// 그려 둔 구간 안에서 조금 움직이면 다시 그리지 않는다(스크롤 이벤트마다 부르므로)
const before = body.innerHTML;
wrap.scrollTop += 47 * 3;
render(false);
assert.equal(body.innerHTML, before);
// 가장자리에 닿으면 다시 그린다
wrap.scrollTop += 47 * 12;
render(false);
assert.notEqual(body.innerHTML, before);

// 맨 끝: 마지막 행까지 그리고 아래 빈 행은 없다
wrap.scrollTop = 70 + 258 * 47;
render(false);
assert.equal(view().end, 258);
assert.equal(drawnTickers().at(-1), 'T257');
assert.equal(spacers().length, 1);

// 표가 막 보인 직후(높이 0)에도 최소 LIST_VISIBLE_ROWS행은 그린다
wrap.scrollTop = 0; wrap.clientHeight = 0;
setView(); render(true);
assert.ok(drawnTickers().length >= h.evaluate(ctx, 'LIST_VISIBLE_ROWS'));
wrap.clientHeight = 564;

// 필터로 목록이 줄었는데 스크롤 위치가 예전 목록 아래쪽에 남아 있어도 빈 화면이 되면 안 된다
// (Astra 리뷰 2026-09-26: 200번째 행에서 80행으로 줄이면 시작 188 / 끝 80으로 행 0개 + 빈 영역 8,836px).
{
  const shrunk = rows.slice(0, 80);
  wrap.scrollTop = 70 + 200 * 47;
  setView({rows: shrunk});
  render(true);
  const v2 = view();
  assert.ok(v2.start <= v2.end, `구간이 뒤집혔다: ${v2.start}-${v2.end}`);
  assert.ok(drawnTickers().length >= h.evaluate(ctx, 'LIST_VISIBLE_ROWS'), `그린 행 ${drawnTickers().length}개`);
  assert.equal(drawnTickers().at(-1), 'T79', '목록 끝까지 보여야 한다');
  assert.equal(spacers().reduce((a, b) => a + b, 0) + (v2.end - v2.start) * 47, 80 * 47, '빈 행 + 그린 행 높이 = 전체 높이');
  wrap.scrollTop = 0;
}
// 필터·그룹이 바뀌어 목록 구성이 달라지면 스크롤을 맨 위로 되돌린다(같은 목록의 재정렬·시세 갱신은 유지).
{
  wrap.scrollTop = 5000;
  const group = {id: 7};
  h.evaluate(ctx, 'interestListKey = ""');
  assert.equal(ctx.resetInterestScrollIfListChanged(group, rows), true);
  assert.equal(wrap.scrollTop, 0);
  wrap.scrollTop = 5000;
  assert.equal(ctx.resetInterestScrollIfListChanged(group, [...rows].reverse()), false, '재정렬은 같은 목록');
  assert.equal(wrap.scrollTop, 5000);
  assert.equal(ctx.resetInterestScrollIfListChanged(group, rows.slice(0, 80)), true, '필터로 줄어듦');
  assert.equal(wrap.scrollTop, 0);
  wrap.scrollTop = 5000;
  assert.equal(ctx.resetInterestScrollIfListChanged({id: 8}, rows.slice(0, 80)), true, '같은 종목이라도 다른 그룹');
  assert.equal(wrap.scrollTop, 0);
}

// 작은 그룹은 창 렌더링 없이 전부 그린다
ctx.__small = rows.slice(0, 40);
h.evaluate(ctx, 'interestVirtual = {...__view, rows: __small}');
render(true);
assert.equal(drawnTickers().length, 40);
assert.equal(spacers().length, 0);

// 이름 열 폭은 DOM이 아니라 행 데이터 전체로 잰다(창 렌더링이라 DOM엔 일부만 있다)
const watch = h.readStatic('app-interest-watchlists.js');
assert.match(watch, /syncTickerNameColumnWidth\(table, \{ rows \}\)/);
// 행 높이 측정은 빈 행을 건너뛴다
assert.match(h.readStatic('app-holdings.js'), /querySelector\("tr:not\(\.virtual-spacer\)"\)/);
console.log('Interest virtual rows: window math, spacer heights, hysteresis, end-of-list, small groups and data-based name width OK');

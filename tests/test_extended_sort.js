const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const setDir = dir => h.evaluate(ctx, `sortState.detail = {key:'extended_change_pct',dir:${dir}}; activeDetailTab = 'detail';
  Object.assign(interestSortState, {key:'extended_change_pct',dir:${dir},manual:false});`);
const rows = [
  {ticker:'missing',extended_change_pct:null,display_change_pct:null},
  {ticker:'US',currency:'USD',extended_change_pct:2,regular_change_pct:10},
  {ticker:'EU',currency:'EUR',extended_change_pct:null,display_change_pct:3},
  {ticker:'JP',currency:'JPY',display_change_pct:-2},
  {ticker:'KR',currency:'KRW',extended_change_pct:'',change_pct:1},
  {ticker:'zero',extended_change_pct:0,display_change_pct:20},
  {ticker:'invalid',extended_change_pct:NaN,regular_change_pct:-1,display_change_pct:99},
  {ticker:'noExtendedUS',currency:'USD',extended_change_pct:Infinity,change_pct:-3},
];
const original = JSON.stringify(rows);
// 연장가를 실제로 받은 종목(US 2, zero 0)이 먼저, 나머지는 그 뒤에서 정규장 등락으로 정렬된다.
const expectedByDir = {
  '-1': ['US','zero','EU','KR','invalid','JP','noExtendedUS','missing'],
  '1': ['zero','US','noExtendedUS','JP','invalid','KR','EU','missing'],
};
const withExtended = new Set(['US','zero']);
for (const dir of [-1,1]) {
  setDir(dir);
  const expected = expectedByDir[String(dir)];
  const sorted = ctx.sortRows(rows.slice()).map(r=>r.ticker);
  assert.deepEqual(sorted, expected);
  // 두 묶음이 섞이지 않는다 — 연장가 보유분이 앞쪽에 연속으로 온다.
  assert.deepEqual(sorted.slice(0, withExtended.size).sort(), [...withExtended].sort());
  const watch = rows.slice();
  ctx.sortInterestRows(watch,{});
  assert.deepEqual(watch.map(r=>r.ticker),expected);
  // 전부 연장가가 없으면 예전처럼 정규장 등락 폴백만으로 정렬된다.
  const absent = rows.filter(r=>['EU','JP','KR','noExtendedUS'].includes(r.ticker));
  assert.deepEqual(Array.from(ctx.sortRows(absent.slice()),r=>r.ticker),expected.filter(t=>absent.some(r=>r.ticker===t)));
  // 전부 연장가가 있으면 그룹 분리가 순서를 바꾸지 않는다.
  const present = rows.filter(r=>withExtended.has(r.ticker));
  assert.deepEqual(Array.from(ctx.sortRows(present.slice()),r=>r.ticker),expected.filter(t=>withExtended.has(t)));
}
assert.equal(JSON.stringify(rows),original); // display quote fields remain untouched
assert.equal(ctx.listSortValue({extended_change_pct:'0',change_pct:10},'extended_change_pct'),0);
assert.equal(ctx.listSortValue({regular_change_pct:0,change_pct:10},'extended_change_pct'),0);
assert.equal(ctx.hasExtendedQuote({extended_change_pct:0}),true);
for (const value of [null,undefined,'',NaN,Infinity]) {
  assert.equal(ctx.hasExtendedQuote({extended_change_pct:value}),false);
}
console.log('Extended sorting: extended-quote rows grouped first, regular fallback inside each group, both directions and missing-last OK');

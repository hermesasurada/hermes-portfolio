const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({window:{}, sortState:{detail:{key:'extended_change_pct',dir:-1}},
  activeDetailTab:'detail', interestSortState:{key:'extended_change_pct',dir:-1,manual:false}});
const holdings = fs.readFileSync('portfolio_static/app-holdings.js','utf8');
vm.runInContext(holdings.slice(holdings.indexOf('function optionalNumber('), holdings.indexOf('function holdingChangeBasePrice(')), ctx);
vm.runInContext(holdings.slice(holdings.indexOf('function sortRows('), holdings.indexOf('function syncFilterToggleControls(')), ctx);
const interest = fs.readFileSync('portfolio_static/app-interest-watchlists.js','utf8');
vm.runInContext(interest.slice(interest.indexOf('function sortInterestRows('), interest.indexOf('function syncInterestDefaultSortForGroup(')), ctx);
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
const desc = ['EU','US','KR','zero','invalid','JP','noExtendedUS','missing'];
for (const dir of [-1,1]) {
  ctx.sortState.detail.dir = ctx.interestSortState.dir = dir;
  const expected = dir === -1 ? desc : [...desc.slice(0,-1)].reverse().concat('missing');
  assert.deepEqual(Array.from(ctx.sortRows(rows.slice()),r=>r.ticker),expected);
  const watch = rows.slice();
  ctx.sortInterestRows(watch,{});
  assert.deepEqual(watch.map(r=>r.ticker),expected);
  const absent = rows.filter(r=>['EU','JP','KR','noExtendedUS'].includes(r.ticker));
  assert.deepEqual(Array.from(ctx.sortRows(absent.slice()),r=>r.ticker),expected.filter(t=>absent.some(r=>r.ticker===t)));
}
assert.equal(JSON.stringify(rows),original); // display quote fields remain untouched
assert.equal(ctx.listSortValue({extended_change_pct:'0',change_pct:10},'extended_change_pct'),0);
assert.equal(ctx.listSortValue({regular_change_pct:0,change_pct:10},'extended_change_pct'),0);
console.log('Extended sorting: regular fallback, mixed markets, zero, invalid, both directions and missing-last OK');

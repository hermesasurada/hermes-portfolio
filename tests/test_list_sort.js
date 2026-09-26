// 계좌표(sortRows)와 관심목록(sortInterestRows)은 같은 비교 함수를 쓴다 — 같은 열은 두 표에서 같은 순서.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());

const orderOf = (rows, key, dir, which) => {
  const copy = rows.map(r => ({...r}));
  if (which === 'detail') {
    h.evaluate(ctx, `sortState.detail = {key: ${JSON.stringify(key)}, dir: ${dir}}; activeDetailTab = 'detail';`);
    return ctx.sortRows(copy, 'detail').map(r => r.ticker).join(',');
  }
  h.evaluate(ctx, `Object.assign(interestSortState, {key: ${JSON.stringify(key)}, dir: ${dir}, manual: false});`);
  ctx.sortInterestRows(copy, {items: []});
  return copy.map(r => r.ticker).join(',');
};

// 1) 찾았던 불일치 두 건 — 빈 값은 방향과 무관하게 맨 뒤.
const ma = [{ticker: 'A', ma20_pct: 5}, {ticker: 'B', ma20_pct: null}, {ticker: 'C', ma20_pct: -3}];
for (const which of ['detail', 'interest']) {
  assert.equal(orderOf(ma, 'ma20_pct', 1, which), 'C,A,B', `${which}: 이격 오름차순에서 빈 값이 맨 뒤가 아니다`);
  assert.equal(orderOf(ma, 'ma20_pct', -1, which), 'A,C,B');
}
const earnings = [{ticker: 'D', next_earnings_date: '2026-10-01'}, {ticker: 'E', next_earnings_date: null},
  {ticker: 'F', next_earnings_date: '2026-09-28'}, {ticker: 'G', next_earnings_date: ''}];
for (const which of ['detail', 'interest']) {
  assert.equal(orderOf(earnings, 'next_earnings_date', 1, which), 'F,D,E,G', `${which}: 실적일 오름차순에서 빈 값이 맨 뒤가 아니다`);
  assert.equal(orderOf(earnings, 'next_earnings_date', -1, which), 'D,F,E,G');
}

// 2) 정렬 가능한 모든 키에서 두 표의 순서가 같다(빈 값·0·음수·문자열 섞어서).
const detailKeys = [...h.evaluate(ctx, 'detailSortKeys')];
const interestKeys = h.evaluate(ctx, 'INTEREST_COLUMNS.map(c => c.sortKey || c.key)');
const keys = [...new Set([...detailKeys, ...interestKeys])].filter(k => k && !['logo', 'delete'].includes(k));
const samples = [-7.5, 0, 3.25, null, 12, undefined, '', 'NaN', 1e6, -0.01];
const rows = Array.from({length: 10}, (_, i) => {
  const row = {ticker: `T${i}`, name: `이름${(i * 7) % 10}`};
  for (const key of keys) row[key] = samples[(i * 3 + key.length) % samples.length];
  row.next_earnings_date = i % 3 ? `2026-10-0${i % 9 + 1}` : null;
  row.trade_timing = i % 4 ? {state: ['sell', 'wait', 'buy'][i % 3], buy_r: i, sell_atr: i} : null;
  return row;
});
for (const key of keys) {
  for (const dir of [1, -1]) {
    assert.equal(orderOf(rows, key, dir, 'interest'), orderOf(rows, key, dir, 'detail'), `두 표의 정렬이 다르다: ${key} ${dir}`);
  }
}
// 3) 빈 값을 뒤로 보내는 키 목록은 한 곳에만 있다.
const source = h.readStatic('app-holdings.js') + h.readStatic('app-interest-watchlists.js');
assert.equal((source.match(/const MISSING_LAST_SORT_KEYS/g) || []).length, 1);
// 관심목록 정렬 함수 본문(소스 검사)에 별도 비교 규칙이 다시 생기지 않는다.
const watch = h.readStatic('app-interest-watchlists.js');
const sortBody = watch.slice(watch.indexOf('function sortInterestRows('), watch.indexOf('\nfunction ', watch.indexOf('function sortInterestRows(') + 10));
assert.match(sortBody, /compareListRows\(a, b, key, dir\)/);
assert.doesNotMatch(sortBody, /aMissing|localeCompare|Infinity/, '관심목록에 별도 비교 규칙이 다시 생겼다');
console.log(`List sort: ${keys.length} keys agree across tables in both directions, missing values last for the unified key set`);

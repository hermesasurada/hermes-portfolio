// 값 없음(null·undefined·"")은 어디서나 null — Number(null)이 0이 되어 '없음'이 0으로 둔갑하면 안 된다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
for (const fn of ['optionalNumber', 'finiteChartNumber', 'finiteMetric', 'chartNumericValue']) {
  const call = fn === 'chartNumericValue' ? v => ctx[fn]({k: v}, 'k') : v => ctx[fn](v);
  for (const missing of [null, undefined, '']) assert.equal(call(missing), null, `${fn}(${missing})`);
  assert.equal(call('0'), 0, `${fn}("0")`);
  assert.equal(call(0), 0, `${fn}(0)`);
  assert.equal(call('abc'), null, `${fn}("abc")`);
}
// 비교 보드: β가 없는 종목이 'lowAbs' 최고 표시를 가져가지 않는다
assert.deepEqual([...ctx.compareBestIndexes([ctx.finiteMetric(null), 1.2, 0.8], 'lowAbs')], [2]);
// 차트 헤더: 연장가가 없으면 가격도 없음(0이 아니다)
assert.equal(ctx.chartPriceChangeMetric(null, 100, null, null).price, null);
console.log('numeric missing ok');

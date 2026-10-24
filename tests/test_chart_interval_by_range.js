// 차트 단위 제한(2026-10-24): 주봉은 표시 기간 3년 이상, 월봉은 10년 이상에서만. 짧은 기간으로 바꾸면
// 자동으로 내려가고, 고른 단위(선호)는 기억해 기간이 다시 길어지면 되살린다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);
const allowed = range => { run(`chartRange = ${JSON.stringify(range)}; chartComparePayloads = []`); return run('allowedChartIntervals().join(",")'); };

assert.equal(allowed('1y'), 'day');
assert.equal(allowed('ytd'), 'day');
assert.equal(allowed('3y'), 'day,week');
assert.equal(allowed('5y'), 'day,week');
assert.equal(allowed('10y'), 'day,week,month');
// 직접 지정 기간은 실제 길이로
run('chartRange = "custom"; chartCustomRange = {start: "2020-01-01", end: "2024-01-01"}');
assert.equal(run('allowedChartIntervals().join(",")'), 'day,week');
// 전체는 실제 이력 길이로 — 2년치면 일봉만
const pts = Array.from({length: 520}, (_, i) => ({date: new Date(Date.UTC(2024, 0, 1 + i * 1.4)).toISOString().slice(0, 10), close: 100 + i}));
run(`chartPayload = ${JSON.stringify({points: pts, history_start: pts[0].date, history_end: pts.at(-1).date})}; chartRange = "all"`);
assert.equal(run('allowedChartIntervals().join(",")'), 'day');

// 선호 월봉 → 1Y에선 일봉, 3Y에선 주봉, 10Y에선 다시 월봉
run('chartInterval = "month"; chartIntervalPreference = "month"');
for (const [range, expected] of [['1y', 'day'], ['3y', 'week'], ['10y', 'month']]) {
  run(`chartRange = ${JSON.stringify(range)}; enforceChartInterval()`);
  assert.equal(run('chartInterval'), expected, range);
}
console.log('chart interval by range ok');

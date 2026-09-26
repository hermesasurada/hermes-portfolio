// 성과차트 고정환율 선: 환노출 계좌에만 점선(-fixed)이 붙고, 원화 계좌(두 체인 동일)는 생략.
// 범례의 '고정환율' 칩으로 끄면 사라지고, 계좌 강조는 base 키로 실제·고정 선을 함께 잡는다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../portfolio_static', file), 'utf8');

const h = require('./harness');
const src = read('app-charts.js');
const ctx = h.loadScripts(h.createContext());
h.evaluate(ctx, "chartRange = 'all'; performanceIndexes = {}; performanceFixedFx = true;");
Object.assign(ctx, {
  chartRangeBounds: () => null,
  filterChartPoints: points => points,
  performanceDetailEnabled: () => true,
  esc: s => String(s),
});
const setFixedFx = on => h.evaluate(ctx, `performanceFixedFx = ${on}`);

const days = ['2026-01-02', '2026-01-03', '2026-01-04'];
const exposed = days.map((date, i) => ({ date, value: 1000 + i, twr: 1 + i * 0.01, twr_fixed: 1 + i * 0.02 }));
const krwOnly = days.map((date, i) => ({ date, value: 500 + i, twr: 1 + i * 0.01, twr_fixed: 1 + i * 0.01 }));

// 합산 선 + 환노출 계좌 → 고정환율 점선이 각각 붙는다. 원화 계좌는 안 붙는다.
ctx.payload = { points: exposed, account_series: [
  { id: '1', name: 'Ray · 해외주식', points: exposed },
  { id: '2', name: 'Ray · 연금저축', points: krwOnly },
], indexes: {} };
let series = vm.runInContext('performanceSeries(payload)', ctx);
const keys = series.map(s => s.key);
assert.deepEqual([...keys], ['portfolio', 'portfolio-fixed', 'account-1', 'account-1-fixed', 'account-2']);
const fixed = series.find(s => s.key === 'portfolio-fixed');
assert.equal(fixed.base, 'portfolio');
assert.equal(fixed.fixed, true);
assert.equal(fixed.amount, false, '고정환율 금액은 기준일 환율이라 툴팁에 싣지 않는다');
assert.equal(fixed.color, series[0].color, '같은 색, 점선으로만 구분');
// 고정환율 체인(+2%/일)으로 %가 계산된다: 마지막 점 +4%
assert.ok(Math.abs(fixed.points.at(-1).close - 4) < 1e-9, String(fixed.points.at(-1).close));
assert.ok(Math.abs(series[0].points.at(-1).close - 2) < 1e-9);

// 범례: 계좌 칩에는 고정환율 선이 끼지 않고, '환율' 섹션 칩이 켜짐 상태
let legend = vm.runInContext('renderPerformanceLegend(performanceSeries(payload))', ctx);
assert.equal((legend.match(/perf-account-focus/g) || []).length, 3);
assert.match(legend, /perf-fx-toggle active/);
assert.doesNotMatch(legend, /data-perf-focus="portfolio-fixed"/);

// 칩을 끄면 점선이 전부 사라지고 칩은 꺼짐 표시
setFixedFx(false);
series = vm.runInContext('performanceSeries(payload)', ctx);
assert.deepEqual([...series.map(s => s.key)], ['portfolio', 'account-1', 'account-2']);
legend = vm.runInContext('renderPerformanceLegend(performanceSeries(payload))', ctx);
assert.match(legend, /perf-fx-toggle" [^>]*aria-pressed="false"/);
setFixedFx(true);

// 원화 계좌만 선택 → 고정환율 선 없음, 칩은 켜져 있지만 unavailable
ctx.payload = { points: krwOnly, account_series: [], indexes: {} };
series = vm.runInContext('performanceSeries(payload)', ctx);
assert.deepEqual([...series.map(s => s.key)], ['portfolio']);
legend = vm.runInContext('renderPerformanceLegend(performanceSeries(payload))', ctx);
assert.match(legend, /perf-fx-toggle active unavailable/);

// twr_fixed가 없는 옛 페이로드도 깨지지 않는다(재계산 전 호환)
ctx.payload = { points: days.map((date, i) => ({ date, value: 1, twr: 1 + i * 0.01 })), account_series: [], indexes: {} };
series = vm.runInContext('performanceSeries(payload)', ctx);
assert.deepEqual([...series.map(s => s.key)], ['portfolio']);

// 렌더 마크업 규칙: 점선 클래스와 base 속성, 스타일
assert.match(src, /class="perf-line \$\{item\.primary \? "primary" : item\.fixed \? "fixed" : "index"\}"/);
assert.match(src, /data-perf-base=/);
assert.match(read('styles.css'), /\.perf-line\.fixed \{[^}]*stroke-dasharray/);
assert.match(read('app.js'), /let performanceFixedFx = true;/);
console.log('performance fixed-FX series, legend toggle, KRW-only omission and legacy payload ok');

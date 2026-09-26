const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({window: {}, chartInterval: 'day'});
vm.runInContext(fs.readFileSync('portfolio_static/app-chart-scale.js', 'utf8'), ctx);
const points = [
  {date:'2026-08-03', close:100, sma_20:95, ichi_span_a:101, ichi_span_b:90,
    ichi_week_span_a:80, ichi_week_span_b:70, ichi_month_span_a:60, ichi_month_span_b:50},
  {date:'2026-08-04', close:110, sma_20:96, ichi_span_a:102, ichi_span_b:91,
    ichi_week_span_a:81, ichi_week_span_b:71, ichi_month_span_a:61, ichi_month_span_b:51},
];
const original = JSON.stringify(points);
for (const interval of ['week', 'month']) {
  const result = ctx.aggregateChartPoints(points, interval);
  assert.equal(result.length, 1);
  assert.equal(result[0].ichi_span_a, points[1][`ichi_${interval}_span_a`]);
  assert.equal(result[0].ichi_span_b, points[1][`ichi_${interval}_span_b`]);
  assert.equal(result[0].sma_20, 96); // Still DAILY SMA.
  const short = ctx.aggregateChartPoints([{date:'2026-08-05', close:100,
    ichi_tenkan:98, ichi_span_a:99, ichi_span_b:90}], interval);
  assert.equal(short[0].ichi_span_a, undefined);
  assert.equal(short[0].ichi_tenkan, undefined);
}
assert.equal(JSON.stringify(points), original);
assert.equal(ctx.aggregateChartPoints(points, 'day')[1].ichi_span_a, 102);
// The toggle re-renders with the new interval, without requiring a new request.
const elements = {};
ctx.document = {getElementById: id => elements[id] ||= {
  classList:{toggle() {}}, setAttribute() {}, addEventListener(_, fn) {this.click = fn;},
}};
Object.assign(ctx, {chartTicker:'ASML', performanceChartOpen:false,
  chartPayload:{points}, detailStorage:{chartInterval:'interval'}, storageSet() {}});
vm.runInContext(fs.readFileSync('portfolio_static/app-line-chart.js', 'utf8'), ctx);
ctx.renderLineChart = payload => {ctx.rendered = ctx.aggregateChartPoints(payload.points);};
ctx.initChartIntervalControl();
for (const expected of [81, 61, 102]) {
  elements.chartIntervalToggle.click();
  assert.equal(ctx.rendered.at(-1).ichi_span_a, expected);
}
// 양운↔음운이 바뀌는 자리에서 두 구름이 교차점을 공유해야 한 봉짜리 세로 틈이 안 생긴다.
{
  // 실제 chartNumericValue·straightLinePath를 그대로 쓴다(예전엔 가짜로 대신해 실제와 어긋날 수 있었다).
  const h = require('./harness');
  const cloudCtx = h.loadScripts(h.createContext());
  cloudCtx.rows = [{ichi_span_a: 10, ichi_span_b: 5}, {ichi_span_a: 9, ichi_span_b: 6},
    {ichi_span_a: 4, ichi_span_b: 7}, {ichi_span_a: 3, ichi_span_b: 8}, {ichi_span_a: 9, ichi_span_b: 8}];
  const areas = vm.runInContext('ichimokuCloudPaths(rows, i => i * 10, v => 100 - v)', cloudCtx);
  const xOf = d => [...d.matchAll(/(-?[\d.]+),-?[\d.]+/g)].map(m => Number(m[1]));
  assert.equal(areas.length, 3);
  assert.equal(areas.map(a => a.bullish).join(','), 'true,false,true');
  for (let i = 1; i < areas.length; i += 1) {
    // 끝난 구름의 오른쪽 끝 = 새 구름의 왼쪽 끝. 틈이 생기면 여기서 잡힌다.
    assert.equal(Math.max(...xOf(areas[i - 1].d)), Math.min(...xOf(areas[i].d)));
  }
  assert.ok(xOf(areas[0].d).includes(15)); // 10↔20 봉 사이 교차점
  const nulls = vm.runInContext('ichimokuCloudPaths([{ichi_span_a: 1, ichi_span_b: 2}, {ichi_span_a: null, ichi_span_b: 2}, {ichi_span_a: 3, ichi_span_b: 1}], i => i, v => v)', cloudCtx);
  assert.equal(nulls.length, 0); // 값이 끊기면 구름도 끊는다(억지로 잇지 않는다).
}

// 선행 26봉 x축 자리는 구름을 실제로 그릴 때만 예약한다. 끈 상태에서 예약하면
// 주가선이 오른쪽 축에 닿지 못하고 그만큼 빈 공간이 남는다(2026-09-15 보고).
const chartSource = fs.readFileSync('portfolio_static/app-line-chart.js', 'utf8');
const futureLine = chartSource.split('\n').find(line => line.includes('const futureCount'));
// showIchimoku = chartShowIchimoku && 오버레이 적용 종목(환율 제외).
assert.ok(futureLine && futureLine.includes('showIchimoku'), futureLine);
const chartSrc2 = fs.readFileSync('portfolio_static/app-line-chart.js', 'utf8');
assert.match(chartSrc2, /const showIchimoku = chartShowIchimoku && overlaysApply;/);
// 세로 축은 토글과 무관하게 선행 구름 값까지 포함해 고정한다.
const scaleLine = chartSource.split('\n').find(line => line.includes('const overlayValues'));
assert.ok(scaleLine && scaleLine.includes('hasProjection'), scaleLine);
console.log('chart Ichimoku interval switching and future-space reservation ok');

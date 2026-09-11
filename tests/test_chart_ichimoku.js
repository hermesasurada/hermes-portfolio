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
console.log('chart Ichimoku interval switching ok');

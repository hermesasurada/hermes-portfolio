const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = {};
function element(id) {
  return elements[id] ||= {classList: {toggle(key, value) {this[key] = value;}}, attrs: {},
    setAttribute(key, value) {this.attrs[key] = value;}, addEventListener(_, callback) {this.click = callback;}};
}
const ctx = vm.createContext({window: {addEventListener() {}}, document: {getElementById: element},
  chartShowMovingAverages: true, chartShowBollinger: false, chartShowIchimoku: false,
  chartType: 'line', chartInterval: 'day', chartComparePayloads: [], chartTicker: 'ASML',
  performanceChartOpen: false, chartSmoothLines: false, chartLogScale: false, chartPayload: null,
  detailStorage: {chartShowMovingAverages: 'ma'}, storageSet(key, value) {ctx.saved = [key, value];},
  unitMoney: value => String(value), chartFullDateLabel: value => value,
});
for (const file of ['app-chart-scale.js', 'app-line-chart.js'])
  vm.runInContext(fs.readFileSync(`portfolio_static/${file}`, 'utf8'), ctx);
const points = [
  {date: '2026-08-03', close: 100, sma_20: 90, sma_50: 80, sma_200: 70},
  {date: '2026-08-04', close: 120, sma_20: 91, sma_50: 81, sma_200: 71},
];
for (const interval of ['week', 'month']) {
  const result = ctx.aggregateChartPoints(points, interval);
  assert.equal(result[0].sma_20, 91);
  assert.equal(result[0].sma_50, 81);
  assert.equal(result[0].sma_200, 71);
}
assert.deepEqual(Array.from(ctx.chartOverlayScaleValues(points)), [90, 80, 70, 91, 81, 71]);
assert.match(JSON.stringify(ctx.chartPointTooltipLines(points[1], {})), /MA 200/);
assert.doesNotMatch(JSON.stringify(ctx.chartPointTooltipLines({date:'2026-08-03',close:5}, {})), /MA /);
ctx.initChartDisplayControls();
elements.chartMovingAverageToggle.click();
assert.equal(ctx.chartShowMovingAverages, false);
assert.deepEqual(ctx.saved, ['ma', 'false']);
assert.equal(ctx.chartOverlayScaleValues(points).length, 0);
assert.equal(elements.chartMaLegend.classList.hidden, true);
elements.chartMovingAverageToggle.click();
assert.equal(elements.chartMovingAverageToggle.attrs['aria-pressed'], 'true');
for (const compare of [true, false]) {
  ctx.chartComparePayloads = compare ? [{}] : [];
  ctx.performanceChartOpen = !compare;
  ctx.syncChartDisplayControls();
  assert.equal(elements.chartMovingAverageToggle.classList.hidden, true);
  assert.equal(elements.chartMaLegend.classList.hidden, true);
}
console.log('chart moving averages UI ok');

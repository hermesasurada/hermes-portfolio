const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = {};
function element(id) {
  return elements[id] ||= {classList: {toggle(key, value) {this[key] = value;}}, attrs: {},
    setAttribute(key, value) {this.attrs[key] = value;}, addEventListener(_, callback) {this.click = callback;}};
}
const ctx = vm.createContext({window: {addEventListener() {}}, document: {getElementById: element},
  chartMovingAveragePeriods: {20:true,50:true,200:true}, chartShowBollinger: false, chartShowIchimoku: false,
  chartType: 'line', chartInterval: 'day', chartComparePayloads: [], chartTicker: 'ASML',
  performanceChartOpen: false, chartSmoothLines: false, chartLogScale: false, chartPayload: null,
  detailStorage: {chartMovingAveragePeriods: 'ma'}, storageSet(key, value) {ctx.saved = [key, value];},
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
elements.chartMa20Toggle.click();
assert.equal(ctx.chartMovingAveragePeriods[20], false);
assert.deepEqual(ctx.saved, ['ma.20', 'false']);
assert.deepEqual(Array.from(ctx.chartOverlayScaleValues(points)), [80, 70, 81, 71]);
assert.doesNotMatch(JSON.stringify(ctx.chartPointTooltipLines(points[1], {})), /MA 20"/);
assert.match(JSON.stringify(ctx.chartPointTooltipLines(points[1], {})), /MA 200/);
elements.chartMa50Toggle.click();
elements.chartMa200Toggle.click();
assert.equal(ctx.chartOverlayScaleValues(points).length, 0);
elements.chartMa20Toggle.click();
assert.equal(elements.chartMa20Toggle.attrs['aria-pressed'], 'true');
assert.equal(elements.chartMa50Toggle.attrs['aria-pressed'], 'false');
// New individual preferences override the old master preference; absent values inherit it.
const app = fs.readFileSync('portfolio_static/app.js', 'utf8');
const restore = app.match(/Object.keys\(chartMovingAveragePeriods\).forEach\(period => \{[\s\S]*?\n\}\);/)[0];
for (const legacy of [null, 'true', 'false']) {
  const saved = {'old':legacy, 'ma.50':'false', 'ma.200':'true'};
  ctx.detailStorage.chartShowMovingAverages = 'old';
  ctx.storageGet = key => saved[key] ?? null;
  vm.runInContext(restore, ctx);
  assert.equal(ctx.chartMovingAveragePeriods[20], legacy !== 'false');
  assert.equal(ctx.chartMovingAveragePeriods[50], false);
  assert.equal(ctx.chartMovingAveragePeriods[200], true);
}
const html = fs.readFileSync('portfolio_static/index.html', 'utf8');
assert.doesNotMatch(html, /chartMaLegend|chartMovingAverageToggle/);
for (const period of [20,50,200]) assert.match(html, new RegExp(`id="chartMa${period}Toggle"`));
for (const compare of [true, false]) {
  ctx.chartComparePayloads = compare ? [{}] : [];
  ctx.performanceChartOpen = !compare;
  ctx.syncChartDisplayControls();
  for (const period of [20,50,200]) assert.equal(elements[`chartMa${period}Toggle`].classList.hidden, true);
}
console.log('chart moving averages UI ok');

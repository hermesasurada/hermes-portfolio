const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = {};
function element(id) {
  return elements[id] ||= {classList: {toggle(key, value) {this[key] = value;}}, attrs: {},
    setAttribute(key, value) {this.attrs[key] = value;}, addEventListener(_, callback) {this.click = callback;}};
}
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
ctx.document.getElementById = element;
// 스크립트 스코프(let/const) 상태는 ctx 속성이 아니다 — 평가로 읽고 쓴다.
const get = name => h.evaluate(ctx, name);
const set = (name, value) => { ctx.__value = value; h.evaluate(ctx, `${name} = __value`); };
const maKey = get('detailStorage.chartMovingAveragePeriods');
ctx.storageSet = (key, value) => { ctx.saved = [key, value]; };
h.evaluate(ctx, "chartMovingAveragePeriods = {20:true,50:true,200:true}; chartShowBollinger = false; chartShowIchimoku = false;"
  + " chartType = 'line'; chartInterval = 'day'; chartComparePayloads = []; chartTicker = 'ASML'; performanceChartOpen = false;"
  + " chartSmoothLines = false; chartLogScale = false; chartPayload = null;");
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
assert.equal(get('chartMovingAveragePeriods')[20], false);
assert.equal(JSON.stringify(ctx.saved), JSON.stringify([`${maKey}.20`, 'false']));
assert.deepEqual(Array.from(ctx.chartOverlayScaleValues(points)), [90, 80, 70, 91, 81, 71]);
assert.doesNotMatch(JSON.stringify(ctx.chartPointTooltipLines(points[1], {})), /MA 20"/);
assert.match(JSON.stringify(ctx.chartPointTooltipLines(points[1], {})), /MA 200/);
elements.chartMa50Toggle.click();
elements.chartMa200Toggle.click();
assert.equal(ctx.chartOverlayScaleValues(points).length, 6);
// All 32 visibility combinations must have identical scale inputs and bounds.
const overlayPoints = [{close:100,sma_20:90,sma_50:80,sma_200:50,
  bb_upper:150,bb_mid:100,bb_lower:60,ichi_tenkan:110,ichi_kijun:95,ichi_span_a:180,ichi_span_b:40},
  {close:110,sma_20:null,sma_50:undefined,sma_200:NaN,bb_lower:Infinity}];
const expectedValues = [90,80,50,150,100,60,110,95,180,40];
const expectedScale = ctx.tightLowerChartScale([100,110,...expectedValues]);
for (let mask = 0; mask < 32; mask++) {
  set('chartMovingAveragePeriods', {20:Boolean(mask & 1),50:Boolean(mask & 2),200:Boolean(mask & 4)});
  set('chartShowBollinger', Boolean(mask & 8));
  set('chartShowIchimoku', Boolean(mask & 16));
  const values = ctx.chartOverlayScaleValues(overlayPoints);
  assert.deepEqual(Array.from(values), expectedValues);
  assert.deepEqual(ctx.tightLowerChartScale([100,110,...values]), expectedScale);
  assert.deepEqual(ctx.logChartScale([100,110,...values]), ctx.logChartScale([100,110,...expectedValues]));
}
set('chartMovingAveragePeriods', {20:false,50:false,200:false});
set('chartShowBollinger', false);
set('chartShowIchimoku', false);
assert.match(fs.readFileSync('portfolio_static/app-line-chart.js', 'utf8'), /const markerValues = allChartTransactions\.map/);
elements.chartMa20Toggle.click();
assert.equal(elements.chartMa20Toggle.attrs['aria-pressed'], 'true');
assert.equal(elements.chartMa50Toggle.attrs['aria-pressed'], 'false');
// New individual preferences override the old master preference; absent values inherit it.
const app = fs.readFileSync('portfolio_static/app.js', 'utf8');
const restore = app.match(/Object.keys\(chartMovingAveragePeriods\).forEach\(period => \{[\s\S]*?\n\}\);/)[0];
for (const legacy of [null, 'true', 'false']) {
  const saved = {'old':legacy, [`${maKey}.50`]:'false', [`${maKey}.200`]:'true'};
  h.evaluate(ctx, "detailStorage.chartShowMovingAverages = 'old'");
  ctx.storageGet = key => saved[key] ?? null;
  h.evaluate(ctx, restore);
  assert.equal(get('chartMovingAveragePeriods')[20], legacy !== 'false');
  assert.equal(get('chartMovingAveragePeriods')[50], false);
  assert.equal(get('chartMovingAveragePeriods')[200], true);
}
const html = fs.readFileSync('portfolio_static/index.html', 'utf8');
assert.match(html, /id="chartBollingerToggle"[^>]*>BB<\/button>\s*<button[^>]*id="chartIchimokuToggle"/);
assert.doesNotMatch(html, /chartMaLegend|chartMovingAverageToggle/);
for (const period of [20,50,200]) assert.match(html, new RegExp(`id="chartMa${period}Toggle"`));
assert.match(html, /id="chartMaCaption">이동평균선/);
assert.match(html, /id="chartUnitControls"[\s\S]*?chart-control-label">단위/);
ctx.availableChartRangeChoices = () => [{key:'6m',label:'6M'}];
set('chartRange', '6m');
set('chartShowBuys', true);
set('chartShowSells', false);
const controls = ctx.renderChartRangeButtons();
assert.match(controls, /chart-control-label">기간/);
assert.match(controls, /chart-control-label">거래/);
assert.match(controls, /chart-marker-full">Buy/);
assert.match(controls, /chart-marker-full">Sell/);
assert.match(controls, /data-marker-toggle="buy"[^>]*aria-pressed="true"/);
assert.match(controls, /data-marker-toggle="sell"[^>]*aria-pressed="false"/);
ctx.syncChartIntervalControl();
assert.equal(elements.chartUnitControls.classList.hidden, false);
set('performanceChartOpen', true);
ctx.syncChartIntervalControl();
assert.equal(elements.chartUnitControls.classList.hidden, true);
assert.doesNotMatch(ctx.renderChartRangeButtons(), /chart-marker-full/);
for (const compare of [true, false]) {
  set('chartComparePayloads', compare ? [{}] : []);
  set('performanceChartOpen', !compare);
  ctx.syncChartDisplayControls();
  for (const period of [20,50,200]) assert.equal(elements[`chartMa${period}Toggle`].classList.hidden, true);
  assert.equal(elements.chartMaCaption.classList.hidden, true);
}
console.log('chart moving averages UI ok');

// 툴팁 등락 — 직전 봉 종가 대비, 표의 등락 칩과 같은 표기(화살표+소수 2자리+%)
// vm 컨텍스트가 만든 배열이라 realm이 달라 deepStrictEqual이 못 쓴다 — JSON으로 비교한다.
const changeLine = (point, previous) => JSON.stringify(
  ctx.chartPointTooltipLines(point, {}, previous).find(line => Array.isArray(line) && line[0]?.[0] === '등락'));
assert.equal(changeLine(points[1], points[0]), JSON.stringify([['등락', '▲20%', 'up']]));
assert.equal(changeLine({date: '2026-08-05', close: 90}, {close: 100}), JSON.stringify([['등락', '▼10%', 'down']]));
assert.equal(changeLine({date: '2026-08-05', close: 100}, {close: 100}), JSON.stringify([['등락', '→0%', 'flat']]));
// 첫 봉이나 기준가가 없으면 등락 줄을 만들지 않는다
for (const previous of [null, undefined, {close: 0}, {close: null}]) {
  assert.equal(ctx.chartPointTooltipLines(points[1], {}, previous).some(line => Array.isArray(line) && line[0]?.[0] === '등락'), false);
}
console.log('Chart tooltip change line: shared list formatting, direction class and missing-base skip OK');


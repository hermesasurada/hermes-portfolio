// 차트 기간·단위 구분 버튼(2026-11-25 사용자 지시): PC는 팝업·순환 없이 한 번에 고른다.
// 좁은 화면은 기존 팝업 버튼·순환 버튼을 쓰므로 둘 다 그려 두고 CSS가 하나만 보인다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const elements = {};
function element(id) {
  return elements[id] ||= {classList: {toggle(key, value) {this[key] = value;}}, attrs: {},
    setAttribute(key, value) {this.attrs[key] = value;}, addEventListener(_, callback) {this.click = callback;}};
}
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
ctx.document.getElementById = element;
const get = name => h.evaluate(ctx, name);
const set = (name, value) => { ctx.__value = value; h.evaluate(ctx, `${name} = __value`); };
const saved = [];
ctx.storageSet = (key, value) => { saved.push([key, value]); };
h.evaluate(ctx, "chartInterval = 'day'; chartIntervalPreference = null; chartComparePayloads = []; chartTicker = 'MEDP';"
  + " performanceChartOpen = false; chartPayload = null; chartCustomRange = {start: '', end: ''};");

// ── 기간: 선택지마다 버튼 하나, 고른 것만 active, 이력이 짧아 못 고르는 기간은 disabled ──
ctx.availableChartRangeChoices = () => [
  {key: '6m', label: '6M'}, {key: '5y', label: '5Y'}, {key: '10y', label: '10Y', disabled: true},
];
set('chartRange', '5y');
let html = ctx.renderChartRangeButtons();
const segments = html.match(/<div class="segmented chart-range-segments">([\s\S]*?)<\/div>/)[1];
const buttons = [...segments.matchAll(/<button class="seg-btn ([^"]*)"[^>]*?(data-chart-range="([^"]+)"|data-chart-custom)[^>]*>([^<]+)<\/button>/g)]
  .map(match => ({active: match[1].includes('active'), key: match[3] || 'custom', label: match[4], disabled: / disabled/.test(match[0])}));
assert.deepEqual(buttons.map(button => button.label), ['6M', '5Y', '10Y', '직접']);
assert.deepEqual(buttons.filter(button => button.active).map(button => button.key), ['5y']);
assert.deepEqual(buttons.filter(button => button.disabled).map(button => button.key), ['10y']);
// '직접'은 날짜를 받아야 해서 팝업을 연다 — 직접 지정 중이면 그 버튼이 켜진다.
assert.match(segments, /data-chart-custom aria-haspopup="dialog"/);
set('chartRange', 'custom');
assert.match(ctx.renderChartRangeButtons(), /<button class="seg-btn active" type="button" data-chart-custom/);
// 좁은 화면용 팝업 버튼은 그대로 있다.
assert.match(html, /class="chart-range-btn range-popup-btn active"[^>]*data-chart-range-popup[^>]*>5Y</);

// ── 단위: 일·주·월 세 버튼, 기간이 짧아 못 고르는 단위는 흐리게 남긴다 ──
const unitButtons = () => [...elements.chartIntervalSegments.innerHTML
  .matchAll(/<button class="seg-btn ([^"]*)"[^>]*data-chart-interval="([^"]+)"[^>]*>([^<]+)<\/button>/g)]
  .map(match => `${match[3]}${match[1].includes('active') ? '*' : ''}${/ disabled/.test(match[0]) ? '(x)' : ''}`);
set('chartRange', '6m');
ctx.syncChartIntervalControl();
assert.deepEqual(unitButtons(), ['일*', '주(x)', '월(x)']);
set('chartRange', '5y');
ctx.syncChartIntervalControl();
assert.deepEqual(unitButtons(), ['일*', '주', '월(x)']);

// 버튼 하나로 바로 그 단위가 된다(순환 아님) — 저장하고 다시 그린다.
let rendered = 0;
ctx.renderLineChart = () => { rendered += 1; };
set('chartPayload', {points: []});
ctx.selectChartInterval('week');
assert.equal(get('chartInterval'), 'week');
assert.deepEqual(saved.at(-1), [get('detailStorage.chartInterval'), 'week']);
assert.equal(rendered, 1);
assert.deepEqual(unitButtons(), ['일', '주*', '월(x)']);
ctx.selectChartInterval('month');   // 5년 기간에서는 월 단위를 고를 수 없다
assert.equal(get('chartInterval'), 'week');
assert.equal(rendered, 1);

// 클릭 위임: 구분 버튼 묶음에 건 처리기가 data-chart-interval을 읽는다.
ctx.initChartIntervalControl();
elements.chartIntervalSegments.click({target: {closest: () => ({disabled: false, dataset: {chartInterval: 'day'}})}});
assert.equal(get('chartInterval'), 'day');
elements.chartIntervalSegments.click({target: {closest: () => ({disabled: true, dataset: {chartInterval: 'week'}})}});
assert.equal(get('chartInterval'), 'day');

// ── 성과 화면: 일·주 두 버튼, 3년 이상 기간은 주 고정이라 '일'이 꺼진다 ──
set('performanceChartOpen', true);
set('chartRange', '6m');
h.evaluate(ctx, "performanceIntervalPreference = 'day'");
ctx.syncChartIntervalControl();
assert.deepEqual(unitButtons(), ['일*', '주']);
ctx.renderPerformanceChart = () => {};
ctx.selectChartInterval('week');
assert.equal(get('performanceIntervalPreference'), 'week');
assert.deepEqual(unitButtons(), ['일', '주*']);
set('chartRange', '3y');
ctx.syncChartIntervalControl();
assert.deepEqual(unitButtons(), ['일(x)', '주*']);

// ── 마크업·이벤트 연결·화면 폭 전환 ──
const page = fs.readFileSync('portfolio_static/index.html', 'utf8');
assert.match(page, /id="chartIntervalToggle"[\s\S]{0,200}?id="chartIntervalSegments"/);
for (const file of ['portfolio_static/app-line-chart.js', 'portfolio_static/app-charts.js']) {
  assert.match(fs.readFileSync(file, 'utf8'), /querySelectorAll\("\.chart-range-btn, \.chart-range-segments \.seg-btn"\)/, file);
}
const css = fs.readFileSync('portfolio_static/styles.css', 'utf8');
assert.match(css, /@media \(min-width: 981px\) \{\s*#chartBottomControls #chartIntervalToggle, \.chart-range-btn\.range-popup-btn \{ display: none; \}/);
assert.match(css, /@media \(max-width: 980px\) \{ \.chart-range-segments, \.chart-interval-segments \{ display: none; \} \}/);
console.log('chart range segments ok');

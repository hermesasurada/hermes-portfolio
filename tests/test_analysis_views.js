const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../portfolio_static');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
Object.assign(ctx, {storageGet: () => null, esc});
h.evaluate(ctx, 'performanceIndexes = {SP500:true}; performanceFixedFx = true;');
for (const mobile of [false, true]) {
  for (const saved of ['grid', 'list']) {
    assert.equal(ctx.initialScheduleView(saved, mobile), saved);
  }
}
assert.equal(ctx.initialScheduleView(null, true), 'list');
assert.equal(ctx.initialScheduleView(null, false), 'grid');
const series = [{key:'portfolio', primary:true, name:'선택 <계좌>', color:'var(--brand)', points:[{date:'2026-01-02'}, {date:'2026-09-04'}]}];
const legend = ctx.renderPerformanceLegend(series);
// 범례는 두 줄뿐 — 고정환율 칩은 계좌 줄에 얹고 별도 '환율' 줄은 두지 않는다.
assert.match(legend, /aria-label="계좌 선 강조와 고정환율 표시"/);
assert.match(legend, /aria-label="비교지수 표시"/);
assert.equal((legend.match(/perf-legend-section/g) || []).length, 2);
assert.doesNotMatch(legend, /perf-group-label">환율</);
const fxAt = legend.indexOf('perf-fx-toggle'), indexAt = legend.indexOf('perf-index-toggle');
assert.ok(fxAt > legend.indexOf('perf-account-focus') && fxAt < indexAt, '고정환율 칩은 계좌 칩 뒤·비교지수 앞');
assert.match(legend, /선택 &lt;계좌>/);
assert.match(legend, /data-perf-focus="portfolio"/);
assert.equal((legend.match(/data-index=/g) || []).length, 4);
// 표시 기간 최종 수익률 오버레이(2026-11-01) — 기간·수익률 기준을 함께 싣고, 강조한 계좌로 바뀐다.
h.evaluate(ctx, 'chartRange = "6m";');
const ret = [
  {key:'portfolio', primary:true, name:'선택 계좌', color:'var(--brand)', points:[{date:'2026-05-01', close:0}, {date:'2026-10-31', close:-11.94}]},
  {key:'portfolio-fixed', base:'portfolio', fixed:true, name:'선택 계좌 · 고정환율', color:'var(--brand)', points:[{date:'2026-05-01', close:0}, {date:'2026-10-31', close:-6.1}]},
  {key:'account-1', name:'Ray · 해외주식', color:'#7c3aed', points:[{date:'2026-05-01', close:0}, {date:'2026-10-30', close:4.25}]},
  {key:'SP500', name:'S&P 500', color:'#c026d3', points:[{date:'2026-05-01', close:0}, {date:'2026-10-31', close:4.8}]},
  {key:'KOSPI', name:'코스피', color:'#d97706', points:[{date:'2026-05-01', close:0}, {date:'2026-10-31', close:-17.4}]},
];
const summary = ctx.performanceReturnSummary({twr_basis:'full'}, ret);
assert.match(summary, /선택 계좌 · 6M/);
assert.match(summary, /perf-return-value down">-11\.9%/);
assert.match(summary, /고정환율 <b class="down">-6\.1%/);
assert.match(summary, /2026\.05\.01 – 2026\.10\.31 · 시간가중/);
assert.match(ctx.performanceReturnSummary({twr_basis:'securities'}, ret), /증권 기준/);
assert.match(ctx.performanceReturnSummary({}, ret), /기준 확인 필요/);
const focused = ctx.performanceReturnSummary({twr_basis:'full'}, ret, 'account-1');
assert.match(focused, /Ray · 해외주식 · 6M/);
assert.match(focused, /perf-return-value up">\+4\.3%/);
assert.doesNotMatch(focused, /고정환율/);
assert.equal(ctx.performanceReturnSummary({}, []), '');
// 켜 둔 비교지수도 같은 기간 수익률을 작게 싣는다(계좌를 강조해도 그대로).
assert.match(summary, /perf-return-index"><i style="background:#c026d3"><\/i><span>S&amp;P 500<\/span><b class="up">\+4\.8%/);
assert.match(summary, /<span>코스피<\/span><b class="down">-17\.4%/);
assert.equal((focused.match(/perf-return-index"/g) || []).length, 2);
assert.doesNotMatch(ctx.performanceReturnSummary({}, ret.slice(0, 3)), /perf-return-indexes/);
// 표시 기간 줄은 오버레이로 합쳐 범례 호스트에 다시 두지 않는다.
assert.doesNotMatch(fs.readFileSync(path.join(root, 'app-charts.js'), 'utf8'), /perf-overview|performanceOverview/);
function node(key) {
  return {dataset:{perfFocus:key, perfSeries:key}, attrs:{},
    classList:{ toggle(name, on) { this[name] = on; } },
    setAttribute(name, value) { this.attrs[name] = value; }};
}
const buttons = [node('portfolio'), node('account-1')];
const lines = [node('portfolio'), node('account-1'), node('SP500')];
ctx.document = {querySelectorAll: s => s === '[data-perf-focus]' ? buttons : lines};
h.evaluate(ctx, 'performanceFocusKey = "account-1"; applyPerformanceFocus()');
assert.equal(buttons[1].attrs['aria-pressed'], 'true');
assert.equal(lines[1].classList['perf-focused'], true);
assert.equal(lines[0].classList['perf-dimmed'], true);
assert.equal(lines[2].classList['perf-dimmed'], true);
h.evaluate(ctx, 'performanceFocusKey = null; applyPerformanceFocus()');
assert.ok(lines.every(l => !l.classList['perf-dimmed'] && !l.classList['perf-focused']));
const source = read('app-line-chart.js');
assert.match(source, /const headroomPx = 16;/);
const css = read('styles.css');
assert.match(css, /\.schedule-calendar \{ min-width: 700px; \}/);
assert.match(css, /\.schedule-event-label, \.schedule-more \{ font-size: 12px;/);
assert.match(css, /\.perf-line\.perf-dimmed, \.perf-end-label\.perf-dimmed/);
console.log('Analysis views: saved calendar modes, basis/period, legend groups, focus reset and normal-flow chart controls passed.');

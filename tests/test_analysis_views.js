const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../portfolio_static');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const ctx = vm.createContext({window: {}, storageGet: () => null, esc,
  performanceIndexes: {SP500:true},
});
vm.runInContext(read('app-calendar.js'), ctx);
for (const mobile of [false, true]) {
  for (const saved of ['grid', 'list']) {
    assert.equal(ctx.initialScheduleView(saved, mobile), saved);
  }
}
assert.equal(ctx.initialScheduleView(null, true), 'list');
assert.equal(ctx.initialScheduleView(null, false), 'grid');
vm.runInContext(read('app-charts.js'), ctx);
const series = [{key:'portfolio', primary:true, name:'선택 <계좌>', color:'var(--brand)', points:[{date:'2026-01-02'}, {date:'2026-09-04'}]}];
const legend = ctx.renderPerformanceLegend(series);
assert.match(legend, /aria-label="계좌 선 강조"/);
assert.match(legend, /aria-label="비교지수 표시"/);
assert.match(legend, /선택 &lt;계좌>/);
assert.match(legend, /data-perf-focus="portfolio"/);
assert.equal((legend.match(/data-index=/g) || []).length, 4);
assert.match(ctx.performanceOverview({twr_basis:'full'}, series), /시간가중 수익률/);
assert.match(ctx.performanceOverview({twr_basis:'securities'}, series), /증권 기준/);
assert.match(ctx.performanceOverview({}, []), /표시 기간 없음/);
assert.match(ctx.performanceOverview({}, []), /기준 확인 필요/);
assert.match(ctx.performanceOverview({}, series), /2026-01-02 — 2026-09-04/);
function node(key) {
  return {dataset:{perfFocus:key, perfSeries:key}, attrs:{},
    classList:{ toggle(name, on) { this[name] = on; } },
    setAttribute(name, value) { this.attrs[name] = value; }};
}
const buttons = [node('portfolio'), node('account-1')];
const lines = [node('portfolio'), node('account-1'), node('SP500')];
ctx.document = {querySelectorAll: s => s === '[data-perf-focus]' ? buttons : lines};
vm.runInContext('performanceFocusKey = "account-1"; applyPerformanceFocus()', ctx);
assert.equal(buttons[1].attrs['aria-pressed'], 'true');
assert.equal(lines[1].classList['perf-focused'], true);
assert.equal(lines[0].classList['perf-dimmed'], true);
assert.equal(lines[2].classList['perf-dimmed'], true);
vm.runInContext('performanceFocusKey = null; applyPerformanceFocus()', ctx);
assert.ok(lines.every(l => !l.classList['perf-dimmed'] && !l.classList['perf-focused']));
const controls = {style:{top:'50px', right:'70px'}};
ctx.document = {getElementById: () => controls};
const source = read('app-line-chart.js');
vm.runInContext(source.slice(source.indexOf('function syncChartOverlayPosition()'), source.indexOf('function syncChartBottomControls(')), ctx);
ctx.syncChartOverlayPosition();
assert.deepEqual(controls.style, {top:'', right:''});
assert.match(source, /const headroomPx = 16;/);
const css = read('styles.css');
assert.match(css, /\.schedule-calendar \{ min-width: 700px; \}/);
assert.match(css, /\.schedule-event-label, \.schedule-more \{ font-size: 12px;/);
assert.match(css, /\.perf-line\.perf-dimmed, \.perf-end-label\.perf-dimmed/);
console.log('Analysis views: saved calendar modes, basis/period, legend groups, focus reset and normal-flow chart controls passed.');

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
// 성과 요약 띠(2026-11-20 디자인 개편): 큰 숫자 = 계좌 수익률, 비교 칸 = 고정환율(환율 효과)·지수 대비 초과수익(%p).
const summary = ctx.performanceSummary({twr_basis:'full'}, ret);
assert.match(summary, /perf-summary-caption">6M 수익률 · 선택 계좌</);
assert.match(summary, /perf-summary-value down">-11\.9%</);
assert.match(summary, /2026\.05\.01 – 2026\.10\.31 · 시간가중/);
const items = summary.match(/<div class="perf-summary-item">[\s\S]*?<\/div>/g);
assert.equal(items.length, 3);
assert.match(items[0], /<i class="dashed" style="color:var\(--brand\)"><\/i><span class="perf-summary-label">고정환율<\/span><b class="down">-6\.1%<\/b><small>환율 효과 -5\.8%p<\/small>/);
assert.match(items[1], /S&amp;P 500 대비<\/span><b class="down">-16\.7%p<\/b><small>지수 \+4\.8%<\/small>/);
assert.match(items[2], /코스피 대비<\/span><b class="up">\+5\.5%p<\/b><small>지수 -17\.4%<\/small>/);
assert.match(ctx.performanceSummary({twr_basis:'securities'}, ret), /증권 기준/);
assert.match(ctx.performanceSummary({}, ret), /기준 확인 필요/);
const focused = ctx.performanceSummary({twr_basis:'full'}, ret, 'account-1');
assert.match(focused, /수익률 · Ray · 해외주식<\/span><strong class="perf-summary-value up">\+4\.3%/);
assert.doesNotMatch(focused, /고정환율/);
assert.equal((focused.match(/perf-summary-item"/g) || []).length, 2);
assert.equal(ctx.performanceSummary({}, []), '');
// 예전 플롯 안 수익률 상자(끌어 옮기기)는 없앴다 — 선을 가렸다.
const perfJs = fs.readFileSync(path.join(root, 'app-charts.js'), 'utf8');
assert.doesNotMatch(perfJs, /perfReturnSummary|perf-return-|performanceSummaryDefaultPosition|perf-overview|performanceOverview/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), /perf-return-/);
// 선 끝 라벨은 '이름 수익률'(2026-11-20 사용자 지시)
assert.match(perfJs, /<tspan class="perf-end-name">\$\{esc\(label\.name\)\}<\/tspan> <tspan class="perf-end-value">/);
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
assert.match(css, /\.perf-line\.perf-dimmed, \.perf-end-label\.perf-dimmed/);
console.log('Analysis views: basis/period, legend groups, focus reset and normal-flow chart controls passed.');

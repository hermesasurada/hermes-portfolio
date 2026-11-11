// 차트 왼쪽 위 오버레이 끌어 옮기기(2026-11-12): 위치는 범위 안 비율로 기억, 두 번 누르면 기본 자리.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const store = new Map();
ctx.storageGet = key => (store.has(key) ? store.get(key) : null);
ctx.storageSet = (key, value) => store.set(key, value);

// 저장·복원·범위 자르기·깨진 값
assert.equal(JSON.stringify(ctx.chartOverlayPosition('price')), JSON.stringify({ x: 0, y: 0 }));
ctx.saveChartOverlayPosition('price', { x: 0.4, y: 1.7 });
assert.equal(JSON.stringify(ctx.chartOverlayPosition('price')), JSON.stringify({ x: 0.4, y: 1 }));
store.set('portfolio.chart.metricOverlayPos', '{broken');
assert.equal(JSON.stringify(ctx.chartOverlayPosition('price')), JSON.stringify({ x: 0, y: 0 }));
ctx.saveChartOverlayPosition('price', null);
assert.equal(JSON.stringify(ctx.chartOverlayPosition('price')), JSON.stringify({ x: 0, y: 0 }));
assert.notEqual(h.evaluate(ctx, 'CHART_OVERLAY_POS_KEYS.price'), h.evaluate(ctx, 'CHART_OVERLAY_POS_KEYS.performance'));

// 종목 차트 상자: 저장된 비율 × 움직일 수 있는 범위(플롯 − 여백 20 − 상자)로 그린다
ctx.saveChartOverlayPosition('price', { x: 0.5, y: 0.25 });
const svg = ctx.renderDraggableChartMetricsOverlay([['등락', { text: '1.0%', cls: 'up' }]], { left: 14, top: 12 }, 600, 300, false);
assert.match(svg, /id="chartMetricDrag"/);
assert.match(svg, /data-room-w="460.00" data-room-h="204.00"/);       // 600−20−120, 300−20−76
assert.match(svg, /transform="translate\(230.00, 51.00\)"/);
assert.match(svg, /선택 기간/);

// 끌기: pointerdown → move → up이면 비율로 저장되고, dblclick이면 기본 자리
function fakeHandle() {
  const listeners = {};
  const classes = new Set();
  return {
    dataset: {}, listeners,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    fire(type, event) { (listeners[type] || []).slice().forEach(fn => fn({ preventDefault() {}, stopPropagation() {}, button: 0, pointerId: 1, ...event })); },
    setPointerCapture() {},
  };
}
store.clear();
const handle = fakeHandle();
const applied = [];
let enabled = true;
ctx.bindChartOverlayDrag(handle, 'performance', { range: () => ({ w: 200, h: 100 }), apply: pos => applied.push(pos), enabled: () => enabled });
ctx.bindChartOverlayDrag(handle, 'performance', { range: () => ({ w: 1, h: 1 }), apply: () => assert.fail('두 번 묶이면 안 된다') });
handle.fire('pointerdown', { clientX: 10, clientY: 10 });
assert.ok(handle.classList.contains('dragging'));
handle.fire('pointermove', { clientX: 110, clientY: 60 });
handle.fire('pointermove', { clientX: 900, clientY: -50 });               // 범위 밖은 0~1로 자른다
handle.fire('pointerup', {});
assert.ok(!handle.classList.contains('dragging'));
assert.equal(JSON.stringify(applied.map(p => [p.x, p.y])), JSON.stringify([[0.5, 0.5], [1, 0]]));
assert.equal(JSON.stringify(ctx.chartOverlayPosition('performance')), JSON.stringify({ x: 1, y: 0 }));
assert.equal((handle.listeners.pointermove || []).length, 0, '끝나면 move 처리기를 뗀다');
handle.fire('dblclick', {});
assert.equal(JSON.stringify(ctx.chartOverlayPosition('performance')), JSON.stringify({ x: 0, y: 0 }));
// 끌 수 없는 배치(모바일 띠)에서는 반응하지 않는다
enabled = false;
applied.length = 0;
handle.fire('pointerdown', { clientX: 0, clientY: 0 });
handle.fire('pointermove', { clientX: 50, clientY: 50 });
assert.equal(applied.length, 0);

// CSS: 상자 면만 포인터를 받는다(글자는 통과), 모바일 띠는 끌기 커서 없음
const css = h.readStatic('styles.css');
assert.match(css, /\.chart-metric-drag \.chart-metric-box \{[^}]*pointer-events: all/);
assert.match(css, /\.perf-return-summary \{[^}]*cursor: grab/);
console.log('Chart overlay drag: position saved as clamped ratio, dblclick resets, both charts wired');

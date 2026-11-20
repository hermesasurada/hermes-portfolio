// 성과·비교 차트의 터치 툴팁은 다음 터치에 닫힌다(2026-11-21 사용자 지시).
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());

function target() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn, capture) { (listeners[type] = listeners[type] || []).push({ fn, capture }); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(item => item.fn !== fn); },
    fire(type, event) { (listeners[type] || []).slice().forEach(item => item.fn(event)); },
  };
}
const doc = target();
ctx.document.addEventListener = doc.addEventListener.bind(doc);
ctx.document.removeEventListener = doc.removeEventListener.bind(doc);
const layer = target();
layer.contains = node => node === layer;
let shown = 0, hidden = 0;
ctx.bindHoverPointerEvents(layer, () => { shown += 1; }, () => { hidden += 1; });
// 실제 브라우저처럼 문서 캡처 → 대상 순서로 흘린다.
const touch = (on, x = 10) => {
  const event = { pointerType: 'touch', clientX: x, target: on };
  doc.fire('pointerdown', event);
  if (on === layer) layer.fire('pointerdown', event);
};

touch(layer);
assert.equal(shown, 1);
layer.fire('pointerleave', { pointerType: 'touch' });
assert.equal(hidden, 0, '손을 떼도 고정');
touch(layer, 40);                 // 차트를 다시 누르면 닫히고 새로 띄우지 않는다
assert.equal(hidden, 1);
assert.equal(shown, 1);
touch(layer, 60);                 // 그다음 터치는 다시 띄운다
assert.equal(shown, 2);
touch({});                        // 차트 밖을 누르면 닫힌다
assert.equal(hidden, 2);
assert.equal((doc.listeners.pointerdown || []).length, 0, '닫히면 문서 처리기를 뗀다');
// 손가락이 그냥 지나가는 움직임(고정 전)은 툴팁을 띄우지 않는다. 마우스는 그대로 따라간다.
layer.fire('pointermove', { pointerType: 'touch', clientX: 5 });
assert.equal(shown, 2);
layer.fire('pointermove', { pointerType: 'mouse', clientX: 5 });
assert.equal(shown, 3);
console.log('chart touch dismiss ok');

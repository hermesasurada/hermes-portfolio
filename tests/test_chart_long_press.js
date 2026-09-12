const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('portfolio_static/app-line-chart.js', 'utf8');
let now = 0, nextId = 0;
const timers = new Map();
const dismissListeners = new Set();
const ctx = vm.createContext({Date: {now: () => now},
  document: {
    addEventListener: (_, fn) => dismissListeners.add(fn),
    removeEventListener: (_, fn) => dismissListeners.delete(fn),
  },
  setTimeout: (fn, delay) => {timers.set(++nextId, {fn, at: now + delay}); return nextId;},
  clearTimeout: id => timers.delete(id),
});
vm.runInContext(source.slice(source.indexOf('function bindChartLongPress('), source.indexOf('function bindChartInteractions(')), ctx);
const handlers = {};
const target = {isConnected: true, addEventListener: (name, fn) => handlers[name] = fn};
let shown = 0, visible = false;
const suppressed = ctx.bindChartLongPress(target, () => {shown++; visible = true;}, () => {visible = false;});
const outsideTouch = () => [...dismissListeners].forEach(fn => fn({pointerType: 'touch'}));
const fire = (name, props = {}) => {
  if (name === 'pointerdown' && props.pointerType !== 'mouse') outsideTouch();
  handlers[name]({pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, ...props});
};
const advance = ms => {
  now += ms;
  for (const [id, timer] of timers) if (timer.at <= now) {timers.delete(id); timer.fn();}
};
fire('pointerdown'); advance(100); fire('pointerup'); advance(500);
assert.equal(shown, 0, 'tap does not display');
assert.equal(suppressed(), true, 'compatibility mouse events are suppressed');
fire('pointerdown'); advance(449); assert.equal(visible, false);
advance(1); assert.equal(visible, true);
fire('pointermove', {clientX: 130}); assert.equal(shown, 2, 'inspection follows a held finger');
fire('pointerup'); assert.equal(visible, true, 'release keeps the tooltip');
fire('pointerleave'); assert.equal(visible, true, 'implicit leave after release keeps tooltip');
advance(1500); assert.equal(visible, true, 'pinned result does not expire');
outsideTouch(); assert.equal(visible, false, 'another area dismisses the tooltip');
assert.equal(dismissListeners.size, 0, 'dismissal cleans up its document listener');
fire('pointerdown'); advance(450); fire('pointerup');
fire('pointerdown'); assert.equal(visible, false, 'new chart touch dismisses previous result');
fire('pointerup'); advance(500); assert.equal(visible, false, 'short second tap does not reopen');
fire('pointerdown'); fire('pointermove', {clientY: 111}); advance(500);
assert.equal(visible, false, 'scroll cancels pending press');
for (const name of ['pointercancel', 'pointerleave']) {
  fire('pointerdown'); fire(name); advance(500); assert.equal(visible, false);
}
fire('pointerdown'); fire('pointerdown', {pointerId: 2, isPrimary: false}); advance(500);
assert.equal(visible, false, 'second touch cancels');
fire('pointerdown'); target.isConnected = false; advance(500);
assert.equal(visible, false, 'detached charts cannot show stale overlays');
fire('pointerup'); target.isConnected = true; advance(1001);
assert.equal(suppressed(), false);
fire('pointerdown', {pointerType: 'mouse'}); advance(500);
assert.equal(visible, false, 'mouse behavior is handled by existing hover/drag handlers');
assert.match(source, /ichiBullHatch[^\n]*var\(--up\)/);
assert.match(source, /ichiBearHatch[^\n]*var\(--down\)[^\n]*stroke-width="1" opacity=".4"/);
assert.doesNotMatch(source, /ichiBearHatch[^\n]*stroke-dasharray/);
console.log('Chart long press: tap, hold, slide, release, scroll, cancel, multitouch, detach and mouse passed.');

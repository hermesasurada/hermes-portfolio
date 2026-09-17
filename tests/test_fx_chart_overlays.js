// 환율 차트에서는 BB·일목·이동평균을 쓰지 않는다 — 컨트롤을 잠그고 오버레이도 그리지 않는다.
// 저장된 선호는 건드리지 않아 종목 차트로 돌아가면 켜 두었던 상태가 살아난다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../portfolio_static/app-line-chart.js'), 'utf8');

const ctx = vm.createContext({ window: {} });
vm.runInContext(src.slice(src.indexOf('function chartOverlaysApply('),
  src.indexOf('function syncChartDisplayControls(')), ctx);
const applies = vm.runInContext('chartOverlaysApply', ctx);
assert.equal(applies({ category: 'fx' }), false);
assert.equal(applies({ category: 'stock' }), true);
assert.equal(applies({ category: 'index' }), true);
assert.equal(applies({ category: 'crypto' }), true);
assert.equal(applies({}), true);        // 분류가 없으면 종목처럼 다룬다
assert.equal(applies(null), true);      // 성과차트 등 payload 없는 호출도 안전

// 렌더는 저장 플래그가 아니라 'overlaysApply를 곱한' 값으로 그린다.
assert.match(src, /const overlaysApply = chartOverlaysApply\(payload\);/);
assert.match(src, /const showBollinger = chartShowBollinger && overlaysApply;/);
assert.match(src, /const showIchimoku = chartShowIchimoku && overlaysApply;/);
assert.match(src, /const maSeries = \(overlaysApply \? activeChartMovingAverages\(\) : \[\]\)/);
// 저장 플래그를 직접 읽어 그리면 환율에서도 오버레이가 남는다.
const renderStart = src.indexOf('const overlaysApply = chartOverlaysApply(payload);');
const renderBody = src.slice(renderStart);
for (const flag of ['chartShowBollinger ?', 'chartShowIchimoku ?']) {
  assert.ok(!renderBody.includes(flag), `렌더가 저장 플래그를 직접 읽는다: ${flag}`);
}
// 컨트롤 잠금과 안내 문구.
assert.match(src, /toggle\.disabled = !overlaysApply;/);
assert.match(src, /환율 차트에서는 사용하지 않습니다/);
// 하단 오버레이 버튼도 환율에서는 켜지지 않는다.
assert.match(src, /if \(!chartOverlaysApply\(payload\)\) return;/);
console.log('FX chart overlay gating: controls disabled, overlays skipped, prefs untouched ok');

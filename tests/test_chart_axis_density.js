// 개별종목 가격축 눈금 밀도: 기존보다 촘촘하되 상한을 넘지 않는다.
// 눈금 단위가 1·2·2.5·5 사다리라 desiredTicks만 올리면 종목에 따라 그대로인
// 구간이 있어(NVDA 5→9가 모두 25), 후보를 훑어 목표에 가까운 스케일을 고른다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../portfolio_static', file), 'utf8');

const h = require('./harness');
const ctx = h.loadScripts(h.createContext());

const series = (lo, hi, n = 120) =>
  Array.from({ length: n }, (_, i) => lo + (hi - lo) * (0.5 - Math.cos(i / 7) / 2));

// 실제 종목 가격대 표본 — 단위가 서로 다른 구간을 고루 덮는다.
const cases = [
  ['NVDA', 165, 236], ['AAPL', 246, 340], ['TSLA', 298, 445],
  ['O', 57, 66], ['PL', 16, 51], ['삼성전자', 167200, 362500], ['BTC', 89120000, 120095000],
];
for (const [label, lo, hi] of cases) {
  const values = series(lo, hi);
  const before = vm.runInContext('tightLowerChartScale', ctx)(values);
  const after = vm.runInContext('denseLowerChartScale', ctx)(values, 9, 11);
  assert.ok(after.ticks.length > before.ticks.length,
    `${label}: 눈금이 촘촘해지지 않았다 (${before.ticks.length} → ${after.ticks.length})`);
  assert.ok(after.ticks.length <= 11, `${label}: 상한 초과 ${after.ticks.length}`);
  // 축이 데이터를 계속 감싼다 — 촘촘해지느라 잘리면 안 된다.
  assert.ok(after.min <= lo && after.max >= hi, `${label}: 축이 데이터를 벗어났다`);
  // 눈금 간격은 일정해야 한다.
  const step = after.ticks[1] - after.ticks[0];
  for (let i = 2; i < after.ticks.length; i += 1) {
    assert.ok(Math.abs((after.ticks[i] - after.ticks[i - 1]) - step) < step / 1000,
      `${label}: 눈금 간격이 고르지 않다`);
  }
}

// 좁은 화면은 목표·상한을 낮춰 라벨이 붙지 않게 한다.
const narrow = vm.runInContext('denseLowerChartScale', ctx)(series(165, 236), 7, 8);
assert.ok(narrow.ticks.length <= 8);
// 값이 없으면 기존 스케일로 떨어진다(예외 없이).
assert.ok(vm.runInContext('denseLowerChartScale', ctx)([], 9, 11).ticks.length >= 2);

// 단일 가격차트가 이 스케일을 화면 폭에 맞춰 호출한다(로그축은 기존 로그 눈금 유지).
const chart = read('app-line-chart.js');
assert.match(chart, /denseLowerChartScale\(scaleValues, compactChart \? 7 : 9, compactChart \? 8 : 11\)/);
assert.match(chart, /useLog\s*\n?\s*\? logChartScale\(scaleValues\)/);
console.log('chart price axis density: finer ticks, cap, even spacing and compact target ok');

// 휴장 행의 등락금액 표기 — '-'가 아니라 확정된 0
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({window: {}});
const format = fs.readFileSync('portfolio_static/format.js', 'utf8');
vm.runInContext(format.slice(0, format.indexOf('\n', format.indexOf('const fmt2'))), ctx);
vm.runInContext(format.slice(format.indexOf('function krwRoundedMan('), format.indexOf('function money(')), ctx);
vm.runInContext(format.slice(format.indexOf('function changeKrwText('), format.indexOf('function weightText(')), ctx);
const holdings = fs.readFileSync('portfolio_static/app-holdings.js', 'utf8');
vm.runInContext(holdings.slice(holdings.indexOf('function isHolidayPreviousSession('), holdings.indexOf('function holdingUnitKrw(')), ctx);

assert.equal(ctx.isHolidayPreviousSession({change_session_note: {kind: 'holiday_previous_session'}}), true);
assert.equal(ctx.isHolidayPreviousSession({change_session_note: {kind: 'session_closed'}}), false);
assert.equal(ctx.isHolidayPreviousSession({}), false);

// 휴장: 0도, 만원 미만 잔여도 0으로 못 박는다
for (const v of [0, -0, 5000, -9999]) {
  const out = ctx.changeKrwText(v, {zeroWhenFlat: true});
  assert.match(out, /change-cell flat/);
  assert.match(out, />0<\/span>$/);
}
// 휴장이라도 환율이 만든 변동분이 크면 평소대로 표기한다
assert.match(ctx.changeKrwText(250000, {zeroWhenFlat: true}), /change-cell up/);
assert.match(ctx.changeKrwText(-250000, {zeroWhenFlat: true}), /change-cell down/);
// 평소(휴장 아님)에는 기존 규칙 그대로 — 만원 이하 노이즈는 '-'
assert.equal(ctx.changeKrwText(0), '-');
assert.equal(ctx.changeKrwText(5000), '-');
assert.equal(ctx.changeKrwText(null, {zeroWhenFlat: true}), '-');
assert.equal(ctx.changeKrwText(NaN, {zeroWhenFlat: true}), '-');
console.log('Holiday change amount: explicit zero, fx remainder kept, normal rows unchanged OK');

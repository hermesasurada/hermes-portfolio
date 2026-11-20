// 등락 칩의 장 상태 표시(2026-11-20 사용자 지시): 글자 배지 대신 칩 모양 — 진행 중 채움, 장 종료 실선 테두리, 휴장 점선 테두리.
const assert = require('assert');
const h = require('./harness');
const vm = require('vm');

const context = vm.createContext({ console, Intl, Number, String, Math, window: {} });
vm.runInContext(h.readStatic('format.js'), context);
const markup = row => vm.runInContext(`changeMarkup(${JSON.stringify(row)})`, context);

const live = markup({ display_change_pct: 1.5, change_session_note: null });
assert.match(live, /class="change-cell pct-chip up"/);
assert.doesNotMatch(live, /session-|<sup/);

const closed = markup({ display_change_pct: -2.25, change_session_note: { kind: 'session_closed', label: '종', price_date: '2026-11-19', reason: '장 종료' } });
assert.match(closed, /class="change-cell pct-chip down session-closed"/);
assert.match(closed, /title="2026\.11\.19 종가 기준 등락 · 장 종료"/);
assert.match(closed, /<span class="sr-only"> · 장 종료<\/span>/);
assert.doesNotMatch(closed, /<sup|>종</);

for (const kind of ['holiday_closed', 'holiday_previous_session']) {
  const holiday = markup({ display_change_pct: 0, change_session_note: { kind, label: '휴', price_date: '2026-11-19', reason: '근로감사의 날' } });
  assert.match(holiday, /pct-chip flat session-holiday/);
  assert.match(holiday, /sr-only"> · 휴장</);
  assert.doesNotMatch(holiday, /<sup|>휴</);
}

// 값이 없으면 상태와 무관하게 '-'.
assert.equal(markup({ display_change_pct: null, change_session_note: { kind: 'session_closed', label: '종' } }), '-');

console.log('change session chip tests passed');

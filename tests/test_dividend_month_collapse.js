// 배당 탭: 당월 포함 3개월만 기본으로 펼치고 그 뒤 달은 접는다. 사용자가 누른 달은 그 선택을 따른다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const open = (key, today) => ctx.dividendMonthOpenByDefault(key, today);
const collapsed = (key, today) => ctx.dividendMonthCollapsed(key, today);

// 2026-09-29 기준: 9·10·11월 펼침, 12월부터 접힘
const today = '2026-09-29';
assert.deepEqual(['2026-09', '2026-10', '2026-11'].map(k => open(k, today)), [true, true, true]);
assert.deepEqual(['2026-12', '2027-01', '2027-09'].map(k => open(k, today)), [false, false, false]);
// 연도를 넘는 창: 11월 기준이면 11·12·1월
assert.deepEqual(['2026-11', '2026-12', '2027-01', '2027-02'].map(k => open(k, '2026-11-03')), [true, true, true, false]);
// 지난 달·날짜 미정은 기본 접힘
assert.equal(open('2026-08', today), false);
assert.equal(open('unknown', today), false);

// 월초(1~5일)엔 서버가 전월도 보내 준다 — 전월은 접힘, 당월부터 3개월 펼침
assert.deepEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'].map(k => open(k, '2026-10-01')), [false, true, true, true, false]);
// 사용자가 누른 달은 기본 규칙보다 우선한다
h.evaluate(ctx, 'dividendMonthOverrides = new Map([["2027-01", false], ["2026-10", true]])');
assert.equal(collapsed('2027-01', today), false, '접힌 달을 펼쳤다');
assert.equal(collapsed('2026-10', today), true, '펼친 달을 접었다');
assert.equal(collapsed('2027-02', today), true, '누르지 않은 달은 기본 규칙');
assert.equal(collapsed('2026-11', today), false);
h.evaluate(ctx, 'dividendMonthOverrides = new Map()');

// 렌더와 토글이 같은 판정을 쓴다(예전 Set 기반 상태가 다시 생기지 않는다)
const tabs = h.readStatic('app-tabs.js') + h.readStatic('app.js');
assert.doesNotMatch(tabs, /collapsedDividendMonths/);
assert.match(h.readStatic('app-tabs.js'), /dividendMonthOverrides\.set\(key, !dividendMonthCollapsed\(key, today\)\)/);
console.log('Dividend months: current + 2 open by default, later/unknown collapsed, user toggles override');

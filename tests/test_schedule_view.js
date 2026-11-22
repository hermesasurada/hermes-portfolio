// 일정 팝업(2026-11-08 개편): 목록 하나, 유형(실적·배당기준·배당지급·촉매·공통) 토글, 시장·종류·보유 필터.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.equal(run('scheduleMarket("AAPL")'), 'us');
assert.equal(run('scheduleMarket("BRK-B")'), 'us');
assert.equal(run('scheduleMarket("6857.T")'), 'jp');
assert.equal(run('scheduleMarket("005930.KS")'), 'kr');
assert.equal(run('scheduleMarket("247540.KQ")'), 'kr');
assert.equal(run('scheduleMarket("BMW.DE")'), 'other');

const payload = {
  today: '2026-11-08', start: '2025-11-01', end: '2027-11-30',
  earnings: [{ ticker: 'MU', name: 'Micron', kind: 'stock', earnings_date: '2026-11-20', owned: true }],
  dividends: [{ ticker: '005930.KS', name: '삼성전자', kind: 'stock', base_date: '2026-11-10', base_kind: 'record',
                pay_date: '2026-11-25', date: '2026-11-25', amount: 361, currency: 'KRW', base_estimated: false, estimated: true },
              { ticker: 'SCHD', name: 'Schwab', kind: 'etf', base_date: '2026-11-03', base_kind: 'ex', pay_date: null, date: null, amount: null }],
  catalysts: [{ ticker: '6857.T', name: 'Advantest', kind: 'stock', date: '2026-11-20', title: '<b>테스터</b> 수주' }],
};
ctx.__payload = payload;
const events = run('normalizedScheduleEvents(__payload)');
assert.equal(events.map(e => `${e.date}:${e.type}`).join(','),
  '2026-11-03:dividend_base,2026-11-10:dividend_base,2026-11-20:earnings,2026-11-20:catalyst,2026-11-25:dividend_pay');
assert.equal(events[0].past, true);
assert.equal(events.find(e => e.type === 'dividend_pay').estimated, true);

// 필터
run('schedulePayload = __payload; scheduleMonth = new Date(2026, 10, 1)');
const visible = () => run('visibleScheduleEvents().map(e => e.type + ":" + e.ticker).join(",")');
assert.equal(visible().split(',').length, 5);
run('scheduleTypeVisible.delete("dividend_base")');
assert.doesNotMatch(visible(), /dividend_base/);
run('scheduleTypeVisible.add("dividend_base"); scheduleKind = "etf"');
assert.equal(visible(), 'dividend_base:SCHD');
run('scheduleKind = "all"; scheduleMarketVisible.delete("us")');
assert.doesNotMatch(visible(), /MU|SCHD/);
run('scheduleMarketVisible.add("us"); scheduleHeldOnly = true');
assert.equal(visible(), 'earnings:MU');
run('scheduleHeldOnly = false');
run('scheduleMonth = new Date(2026, 11, 1)');
assert.equal(visible(), '');

// 목록: 촉매는 제목만(이스케이프), 배당락 표기, 오늘·지난 표시, 격자 없음
run('scheduleMonth = new Date(2026, 10, 1)');
const html = run('renderScheduleList(visibleScheduleEvents(), "2026-11-08")');
assert.match(html, /&lt;b&gt;테스터&lt;\/b&gt; 수주/);
assert.match(html, /배당락 · 금액 미정/);
assert.match(html, /기준일 · 주당/);
assert.match(html, /schedule-day past/);
assert.doesNotMatch(html, /schedule-calendar|schedule-weekday/);
assert.match(run('renderScheduleList([], "2026-11-08")'), /일정이 없습니다/);

// 공통(2026-11-22): 증류 '공통' 묶음. 시장·종류·보유 필터를 타지 않고 칩으로만, 차트 링크 없는 줄
ctx.__payload2 = { ...payload, general: [{ date: '2026-11-20', title: '<i>PCE</i> 발표', cluster: '미국' }] };
run('schedulePayload = __payload2; scheduleMonth = new Date(2026, 10, 1); scheduleHeldOnly = true; scheduleKind = "etf"; scheduleMarketVisible.clear()');
assert.equal(visible(), 'general:');
const generalHtml = run('renderScheduleList(visibleScheduleEvents(), "2026-11-08")');
assert.match(generalHtml, /<div class="schedule-row general"[\s\S]*<strong>미국<\/strong>[\s\S]*공통[\s\S]*&lt;i&gt;PCE&lt;\/i&gt; 발표/);
assert.doesNotMatch(generalHtml, /data-chart-ticker/);
run('scheduleTypeVisible.delete("general")');
assert.equal(visible(), '');
run('scheduleTypeVisible.add("general"); scheduleHeldOnly = false; scheduleKind = "all"; ["us","jp","kr","other"].forEach(m => scheduleMarketVisible.add(m))');
// 같은 날은 실적·촉매 다음에 공통
assert.equal(run('normalizedScheduleEvents(__payload2).filter(e => e.date === "2026-11-20").map(e => e.type).join(",")'), 'earnings,catalyst,general');

// 유형 저장은 끈 것만 — 예전 켠 목록을 저장해 둔 사람도 새 유형(공통)은 켜져 보인다
const store = {};
ctx.storageGet = key => (key in store ? store[key] : null);
store['portfolio.schedule.types'] = JSON.stringify(['earnings', 'catalyst']);
assert.deepEqual(h.plain([...run('scheduleHiddenTypes()')]).sort(), ['dividend_base', 'dividend_pay']);
store['portfolio.schedule.hiddenTypes'] = JSON.stringify(['general']);
assert.deepEqual(h.plain([...run('scheduleHiddenTypes()')]), ['general']);
console.log('schedule view ok');

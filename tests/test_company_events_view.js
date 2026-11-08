// 촉매·일정 팝업(2026-11-08): 버튼 표시 조건·배지, 정렬, 이스케이프, 링크 안전.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.equal(run('companyEventPlain("[[키옥시아]] F1Q와 [[SK hynix|하이닉스]]")'), '키옥시아 F1Q와 하이닉스');
assert.equal(run('companyEventDateText({date: "2026-12-09", date_precision: "day", date_text: "x"})'), '2026-12-09');
assert.equal(run('companyEventDateText({date: "2026-12-31", date_precision: "quarter", date_text: "2026년 4분기"})'), '2026년 4분기');
assert.equal(run('companyEventDateText({date: null, date_text: ""})'), '미정');

// 묶음 순서 → 같은 묶음 안에서 실적 역주입분은 뒤로 → 날짜 오름차순
const order = run(`sortCompanyEvents([
  {bucket: "resolved", date: "2026-10-01", title: "r"},
  {bucket: "upcoming", date: "2026-12-24", attribution: "portfolio_db", title: "e"},
  {bucket: "upcoming", date: "2026-12-31", title: "b"},
  {bucket: "undated", date: null, date_text: "", title: "u"},
  {bucket: "upcoming", date: "2026-12-09", title: "a"},
  {bucket: "overdue_unresolved", date: "2026-11-01", title: "o"},
]).map(e => e.title).join("")`);
assert.equal(order, 'abeour');

const table = run(`companyEventsTableMarkup({events: [
  {bucket: "upcoming", date: "2026-12-09", date_precision: "day", status: "예정", title: "<b>X</b>", attribution: "text_match",
   success_condition: "조건", source: {cluster: "AI·테크", catalyst_id: "C195"}, linked_hypotheses: [{id: "H01", title: "가설"}],
   evidence: [{ref: "S-1", url: "https://t.me/a/1"}, {ref: "S-2", url: "javascript:alert(1)"}]},
  {bucket: "resolved", date: "2026-10-30", date_precision: "day", status: "예정", title: "실적", verdict: {value: "부분충족", note: "메모"}},
]})`);
assert.match(table, /&lt;b&gt;X&lt;\/b&gt;/);
assert.match(table, /다가오는 일정/);
assert.match(table, /판정 완료/);
assert.match(table, /추정/);
assert.match(table, /출처 AI·테크 C195/);
assert.match(table, /가설 H01 가설/);
assert.match(table, /href="https:\/\/t\.me\/a\/1" target="_blank"/);
assert.doesNotMatch(table, /javascript:/);
assert.match(table, /부분충족/);

// 버튼: 요약이 있을 때만, 성과·비교 화면에서는 숨김, 배지는 다가오는 건수
const button = { classList: { hidden: null, toggle(_, v) { this.hidden = v; } }, dataset: {}, innerHTML: '', title: '' };
ctx.document.getElementById = id => (id === 'chartCompanyEvents' ? button : null);
const sync = payload => { run(`syncChartEventsButton(${JSON.stringify(payload)})`); return button.classList.hidden; };
assert.equal(sync({ ticker: 'MU', name: 'Micron', company_events: { count: 12, upcoming: 5 } }), false);
assert.equal(button.dataset.ticker, 'MU');
assert.match(button.innerHTML, /company-events-badge">5</);
assert.equal(sync({ ticker: 'MU', company_events: { count: 3, upcoming: 0 } }), false);
assert.doesNotMatch(button.innerHTML, /badge/);
assert.equal(sync({ ticker: 'MMM', company_events: null }), true);
assert.equal(sync(null), true);
run('chartComparePayloads = [{ticker: "SPY"}]');
assert.equal(sync({ ticker: 'MU', company_events: { count: 1, upcoming: 1 } }), true);
run('chartComparePayloads = []');
run('performanceChartOpen = true');
assert.equal(sync({ ticker: 'MU', company_events: { count: 1, upcoming: 1 } }), true);
console.log('company events view ok');

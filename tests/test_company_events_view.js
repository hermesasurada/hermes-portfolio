// 촉매·일정 팝업(2026-11-08): 버튼 표시 조건·배지, 정렬, 이스케이프, 표시 항목 제한.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.equal(run('companyEventPlain("[[키옥시아]] F1Q와 [[SK hynix|하이닉스]]")'), '키옥시아 F1Q와 하이닉스');
// 정렬: 다가오는(가까운 순) → 미정 → 지난(최근 것부터). 실적도 같은 줄에 섞인다
const order = run(`sortCompanyEvents([
  {bucket: "resolved", date: "2026-10-01", title: "p2"},
  {bucket: "upcoming", date: "2026-12-24", attribution: "portfolio_db", title: "u2"},
  {bucket: "undated", date: null, date_text: "", title: "n"},
  {bucket: "upcoming", date: "2026-12-09", title: "u1"},
  {bucket: "overdue_unresolved", date: "2026-11-01", title: "p1"},
  {bucket: "stale", date: "2026-08-01", title: "p3"},
]).map(e => e.title).join(",")`);
assert.equal(order, 'u1,u2,n,p1,p2,p3');

const list = run(`companyEventsListMarkup({events: [
  {bucket: "upcoming", date: "2026-12-09", date_precision: "day", status: "예정", title: "<b>X</b>", attribution: "text_match",
   success_condition: "조건 [[키옥시아]]", source: {cluster: "AI·테크", catalyst_id: "C195"}, linked_hypotheses: [{id: "H01", title: "가설"}],
   evidence: [{ref: "S-1", url: "https://t.me/a/1"}]},
  {bucket: "upcoming", date: "2026-12-31", date_precision: "quarter", date_text: "2026년 4분기", status: "예정", title: "Q"},
  {bucket: "upcoming", date: "2026-12-24", date_precision: "day", attribution: "portfolio_db", title: "실적 발표 예정"},
  {bucket: "resolved", date: "2026-10-30", date_precision: "day", status: "예정", title: "R", verdict: {value: "부분충족", note: "메모"}},
]})`);
assert.match(list, /&lt;b&gt;X&lt;\/b&gt;/);
assert.match(list, /company-event-day">12\.09</);
assert.match(list, /2026년 4분기/);
assert.match(list, /조건 키옥시아/);
assert.match(list, /company-event-chip earnings">실적</);
assert.match(list, /company-event-chip good">부분충족</);
assert.match(list, /company-event-item past/);
// 지난 일정: 판정이 없으면 '지남', 판정·지연 상태가 있으면 그것
assert.match(run(`companyEventChipMarkup({bucket: "stale", date: "2026-07-31", status: "예정"})`), /passed">지남</);
assert.match(run(`companyEventChipMarkup({bucket: "overdue_unresolved", date: "2026-11-01", status: "지연"})`), /warn">지연</);
assert.match(run(`companyEventChipMarkup({bucket: "resolved", date: "2026-10-30", status: "예정", verdict: {value: "무산"}})`), /bad">무산</);
assert.match(run(`companyEventChipMarkup({bucket: "upcoming", date: "2026-12-09", status: "예정"})`), /chip">예정</);
// 출처·근거·가설·추정·판정 메모는 보이지 않는다
for (const hidden of [/C195/, /AI·테크/, /S-1/, /t\.me/, /H01/, /추정/, /메모/]) assert.doesNotMatch(list, hidden);
const summary = run(`companyEventsSummaryMarkup({events: [{bucket: "upcoming", date: "2026-12-01"}, {bucket: "undated", date: null}, {bucket: "stale", date: "2026-01-01"}, {bucket: "resolved", date: "2026-10-01"}]})`);
assert.equal(summary.replace(/<[^>]+>/g, ''), '다가오는 1 · 미정 1 · 지난 2');

// 버튼: 요약이 있을 때만, 성과·비교 화면에서는 숨김, 배지는 다가오는 건수
const button = { classList: { hidden: null, toggle(_, v) { this.hidden = v; } }, dataset: {}, innerHTML: '', title: '' };
ctx.document.getElementById = id => (id === 'chartCompanyEvents' ? button : null);
const sync = payload => { run(`syncChartEventsButton(${JSON.stringify(payload)})`); return button.classList.hidden; };
assert.equal(sync({ ticker: 'MU', name: 'Micron', company_events: { count: 12, upcoming: 5 } }), false);
assert.equal(button.dataset.ticker, 'MU');
assert.match(button.innerHTML, /company-events-badge">5</);
assert.equal(sync({ ticker: 'MU', company_events: { count: 3, upcoming: 0 } }), false);
assert.doesNotMatch(button.innerHTML, /badge/);
assert.equal(sync({ ticker: 'MMM', company_events: { count: 1, upcoming: 1 } }), false);   // 실적만 있어도 보인다
assert.equal(sync({ ticker: 'XYZ', company_events: null }), true);
assert.equal(sync(null), true);
run('chartComparePayloads = [{ticker: "SPY"}]');
assert.equal(sync({ ticker: 'MU', company_events: { count: 1, upcoming: 1 } }), true);
run('chartComparePayloads = []');
run('performanceChartOpen = true');
assert.equal(sync({ ticker: 'MU', company_events: { count: 1, upcoming: 1 } }), true);
console.log('company events view ok');

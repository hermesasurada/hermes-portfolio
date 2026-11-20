// 배당 탭 '오늘' 마커: 지급일이 오늘인 배당은 마커 아래(앞으로 올 쪽)에 온다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const body = h.element();
const others = new Map();
ctx.document.getElementById = id => (id === 'dividendRows' ? body : (others.get(id) || others.set(id, h.element()).get(id)));
ctx.todayLocal = () => '2026-09-29';
ctx.schedulePcFrozenColumns = () => {};
ctx.scheduleTableViewportRows = () => {};
ctx.dividendSelectionKey = () => 'k';
const row = (ticker, pay) => ({ticker, name: ticker, pay_date: pay, ex_date: pay, amount: 1, qty: 1, gross: 1, net: 1, net_krw: 1000, currency: 'USD'});
ctx.__rows = [row('PAST', '2026-09-15'), row('QLD', '2026-09-29'), row('NEXT', '2026-09-30'), row('OCT', '2026-10-02')];
const render = dir => {
  h.evaluate(ctx, `dividendLoadKey = 'k'; dividendData = {rows: __rows}; sortState.dividend = {key: 'pay_date', dir: ${dir}}; dividendMonthOverrides = new Map();`);
  ctx.renderDividendTable();
  // 행 순서를 '티커' 또는 'TODAY'로 뽑는다
  return [...body.innerHTML.matchAll(/dividend-today-row|data-chart-ticker="([A-Z]+)"/g)].map(m => m[1] || 'TODAY');
};
const asc = render(1);
assert.deepEqual(asc, ['PAST', 'TODAY', 'QLD', 'NEXT', 'OCT'], `오름차순: ${asc}`);
// 오늘 지급분은 '지급 예정' 스타일(마커 아래와 같은 쪽)
const qldRow = body.innerHTML.split('<tr').find(tr => tr.includes('data-chart-ticker="QLD"'));
assert.match(qldRow, /dividend-upcoming-row/);
assert.match(body.innerHTML.split('<tr').find(tr => tr.includes('data-chart-ticker="PAST"')), /dividend-paid-row/);
// 내림차순에서도 마커는 '오늘 이후'와 '지난 배당' 사이 — 오늘 지급분은 마커 위(앞으로 올 쪽 끝)
const desc = render(-1);
assert.deepEqual(desc.filter(t => t !== 'OCT'), ['NEXT', 'QLD', 'TODAY', 'PAST'], `내림차순: ${desc}`);
console.log('Dividend today marker: payments due today sit on the upcoming side in both directions');

// 배당 탭 손질(2026-11-20 디자인 재검토 10): 같은 종목·같은 회차가 이어지면 둘째 줄부터 대상별 숫자만.
{
  const row = (extra = {}) => ({ kind: 'row', monthKey: '2026-11', row: { ticker: 'AAA', pay_date: '2026-11-03', ex_date: '2026-10-29', amount: 3, currency: 'KRW', ...extra } });
  const cont = (a, b) => ctx.dividendRowContinues(a, b);
  assert.equal(cont(row(), row({ target: 'Claire' })), true);
  assert.equal(cont(row(), row({ ticker: 'BBB' })), false);
  assert.equal(cont(row(), row({ amount: 4 })), false);
  assert.equal(cont(row(), row({ pay_date: '2026-11-04' })), false);
  assert.equal(cont({ kind: 'month', key: '2026-11' }, row()), false);
  assert.equal(cont(row(), { ...row(), monthKey: '2026-12' }), false);
}

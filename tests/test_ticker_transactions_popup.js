// 종목 차트 '내역' 팝업(2026-10-26): 전 계좌 거래 표 + 요약. 숨긴 거래는 흐리게 보이고 합계에서 빠진다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);
const json = code => JSON.parse(run(`JSON.stringify(${code})`));

ctx.__rows = [
  {id: 3, trade_date: '2026-10-07', member: 'Claire', account_name: '해외주식', side: 'SELL', qty: 40, price: 237.2, currency: 'USD', memo: '일부 차익', hidden: 0},
  {id: 2, trade_date: '2026-03-01', member: 'Ray', account_name: '해외주식', side: 'BUY', qty: 10, price: 100, currency: 'USD', memo: null, hidden: 0},
  {id: 1, trade_date: '2025-01-02', member: 'Ray', account_name: '해외주식', side: 'BUY', qty: 30, price: 200, currency: 'USD', memo: '<b>x</b>', hidden: 0},
  {id: 0, trade_date: '2024-01-02', member: 'Ray', account_name: '해외주식', side: 'BUY', qty: 999, price: 1, currency: 'USD', hidden: 1},
];
const s = json('tickerTransactionSummary(__rows)');
assert.equal(s.buy.count, 2);           // 숨긴 거래 제외
assert.equal(s.buy.qty, 40);
assert.equal(s.buy.avg, 175);           // (10×100 + 30×200) / 40
assert.equal(s.sell.count, 1);
assert.equal(s.hidden, 1);
assert.equal(s.first, '2025-01-02');
assert.equal(s.last, '2026-10-07');

const html = run('tickerTransactionsMarkup(__rows, "NVDA")');
assert.equal((html.match(/<tr class=/g) || []).length, 4);   // 숨긴 거래도 행으로는 보인다
assert.equal((html.match(/tx-hidden-row/g) || []).length, 1);
assert.match(html, /Claire · 해외주식/);
assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);                // 메모는 이스케이프
assert.doesNotMatch(html, /<b>x<\/b>/);
assert.match(run('tickerTransactionsSummaryMarkup(__rows, "NVDA")'), /숨김 1건 제외/);
assert.match(run('tickerTransactionsMarkup([], "NVDA")'), /거래내역이 없습니다/);
// 차트 컨트롤 '거래' 묶음에 내역 버튼(소스 검사)
assert.match(h.readStatic('app-line-chart.js'), /data-chart-tx-history/);
console.log('ticker transactions popup ok');

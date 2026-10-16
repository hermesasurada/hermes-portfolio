// 거래 메모(2026-10-16): 메모가 있는 거래만 목록 종목명 옆 아이콘, 행 편집은 메모를 다루지 않고,
// 저장 확인창은 메모가 있을 때만 메모 줄을 보인다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.equal(run('txMemoButton({id: 1, memo: null})'), '');
assert.equal(run('txMemoButton({id: 1, memo: "   "})'), '');
const btn = run('txMemoButton({id: 7, memo: "<b>실적 전</b> 분할매수"})');
assert.match(btn, /data-tx-memo="7"/);
assert.match(btn, /title="&lt;b&gt;실적 전&lt;\/b&gt; 분할매수"/);   // 툴팁은 이스케이프

// 목록 행: 보기 행만 아이콘, 편집 행은 메모 없음
ctx.currentPriceForTicker = () => null;
ctx.txTickerCell = tx => tx.ticker;
const tx = '{id: 7, trade_date: "2026-10-16", ticker: "AAPL", name: "Apple", side: "BUY", qty: 1, price: 100, currency: "USD", memo: "메모"}';
assert.match(run(`txViewRow(${tx}, null)`), /data-tx-memo="7"/);
assert.doesNotMatch(run(`txEditRow(${tx}, null)`), /data-tx-memo|memo/i);

// 저장 확인창: 메모가 있을 때만 '메모' 줄
ctx.tradeAccountLabel = () => '계좌';
const payload = memo => `{trade_date: "2026-10-16", account_id: 1, ticker: "AAPL", name: "Apple", side: "BUY", qty: "1", price: "100", currency: "USD", apply_to_holdings: true, memo: ${JSON.stringify(memo)}}`;
assert.doesNotMatch(run(`tradeConfirmRows(${payload('')})`), />메모</);
assert.match(run(`tradeConfirmRows(${payload('목표가 120')})`), />메모<[\s\S]*목표가 120/);
console.log('transaction memo ok');

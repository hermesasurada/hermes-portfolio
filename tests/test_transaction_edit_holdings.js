// 기존 거래 수정: 잔고에 반영됐던 거래의 유형·수량·단가가 바뀌면 잔고 반영 여부를 한 번 묻는다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const touches = (orig, payload) => ctx.transactionEditTouchesHoldings(orig, payload);
const tx = { id: 7, ticker: 'TSM', name: 'TSMC', account_id: 1, side: 'BUY', qty: 10, price: 472.78, currency: 'USD', apply_to_holdings: 1 };

// 언제 묻나
assert.equal(touches(tx, { side: 'SELL', qty: '10', price: '472.78' }), true, '매수→매도');
assert.equal(touches(tx, { side: 'BUY', qty: '4', price: '472.78' }), true, '수량');
assert.equal(touches(tx, { side: 'BUY', qty: '10', price: '470' }), true, '단가');
assert.equal(touches(tx, { side: 'BUY', qty: '10', price: '472.78', trade_date: '2026-10-02', note: 'x' }), false, '거래일·메모만');
assert.equal(touches({ ...tx, apply_to_holdings: 0 }, { side: 'SELL' }), false, '잔고에 반영된 적 없는 거래');
assert.equal(touches(undefined, { side: 'SELL' }), false);

// 저장 흐름: 고른 답이 요청에 실리고, 잔고 반영이면 받은 포트폴리오로 다시 그린다
const row = h.element();
row.querySelectorAll = () => [
  { dataset: { txField: 'trade_date' }, value: '2026-10-02' }, { dataset: { txField: 'side' }, value: 'SELL' },
  { dataset: { txField: 'price' }, value: '472.78' }, { dataset: { txField: 'qty' }, value: '10' },
];
ctx.document.querySelector = sel => (sel === 'tr[data-tx-row="7"]' ? row : null);
ctx.__tx = [tx];
h.evaluate(ctx, 'transactionRows = __tx');
let sent = null, rendered = 0, status = '';
ctx.apiUpdateTransaction = async payload => { sent = payload; return payload.apply_to_holdings ? { ok: true, holdings_applied: true, portfolio: { members: [] } } : { ok: true, holdings_applied: false }; };
ctx.loadTransactions = async () => {};
ctx.render = () => { rendered++; };
ctx.showTradeStatus = text => { status = text; };
ctx.showTradeError = err => { throw err; };

(async () => {
  for (const [choice, expectApply, expectRender, expectStatus] of [['apply', true, 1, '수정됨 · 잔고 반영'], ['ledger', false, 0, '수정됨']]) {
    sent = null; rendered = 0;
    ctx.askTransactionEditHoldings = async () => choice;
    await ctx.saveTransactionEdit(7);
    assert.equal(sent.apply_to_holdings, expectApply, choice);
    assert.equal(rendered, expectRender, `${choice} 렌더`);
    assert.equal(status, expectStatus);
  }
  // 잔고 반영이면 data가 응답 포트폴리오로 바뀐다
  assert.equal(JSON.stringify(h.evaluate(ctx, 'data')), JSON.stringify({ members: [] }));
  // 취소면 요청을 보내지 않는다
  sent = null;
  ctx.askTransactionEditHoldings = async () => 'cancel';
  await ctx.saveTransactionEdit(7);
  assert.equal(sent, null);
  assert.equal(status, '수정 취소');
  // 묻지 않는 수정(거래일만)은 apply_to_holdings를 싣지 않는다 — 서버 기본(원장만)
  row.querySelectorAll = () => [{ dataset: { txField: 'trade_date' }, value: '2026-10-01' }];
  let asked = false;
  ctx.askTransactionEditHoldings = async () => { asked = true; return 'apply'; };
  await ctx.saveTransactionEdit(7);
  assert.equal(asked, false);
  assert.equal('apply_to_holdings' in sent, false);
  // 대화상자: 세 버튼과 설명이 있다
  const html = h.readStatic('index.html');
  assert.match(html, /id="txEditHoldingsModal"[\s\S]*id="txEditHoldingsCancel"[\s\S]*id="txEditHoldingsLedger"[\s\S]*id="txEditHoldingsApply"/);
  console.log('Transaction edit holdings: asks only when side/qty/price change on applied trades, sends choice, refreshes holdings');
})().catch(err => { console.error(err); process.exit(1); });

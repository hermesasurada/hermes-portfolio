// 거래 삭제(2026-11-11): 잔고에 반영됐던 거래는 잔고에서도 되돌릴지 묻고, 거래 저장은 두 번 제출되지 않는다.
// 사례: SKT 매수 1주가 저장(4초) 중 다시 눌려 두 번 기록 → 하나를 지웠지만 잔고는 69주 그대로였다.
const assert = require('node:assert/strict');
const h = require('./harness');

const ctx0 = h.createContext();
let submitHandler = null;
ctx0.document.byId.set('tradeForm', h.element({
  id: 'tradeForm',
  addEventListener(type, fn) { if (type === 'submit') submitHandler = fn; },
  querySelectorAll: () => [],
}));
const ctx = h.loadScripts(ctx0);
const applied = { id: 9, ticker: '017670.KS', name: 'SK텔레콤', account_id: 6, side: 'BUY', qty: 1, price: 82600, currency: 'KRW', trade_date: '2026-11-11', apply_to_holdings: 1 };
const ledgerOnly = { ...applied, id: 10, apply_to_holdings: 0 };
ctx.__tx = [applied, ledgerOnly];
h.evaluate(ctx, 'transactionRows = __tx');

let sent = [], rendered = 0, status = '', asked = 0, confirmed = 0;
ctx.apiDeleteTransaction = async (id, apply) => {
  sent.push([id, apply]);
  return apply ? { ok: true, holdings_applied: true, portfolio: { members: ['x'] } } : { ok: true, holdings_applied: false };
};
ctx.loadTransactions = async () => {};
ctx.render = () => { rendered++; };
ctx.showTradeStatus = text => { status = text; };
ctx.showTradeError = err => { throw err; };
ctx.window.confirm = () => { confirmed++; return true; };

(async () => {
  for (const [choice, expected, expectStatus, expectRender] of [
    ['apply', [[9, true]], '삭제됨 · 잔고 되돌림', 1],
    ['ledger', [[9, false]], '삭제됨', 0],
    ['cancel', [], '삭제 취소', 0],
  ]) {
    sent = []; rendered = 0; asked = 0;
    ctx.askTransactionDeleteHoldings = async tx => { asked++; assert.equal(tx.id, 9); return choice; };
    await ctx.deleteTransactionRow(9);
    assert.equal(asked, 1, choice);
    assert.deepEqual(sent, expected, choice);
    assert.equal(status, expectStatus);
    assert.equal(rendered, expectRender);
  }
  assert.equal(JSON.stringify(h.evaluate(ctx, 'data')), JSON.stringify({ members: ['x'] }));

  // 잔고에 반영된 적 없는 거래는 예전처럼 확인창 하나 — 잔고 질문 없음
  sent = []; asked = 0; confirmed = 0;
  ctx.askTransactionDeleteHoldings = async () => { asked++; return 'apply'; };
  await ctx.deleteTransactionRow(10);
  assert.deepEqual([asked, confirmed, sent], [0, 1, [[10, false]]]);

  // 대화상자 문구는 삭제용으로 바뀐다(수정과 같은 상자)
  const html = h.readStatic('index.html');
  assert.match(html, /id="txEditHoldingsModal"[^>]*aria-labelledby="txEditHoldingsTitle"/);
  assert.match(html, /id="txEditHoldingsTitle"/);
  assert.match(html, /id="txEditHoldingsNote"/);
  assert.equal(h.evaluate(ctx, 'TX_HOLDINGS_PROMPTS.delete.apply'), '잔고도 되돌림');

  // 거래 저장: 앞 저장이 끝나기 전의 두 번째 제출은 무시된다
  assert.equal(typeof submitHandler, 'function');
  let calls = 0, release;
  ctx.submitTradeForm = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const button = { disabled: false };
  const event = () => ({ preventDefault() {}, currentTarget: { querySelectorAll: () => [button] } });
  const first = submitHandler(event());
  assert.equal(button.disabled, true);
  await submitHandler(event());
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(button.disabled, false);
  const third = submitHandler(event());   // 끝난 뒤에는 다시 저장할 수 있다
  assert.equal(calls, 2);
  release();
  await third;
  console.log('Transaction delete: asks to revert holdings for applied trades, sends choice; trade save ignores double submit');
})().catch(err => { console.error(err); process.exit(1); });

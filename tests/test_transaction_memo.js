// 거래 메모(2026-10-16): 메모가 있는 거래만 목록 종목명 옆 아이콘(읽기 전용 툴팁, 2026-11-04), 행 편집은 메모를 다루지 않고,
// 저장 확인창은 메모가 있을 때만 메모 줄을 보인다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.equal(run('txMemoButton({id: 1, memo: null})'), '');
assert.equal(run('txMemoButton({id: 1, memo: "   "})'), '');
const btn = run('txMemoButton({id: 7, memo: "<b>실적 전</b> 분할매수"})');
assert.match(btn, /data-tx-memo-tip="&lt;b&gt;실적 전&lt;\/b&gt; 분할매수"/);   // 툴팁은 이스케이프
assert.doesNotMatch(btn, /data-tx-memo="|title=/);   // 아이콘은 편집 팝업을 열지 않고, 기본 title과 겹치지 않는다

// 목록 행: 보기 행만 아이콘, 편집 행은 메모 없음
ctx.currentPriceForTicker = () => null;
ctx.txTickerCell = tx => tx.ticker;
const tx = '{id: 7, trade_date: "2026-10-16", ticker: "AAPL", name: "Apple", side: "BUY", qty: 1, price: 100, currency: "USD", memo: "메모"}';
const view = run(`txViewRow(${tx}, null)`);
assert.equal((view.match(/data-tx-memo="7"/g) || []).length, 1);   // 편집 진입은 관리 칸 버튼뿐
assert.equal((view.match(/data-tx-memo-tip=/g) || []).length, 1);   // 종목명 아이콘은 읽기 전용 툴팁
assert.match(view, /tx-action-btn has-memo/);
// 메모 없는 거래도 관리 칸 버튼으로 새로 달 수 있다
const bare = run(`txViewRow({...${tx}, memo: null}, null)`);
assert.equal((bare.match(/data-tx-memo="7"/g) || []).length, 1);
assert.match(bare, /title="메모 추가">메모</);
assert.doesNotMatch(bare, /has-memo|tx-memo-btn/);
assert.doesNotMatch(run(`txEditRow(${tx}, null)`), /data-tx-memo|memo/i);

// 저장 확인창: 메모가 있을 때만 '메모' 줄
ctx.tradeAccountLabel = () => '계좌';
const payload = memo => `{trade_date: "2026-10-16", account_id: 1, ticker: "AAPL", name: "Apple", side: "BUY", qty: "1", price: "100", currency: "USD", apply_to_holdings: true, memo: ${JSON.stringify(memo)}}`;
assert.doesNotMatch(run(`tradeConfirmRows(${payload('')})`), />메모</);
assert.match(run(`tradeConfirmRows(${payload('목표가 120')})`), />메모<[\s\S]*목표가 120/);
console.log('transaction memo ok');

// 거래 줄 버튼 정리(2026-11-20 디자인 재검토 08): 편집만 늘 보이고 메모·숨김·삭제는 ⋯(details) 안.
{
  const beforeMenu = view.slice(0, view.indexOf('<details class="tx-more">'));
  assert.match(beforeMenu, /data-tx-edit="7"/);
  assert.doesNotMatch(beforeMenu, /data-tx-memo="7"|data-tx-hide=|data-tx-delete=/);
  const menu = view.slice(view.indexOf('<div class="tx-more-menu">'));
  for (const hook of ['data-tx-memo="7"', 'data-tx-hide="7"', 'data-tx-delete="7"']) assert.ok(menu.includes(hook), hook);
  assert.match(view, /<summary class="tx-action-btn tx-more-toggle has-memo"/);   // 메모가 있으면 ⋯에도 표시
  assert.doesNotMatch(bare, /tx-more-toggle has-memo/);
}

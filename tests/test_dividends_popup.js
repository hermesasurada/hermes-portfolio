// 배당 팝업(2026-11-26 사용자 지시): 계좌 화면의 '세부내역/배당' 탭을 없애고, 거래내역 옆 '배당' 버튼으로 팝업을 연다.
const assert = require('node:assert/strict');
const h = require('./harness');

// ── 마크업: 탭은 없고, 버튼은 거래내역 버튼 바로 오른쪽, 배당 표는 팝업 안에 있다 ──
const html = h.readStatic('index.html');
const css = h.readStatic('styles.css');
assert.doesNotMatch(html, /detail-tabs|tab-btn|data-tab=/);
assert.match(html, /id="transactionsPopupOpen"[^>]*>거래내역<\/button>\s*(<!--[^>]*-->\s*)?<button[^>]*id="dividendsPopupOpen"[^>]*>배당<\/button>/);
assert.match(html, /<dialog[^>]*id="dividendsModal"[\s\S]*?id="dividendsPopupClose"[\s\S]*?id="dividendTableWrap"[\s\S]*?id="dividendRows"[\s\S]*?<\/dialog>/);
assert.doesNotMatch(html, /id="dividendTableWrap"[^>]*class="[^"]*hidden|class="table-wrap hidden" id="dividendTableWrap"/);
// 모바일에서도 배당 버튼은 보인다(거래내역 버튼만 PC 전용)
for (const block of h.mediaBlocks(css, '(max-width: 980px)')) assert.doesNotMatch(block.text, /#dividendsPopupOpen[^{]*\{[^}]*display:\s*none/);
assert.doesNotMatch(css, /\.detail-tabs|\.tab-btn/);
// 열 순서(2026-11-26): 배당율은 종목 바로 다음, 대상은 '계좌'(이름·계좌명 두 줄). 팝업 폭은 표 폭에 맞춘다.
const heads = [...html.match(/<table class="dividend-list">[\s\S]*?<\/thead>/)[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
assert.deepEqual(heads.slice(0, 5), ['지급일자', '계좌', '종목', '배당율', '주당배당금']);
assert.equal(heads.length, 15);
assert.match(css, /\.watch-modal\.dividends-modal \{[^}]*width: fit-content;/);
assert.match(css, /\.dividends-modal \.dividend-list \{ width: 0; min-width: 0; \}/);

// ── 동작 ──
const ctx = h.loadScripts(h.createContext());
const els = new Map();
const el = id => els.get(id) || els.set(id, h.element({id})).get(id);
const modal = Object.assign(h.element({id: 'dividendsModal'}), {open: false, showModal() { this.open = true; }, close() { this.open = false; }});
els.set('dividendsModal', modal);
ctx.document.getElementById = el;
let loads = 0;
ctx.apiFetchDividends = async () => { loads += 1; return {rows: [{ticker: 'QLD', name: 'QLD', pay_date: '2026-12-30', net_krw: 1000, currency: 'USD', target: 'Ray', account_id: '2', dividend_yield: 0.5}]}; };
h.evaluate(ctx, "data = {members: [{name: 'Ray', accounts: [{id: '2', name: '연금저축'}]}]}");
ctx.visibleAccounts = () => [{id: 'a1'}];
ctx.schedulePcFrozenColumns = () => {};
ctx.scheduleTableViewportRows = () => {};

(async () => {
  // 열면 새로 받아 그리고, 건수는 팝업 머리에 쓴다(계좌 표의 행 수는 건드리지 않는다)
  el('rowCountValue').textContent = '37';
  ctx.openDividendsPopup();
  assert.ok(modal.open);
  await h.evaluate(ctx, 'dividendInFlight');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.match(el('dividendRows').innerHTML, /data-chart-ticker="QLD"/);
  assert.equal(el('dividendsCount').textContent, '1건');
  assert.equal(el('rowCountValue').textContent, '37');
  // 계좌 칸: 이름 + 계좌명(account_id로 찾는다), 배당율은 종목 다음 칸
  const dataRow = el('dividendRows').innerHTML.split('<tr').find(tr => tr.includes('data-chart-ticker="QLD"'));
  const cells = dataRow.match(/<td[\s\S]*?<\/td>/g);
  assert.match(cells[1], /dividend-owner">Ray<[\s\S]*dividend-account">연금저축</);
  assert.match(cells[3], /class="dividend-yield"/);
  // 다시 열면 다시 받는다(거래를 고친 뒤 바로 반영)
  ctx.closeDividendsPopup();
  assert.ok(!modal.open);
  ctx.openDividendsPopup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 2);

  // 차트·관심목록으로 가면 버튼을 숨기고 열린 팝업은 닫는다
  ctx.syncDividendsPopup(true);
  assert.ok(el('dividendsPopupOpen').classList.contains('hidden'));
  assert.ok(!modal.open);
  ctx.syncDividendsPopup(false);
  assert.ok(!el('dividendsPopupOpen').classList.contains('hidden'));

  // 정렬은 표마다 따로: 배당 표 머리글은 sortState.dividend, 계좌 표는 sortState.detail
  const inDividend = {closest: sel => (sel === '#dividendTableWrap' ? {} : null)};
  const inDetail = {closest: () => null};
  assert.equal(ctx.sortTableOf(inDividend), 'dividend');
  assert.equal(ctx.sortTableOf(inDetail), 'detail');
  h.evaluate(ctx, "sortState.detail = {key: 'value_krw', dir: -1}; sortState.dividend = {key: 'pay_date', dir: 1};");
  ctx.setCurrentSort('net_krw', 'dividend');
  assert.equal(h.evaluate(ctx, 'sortState.dividend.key'), 'net_krw');
  assert.equal(h.evaluate(ctx, 'sortState.detail.key'), 'value_krw');
  ctx.setCurrentSort('qty');
  assert.equal(h.evaluate(ctx, 'sortState.detail.key'), 'qty');
  assert.equal(h.evaluate(ctx, 'sortState.dividend.key'), 'net_krw');
  console.log('dividends popup ok');
})().catch(err => { console.error(err); process.exit(1); });

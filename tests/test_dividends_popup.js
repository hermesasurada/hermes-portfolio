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
// 항목 구분: 계좌 칸 한 줄(block 금지), 실지급액 강조, 열 묶음 세로선
assert.doesNotMatch(css, /\.dividend-owner, \.dividend-account \{ display: block/);
assert.match(css, /td\.net-krw \{\s*font-weight: 700;/);
assert.match(css, /:is\(:nth-child\(4\), :nth-child\(7\), :nth-child\(12\), :nth-child\(13\)\) \{\s*border-left: 1px solid var\(--line\);/);

// 모바일 고정 영역(2026-11-26): 지급일자·종목만 고정, 계좌는 흘려보낸다. 종목 칸도 좁힌다.
assert.match(h.readStatic('app-holdings.js'), /\["#dividendTableWrap table", narrow \? \[0, 2\] : \[0, 1, 2\]\]/);
assert.ok(h.mediaBlocks(css, '(max-width: 980px)').some(block => /\.dividend-list td:nth-child\(3\) \{\s*width: 96px;/.test(block.text)));

// 항목 줄무늬: 같은 회차(대상별 줄)는 같은 바탕, 다음 회차는 번갈아, 달이 바뀌면 처음부터
{
  const c = h.loadScripts(h.createContext());
  const body = h.element();
  const others = new Map();
  c.document.getElementById = id => (id === 'dividendRows' ? body : (others.get(id) || others.set(id, h.element()).get(id)));
  c.todayLocal = () => '2026-11-26';
  c.schedulePcFrozenColumns = () => {};
  const r = (ticker, pay, target) => ({ticker, name: ticker, pay_date: pay, ex_date: pay, amount: 1, qty: 1, gross: 1, net: 1, net_krw: 1, currency: 'USD', target});
  c.__rows = [r('A', '2026-12-01', 'Ray'), r('A', '2026-12-01', 'Claire'), r('B', '2026-12-02', 'Ray'), r('C', '2026-12-03', 'Ray'), r('D', '2027-01-05', 'Ray')];
  h.evaluate(c, "dividendLoadKey = dividendSelectionKey(); dividendData = {rows: __rows}; sortState.dividend = {key: 'pay_date', dir: 1}; dividendMonthOverrides = new Map([['2027-01', false]]);");
  c.renderDividendTable();
  const bands = body.innerHTML.split('<tr').filter(tr => /dividend-(paid|upcoming)-row/.test(tr))
    .map(tr => (tr.match(/<td[^>]*>[\s\S]*?data-chart-ticker="(\w)"/)?.[1] || '+') + (tr.includes('dividend-band') ? '*' : ''));
  assert.deepEqual(bands, ['A', '+', 'B*', 'C', 'D']);
}

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
  // 계좌 데이터가 오기 전에 누르면 불러오기를 미룬다 — 키를 잡아 두면 팝업이 끝까지 빈 채로 남았다
  h.evaluate(ctx, "__saved = data; data = null; dividendLoadKey = ''; dividendData = null;");
  ctx.loadDividendsForSelection();
  assert.equal(loads, 0);
  assert.equal(h.evaluate(ctx, 'dividendLoadKey'), '');
  h.evaluate(ctx, "data = __saved;");

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
  assert.match(cells[1], /dividend-owner">Ray<\/span><span class="dividend-account">연금저축/, '계좌는 한 줄');
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

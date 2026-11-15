// PC 전용(2026-11-15): 하단 거래내역을 팝업으로, 본문 폭 기본 ↔ 전체(사이드바 폭 유지).
const assert = require('node:assert/strict');
const h = require('./harness');

const html = h.readStatic('index.html');
const css = h.readStatic('styles.css');
// 거래내역 버튼은 통화 버튼 바로 오른쪽, 팝업 자리와 닫기 버튼이 있다
assert.match(html, /id="currencySegments"[^>]*><\/div>\s*<button[^>]*id="transactionsPopupOpen"/);
assert.match(html, /<dialog[^>]*id="transactionsModal"[\s\S]*?id="transactionsModalSlot"/);
assert.match(html, /id="transactionsPopupClose"/);
assert.match(html, /id="layoutWidthToggle"[^>]*aria-pressed="false"/);
// 모바일에서는 두 버튼 모두 숨기고, 전체 폭은 PC에서만 최대 폭을 푼다(사이드바 그리드는 그대로)
assert.match(css, /@media \(max-width: 980px\) \{\s*#transactionsPopupOpen,\s*#layoutWidthToggle \{ display: none; \}/);
assert.match(css, /@media \(min-width: 981px\) \{\s*html\.layout-wide main,\s*html\.layout-wide \.bar \{ max-width: none; \}/);
assert.doesNotMatch(css, /layout-wide[^{]*\.layout\s*\{/, '사이드바 열 폭은 바꾸지 않는다');
// ResizeObserver 알림 지연은 오류 띠로 띄우지 않는다
assert.match(html, /ResizeObserver loop/);

function setup(pc) {
  const ctx = h.createContext();
  ctx.window.matchMedia = q => ({ matches: q.includes('min-width: 981px') ? pc : false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  ctx.matchMedia = ctx.window.matchMedia;
  h.loadScripts(ctx);
  return ctx;
}

// 패널 이동: PC면 팝업 자리로, 모바일이면 원래 자리로
function fakeTree(ctx) {
  const classes = cls => { const s = new Set(cls); return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, on) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c); } }; };
  const home = { children: [], appendChild(n) { this.children.push(n); n.parentNode = this; }, insertBefore(n) { this.children.push(n); n.parentNode = this; } };
  const slot = { children: [], appendChild(n) { home.children = home.children.filter(c => c !== n); this.children.push(n); n.parentNode = this; } };
  const panel = { classList: classes(['transaction-panel', 'collapsed']), parentNode: home, nextSibling: null };
  home.children.push(panel);
  const button = { classList: classes([]) };
  const modal = { open: false, close() { this.open = false; }, showModal() { this.open = true; } };
  ctx.document.querySelector = sel => (sel === '.transaction-panel' ? panel : null);
  const ids = { transactionsModalSlot: slot, transactionsModal: modal, transactionsPopupOpen: button };
  const orig = ctx.document.getElementById.bind(ctx.document);
  ctx.document.getElementById = id => ids[id] || orig(id);
  return { home, slot, panel, button, modal };
}

const pc = setup(true);
const t = fakeTree(pc);
pc.placeTransactionPanel();
assert.equal(t.panel.parentNode, t.slot);
assert.ok(t.panel.classList.contains('in-popup'));
assert.ok(!t.panel.classList.contains('hidden'));
// 열면 펼치고 거래내역을 부른다
let loaded = 0;
pc.loadTransactions = async () => { loaded++; };
pc.openTransactionsPopup();
assert.ok(t.modal.open);
assert.equal(h.evaluate(pc, 'transactionsExpanded'), true);
assert.equal(loaded, 1);
// 관심목록·차트로 가면 버튼을 숨기고 열린 팝업은 닫는다
h.evaluate(pc, 'chartTicker = "NVDA"');
pc.syncTransactionPanel();
assert.ok(t.button.classList.contains('hidden'));
assert.ok(!t.modal.open);
assert.ok(!t.panel.classList.contains('hidden'), '팝업 안 패널 자체는 숨기지 않는다');
h.evaluate(pc, 'chartTicker = null');
pc.syncTransactionPanel();
assert.ok(!t.button.classList.contains('hidden'));

// 모바일: 패널은 원래 자리, 팝업 모드 아님
const mobile = setup(false);
const m = fakeTree(mobile);
mobile.placeTransactionPanel();
assert.equal(m.panel.parentNode, m.home);
assert.ok(!m.panel.classList.contains('in-popup'));
mobile.openTransactionsPopup();
assert.ok(!m.modal.open, '모바일에서는 팝업을 열지 않는다');

// 본문 폭 전환: html 클래스·버튼 상태·저장
const w = setup(true);
const store = new Map();
w.storageGet = k => store.get(k) ?? null;
w.storageSet = (k, v) => store.set(k, v);
const btn = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, title: '' };
const orig = w.document.getElementById.bind(w.document);
w.document.getElementById = id => (id === 'layoutWidthToggle' ? btn : orig(id));
const root = w.document.documentElement;
const rc = new Set();
root.classList = { toggle: (c, on) => { on ? rc.add(c) : rc.delete(c); }, contains: c => rc.has(c) };
w.render = () => {};
w.Event = function Event(type) { this.type = type; };
w.window.dispatchEvent = () => true;
w.toggleLayoutWidth();
assert.ok(rc.has('layout-wide'));
assert.equal(btn.attrs['aria-pressed'], 'true');
assert.equal(store.get('portfolio.layout.wide'), '1');
w.toggleLayoutWidth();
assert.ok(!rc.has('layout-wide'));
assert.equal(store.get('portfolio.layout.wide'), '0');
console.log('PC transactions popup and layout width toggle ok');

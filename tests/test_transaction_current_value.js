// 거래내역 표의 현재가치 칸(2026-11-24 사용자 지시): 현재대비 다음, 관리 앞. 값 = 거래 수량 × 현재가.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

const html = fs.readFileSync(path.join(__dirname, '..', 'portfolio_static', 'index.html'), 'utf8');
const head = html.slice(html.indexOf('<table class="tx-list">'), html.indexOf('<tbody id="transactions">'));
const heads = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
assert.deepEqual(heads.slice(-3), ['현재대비', '현재가치', '관리']);

ctx.txTickerCell = tx => tx.ticker;
const cells = row => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
const tx = '{id: 3, trade_date: "2026-10-16", ticker: "AAPL", name: "Apple", side: "BUY", qty: 4, price: 100, currency: "USD"}';

ctx.currentPriceForTicker = () => 125;
const view = cells(run(`txViewRow(${tx}, null)`));
assert.equal(view.length, heads.length);           // 머리글과 칸 수가 같다
assert.equal(view[8], run('money(400, "USD")').replace(/<[^>]+>/g, '').trim());    // 금액 = 수량 × 거래 단가
assert.equal(view[11], run('money(500, "USD")').replace(/<[^>]+>/g, '').trim());   // 현재가치 = 수량 × 현재가
assert.match(view[10], /25/);                       // 현재대비 +25%

// 매도 줄도 같은 계산, 현재가를 모르면 빈 표시
const sell = cells(run(`txViewRow({...${tx}, side: "SELL"}, null)`));
assert.equal(sell[11], view[11]);
ctx.currentPriceForTicker = () => null;
assert.equal(cells(run(`txViewRow(${tx}, null)`))[11], '-');

// 편집 줄·빈 안내 줄도 칸 수가 맞는다
assert.equal(cells(run(`txEditRow(${tx}, null)`)).length, heads.length);
const src = fs.readFileSync(path.join(__dirname, '..', 'portfolio_static', 'app-transactions.js'), 'utf8');
assert.match(src, new RegExp(`<td colspan="${heads.length}" class="flat">`));
console.log('transaction current value ok');

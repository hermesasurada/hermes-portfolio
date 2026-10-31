// 계좌표 '평단 배당율(추정)' — 배당율 × 현재가 ÷ 평단가, 여러 계좌 합산은 수량 가중 평단가.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');
const read = file => fs.readFileSync(path.join(__dirname, '../portfolio_static', file), 'utf8');
const ctx = h.loadScripts(h.createContext());
const { yieldOnCost, yieldOnCostMarkup } = ctx;

assert.equal(yieldOnCost(2, 100, 50 * 10, 10), 4);               // 현재가 100, 평단 50 → 배당율 두 배
assert.equal(yieldOnCost(0, 100, 500, 10), 0);
assert.equal(yieldOnCost(null, 100, 500, 10), null);
assert.equal(yieldOnCost(2, null, 500, 10), null);
assert.equal(yieldOnCost(2, 100, null, 10), null);
assert.equal(yieldOnCost(2, 100, 0, 10), null);
assert.equal(yieldOnCost(2, 100, 500, null), null);
// 두 계좌 합산: 10주@50 + 30주@90 → 평단 80
assert.equal(yieldOnCost(2, 100, 10 * 50 + 30 * 90, 40), 2.5);

const html = yieldOnCostMarkup({ yield_on_cost: 4, dividend_yield: 2, cost_basis: 500, qty: 10, currency: 'USD' });
assert.match(html, />4%</);
assert.match(html, /평단가 \$50 기준/);
assert.equal(yieldOnCostMarkup({ yield_on_cost: null }), '-');

// 계좌 합산이 원가를 더한다(첫 계좌 평단을 그대로 쓰지 않는다).
const holdings = read('app-holdings.js');
assert.match(holdings, /cost_basis: Number\(row\.avg_price\) > 0 && Number\(row\.qty\) > 0 \? Number\(row\.avg_price\) \* Number\(row\.qty\) : null/);
assert.match(holdings, /if \(r\.cost_basis != null\) g\.cost_basis = \(g\.cost_basis \|\| 0\) \+ r\.cost_basis;/);
assert.match(read('app.js'), /"yield_on_cost"/);
console.log('Yield on cost uses current yield x price over weighted average cost.');

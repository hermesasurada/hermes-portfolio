const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = {};
const ctx = vm.createContext({window:{}, document:{getElementById: id => elements[id] ||= {value:''}},
  selectedTrade:{ticker:'AAA'}, findTradeHolding:()=>null,
  findTickerMeta: ticker => ticker === 'AAA' ? {name:'Alpha', current_price:12.34, currency:'USD'} : null,
  usExtendedEnabled:()=>false,
});
vm.runInContext(fs.readFileSync('portfolio_static/app-transactions.js','utf8'), ctx);
ctx.document.getElementById('tradeTicker').value = 'AAA';
ctx.document.getElementById('tradePrice').value = '999';
ctx.applyTradeHoldingDefaults(true, true);
assert.equal(elements.tradePrice.value, '12.34');
elements.tradePrice.value = '11';
ctx.applyTradeHoldingDefaults(true); // Submit/name resolution must preserve the entered execution price.
assert.equal(elements.tradePrice.value, '11');
elements.tradeTicker.value = 'UNKNOWN';
ctx.applyTradeHoldingDefaults(true, true);
assert.equal(elements.tradePrice.value, '');
elements.tradeTicker.value = 'AAA';
ctx.selectedTrade.ticker = 'UNKNOWN';
ctx.previewTradeTickerDefaults();
assert.equal(elements.tradePrice.value, '12.34');
elements.tradePrice.value = '11';
ctx.previewTradeTickerDefaults();
assert.equal(elements.tradePrice.value, '11');
async function test() {
  ctx.resolveTradeName = () => {};
  let resolve;
  ctx.apiFetchPortfolio = () => new Promise(r => {resolve = r;});
  elements.tradeTicker.value = 'BBB';
  const task = ctx.updateTradeTickerDefaults();
  elements.tradeTicker.value = 'AAA';
  elements.tradePrice.value = '17';
  resolve({tickers:[{ticker:'BBB',current_price:99,currency:'USD'}]});
  await task;
  assert.equal(elements.tradePrice.value, '17');
  elements.tradeTicker.value = 'BBB';
  const next = ctx.updateTradeTickerDefaults();
  resolve({tickers:[{ticker:'BBB',current_price:99,currency:'USD'}]});
  await next;
  assert.equal(elements.tradePrice.value, '99.00');
  console.log('Trade ticker changes refresh price; manual and stale-response guards OK');
}
test().catch(e => {console.error(e); process.exitCode=1;});

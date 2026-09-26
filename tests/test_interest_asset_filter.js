const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
ctx.render = () => {};
ctx.renderInterestWatchlists = () => {};
h.evaluate(ctx, 'data = {fx: {USD: 1300}}');
ctx.findTickerMeta = () => null;
ctx.currencyFilterValue = () => 'all';
ctx.interestHeldOnlyEnabled = () => false;
const payload = {groups: [{id: 7, name: '미국', items: [
  {ticker: 'GLD', name: '금', category: 'us', currency: 'USD', asset_class: 'etf'},
  {ticker: 'MSFT', name: '마이크로소프트', category: 'us', currency: 'USD', asset_class: 'stock'},
]}], group_aliases: {'6': 7}};
ctx.localStorage.setItem('portfolio.sidebar.interestGroupId', '6');
ctx.applyInterestWatchlistPayload(payload);
assert.equal(h.evaluate(ctx, 'activeInterestGroupId'), 7);
assert.equal(ctx.localStorage.getItem('portfolio.sidebar.interestGroupId'), '7');
assert.equal(ctx.interestBaseRows().length, 2);
ctx.cycleInterestAssetType();
assert.equal(ctx.document.getElementById('interestAssetTypeToggle').textContent, 'ETF');
assert.deepEqual(h.plain(ctx.interestBaseRows()).map(r => r.ticker), ['GLD']);
ctx.cycleInterestAssetType();
assert.equal(ctx.document.getElementById('interestAssetTypeToggle').textContent, '개별주');
assert.deepEqual(h.plain(ctx.interestBaseRows()).map(r => r.ticker), ['MSFT']);
ctx.initInterestAssetTypeControl();
assert.equal(h.evaluate(ctx, 'interestAssetType'), 'stock');
ctx.cycleInterestAssetType();
assert.equal(ctx.interestBaseRows().length, 2);
ctx.interestHeldOnlyEnabled = () => true;
ctx.heldTickerSet = () => new Set(['GLD']);
assert.deepEqual(h.plain(ctx.interestBaseRows()).map(r => r.ticker), ['GLD']);
ctx.interestHeldOnlyEnabled = () => false;
ctx.currencyFilterValue = () => 'JPY';
assert.equal(ctx.interestBaseRows().length, 0);
ctx.currencyFilterValue = () => 'all';
ctx.cycleInterestAssetType();
for (const category of ['index', 'fx', 'crypto']) {
  ctx.applyInterestWatchlistPayload({groups: [{id: 7, name: category, items: [{ticker: 'TEST', category}]}]});
  assert.equal(ctx.interestAssetFilterAvailable(), false);
  assert.equal(ctx.interestBaseRows().length, 1);
}
ctx.localStorage.setItem('portfolio.detail.interestAssetType', 'invalid');
ctx.initInterestAssetTypeControl();
assert.equal(h.evaluate(ctx, 'interestAssetType'), 'all');
assert.match(h.readStatic('index.html'), /id="interestAssetTypeToggle"/);
console.log('Watchlist asset cycle: ETF/stock filtering, renamed ETFs, other filters, persistence, special groups and migrated selection OK');

// 종목 검색 팝업의 빈 상태(2026-11-20 디자인 재검토 10): 최근 본 종목 + 찐관심.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.plain(h.evaluate(ctx, code));

assert.deepEqual(run('recentTickers()'), []);
for (const ticker of ['nvda', 'TSLA', 'NVDA', ' aapl ']) h.evaluate(ctx, `rememberRecentTicker(${JSON.stringify(ticker)})`);
assert.deepEqual(run('recentTickers()'), ['AAPL', 'NVDA', 'TSLA']);   // 다시 보면 맨 앞으로, 대문자로 하나만
for (let i = 0; i < 12; i += 1) h.evaluate(ctx, `rememberRecentTicker("T${i}")`);
assert.equal(run('recentTickers().length'), 8);
assert.equal(run('recentTickers()[0]'), 'T11');

// 찐관심은 최근 본 종목과 겹치지 않게, 이름은 종목 목록에서.
h.evaluate(ctx, `storageSet(RECENT_TICKERS_KEY, JSON.stringify(["NVDA"]));
  tickerSearchDirectory = [{ticker: "NVDA", name: "NVIDIA"}, {ticker: "MSFT", name: "Microsoft"}];
  interestWatchlists = [{id: 1, name: "찐관심", favorite: true, items: [{ticker: "NVDA"}, {ticker: "MSFT"}]}];`);
assert.deepEqual(run('tickerSearchSuggestions()'), [
  { label: '최근 본 종목', items: [{ ticker: 'NVDA', name: 'NVIDIA' }] },
  { label: '찐관심', items: [{ ticker: 'MSFT', name: 'Microsoft' }] },
]);
assert.match(h.readStatic('app-charts.js'), /rememberRecentTicker\(cleanTicker\)/);
console.log('ticker search suggestions ok');

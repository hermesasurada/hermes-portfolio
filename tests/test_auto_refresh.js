// Virtual timers and deferred fetches: no live requests or wall-clock waits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../portfolio_static', name), 'utf8');
const source = read('app.js');
const holdings = read('app-holdings.js');
assert.doesNotMatch(source + holdings, /usPriceTimer|scheduleUsPriceRefresh/);
assert.equal((source.match(/setInterval\(/g) || []).length, 1);
assert.doesNotMatch(holdings, /setInterval\(/);
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const timers = new Map();
let nextId = 0;
let mode = 'off';
let calls = 0;
let merges = 0;
let renders = 0;
let resolveFetch;
let defer = false;
const context = vm.createContext({
  autoRefreshTimer: null, loadInFlight: null, transactionsExpanded: false,
  setInterval: (fn, ms) => { const id = nextId++; timers.set(id, {fn, ms}); return id; },
  clearInterval: id => timers.delete(id), autoRefreshMode: () => mode,
  apiFetchPortfolio: () => { calls++; return defer ? new Promise(r => { resolveFetch = r; }) : Promise.resolve({}); },
  usExtendedEnabled: () => false, portfolioRefreshTickers: () => [],
  mergePortfolioRefresh: () => merges++, renderPortfolioRefresh: () => renders++,
  showTradeStatus: () => assert.fail('unexpected error'),
});
vm.runInContext(extract('async function refreshPortfolio(', '\nasync function load()'), context);
vm.runInContext(extract('function scheduleAutoRefresh()', '\nfunction initAutoRefreshControls()'), context);
const run = code => vm.runInContext(code, context);
const flush = () => new Promise(r => setImmediate(r));
(async () => {
  run('scheduleAutoRefresh()');
  assert.equal(timers.size, 0);
  mode = '1'; run('scheduleAutoRefresh()');
  assert.equal(timers.size, 1);
  const old = [...timers.values()][0];
  assert.equal(old.ms, 60000);
  old.fn(); await flush();
  assert.equal(calls, 1); assert.equal(renders, 1);
  mode = '5'; run('scheduleAutoRefresh()');
  assert.equal(timers.size, 1); // also clears a timer whose id is zero
  assert.equal([...timers.values()][0].ms, 300000);
  old.fn(); await flush();
  assert.equal(calls, 1); // queued callback from old timer cannot fetch
  defer = true;
  [...timers.values()][0].fn();
  assert.equal(calls, 2);
  mode = 'off'; run('scheduleAutoRefresh()');
  assert.equal(timers.size, 0);
  resolveFetch({}); await flush();
  assert.equal(merges, 1); assert.equal(renders, 1); // late response discarded
  assert.equal(run('loadInFlight'), null);
  defer = false;
  await run('refreshPortfolio()'); // explicit user request still works while OFF
  assert.equal(calls, 3); assert.equal(renders, 2);
  mode = '1'; run('scheduleAutoRefresh()');
  run('scheduleAutoRefresh()');
  assert.equal(timers.size, 1); // repeated schedule doesn't accumulate timers
  [...timers.values()][0].fn(); await flush();
  assert.equal(calls, 4); assert.equal(renders, 3);
  mode = 'off'; run('scheduleAutoRefresh()');
  assert.equal(timers.size, 0);
  console.log('auto refresh: OFF, 1m/5m, single timer, stale callbacks/responses and explicit refresh passed');
})().catch(err => { console.error(err); process.exitCode = 1; });

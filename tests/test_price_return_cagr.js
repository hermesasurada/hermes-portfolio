const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(`portfolio_static/${name}`, 'utf8');
const ctx = vm.createContext({window: {}, data: {fx: {USD: 1300}}});
vm.runInContext(read('format.js'), ctx);
for (const years of [3, 5, 10]) {
  for (const rate of [-50, 0, 10, 25]) {
    const cumulative = (Math.pow(1 + rate / 100, years) - 1) * 100;
    assert.ok(Math.abs(ctx.priceReturnCagr(cumulative, years) - rate) < 1e-8);
  }
}
for (const value of [undefined, null, '', true, NaN, Infinity, -101]) {
  assert.equal(ctx.priceReturnCagr(value, 3), null);
}
assert.equal(ctx.priceReturnCagr(-100, 5), -100);
const performance = {one_week: 2, one_month: 4, one_year: 30,
  three_year: 33.1, five_year: 61.051, ten_year: null};
const before = JSON.stringify(performance);
ctx.statsData = {TEST: {performance, risk_reward_score: 7}};
const tabs = read('app-tabs.js');
vm.runInContext(tabs.slice(0, tabs.indexOf('function hasMissingTechnicalStats')), ctx);
const row = ctx.statsRows([{ticker: 'TEST'}])[0];
assert.ok(Math.abs(row.perf_3y - 10) < 1e-8);
assert.ok(Math.abs(row.perf_5y - 10) < 1e-8);
assert.equal(row.perf_10y, null);
assert.equal(row.perf_1w, 2);
assert.equal(row.perf_1m, 4);
assert.equal(row.perf_1y, 30);
assert.equal(row.risk_reward_score, 7);
assert.equal(JSON.stringify(performance), before, 'API cumulative data must not be mutated');
vm.runInContext(read('app-chart-metrics.js'), ctx);
assert.equal(ctx.chartStatPercent(ctx.priceReturnCagr(null, 10), 1), '-');
assert.match(ctx.chartStatPercent(row.perf_3y, 1), /10\.0%/);
for (const file of ['index.html', 'app-interest-columns.js', 'app-chart-metrics.js']) {
  assert.match(read(file), /CAGR/);
}
console.log('Price CAGR: annualization, missing values, short periods and source preservation passed.');

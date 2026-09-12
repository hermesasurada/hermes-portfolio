const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const candleSource = fs.readFileSync("portfolio_static/app-line-chart.js", "utf8");
const candleBody = candleSource.match(/<rect class="chart-candle-body"[^>]*>/)?.[0];
assert.ok(candleBody);
assert.doesNotMatch(candleBody, /\b(?:rx|ry)=/, "Candle bodies must have square corners");
assert.match(candleBody, /x - candleBodyWidth \/ 2/);
assert.match(candleBody, /width="\$\{candleBodyWidth\.toFixed/);
const bodyWidthExpression = candleSource.match(/const candleBodyWidth = ([^;]+);/)[1];
for (const pxToView of [0.75, 1, 2.5, 3]) {
  const roomy = vm.runInNewContext(bodyWidthExpression, {candleWidth: 8, candleSpacing: 20, pxToView});
  assert.equal(roomy, 8, 'Already separated candles retain their original width');
  const bodyWidth = vm.runInNewContext(bodyWidthExpression, {candleWidth: 8, candleSpacing: 3 * pxToView, pxToView});
  assert.ok((3 * pxToView - bodyWidth) / pxToView - .65 >= .2 - 1e-9);
}
assert.ok(vm.runInNewContext(bodyWidthExpression, {candleWidth: 0.75, candleSpacing: .5, pxToView: 3}) > 0);
assert.equal(vm.runInNewContext(bodyWidthExpression, {candleWidth: 8, candleSpacing: Infinity, pxToView: 3}), 8);

const context = { window: {}, chartInterval: "day" };
vm.createContext(context);
vm.runInContext(fs.readFileSync("portfolio_static/app-chart-scale.js", "utf8"), context);

const weekly = context.aggregateChartPoints(
  [
    { date: "2026-08-03", open: 100, high: 108, low: 97, close: 105 },
    { date: "2026-08-04", open: 105, high: 112, low: 103, close: 109 },
    { date: "2026-08-05", close: 111, live: true },
  ],
  "week",
);

assert.equal(weekly.length, 1);
assert.equal(weekly[0].open, 100);
assert.equal(weekly[0].high, 112);
assert.equal(weekly[0].low, 97);
assert.equal(weekly[0].candle_close, 109);
assert.equal(weekly[0].close, 111);

const extended = context.aggregateChartPoints(
  [{ date: "2026-08-06", open: 100, high: 106, low: 98, close: 108, candle_close: 104, live: true }],
  "day",
);
assert.equal(context.chartCandleClose(extended[0]), 104);
assert.equal(extended[0].close, 108);

console.log("chart OHLC aggregation ok");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

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

// 차트 기간 '1W'(2026-11-24 사용자 지시): 최근 7일만 남기고, 세로 격자는 거래일마다 한 줄,
// 이력이 며칠뿐인 신규 상장 종목에서도 고를 수 있다.
const assert = require('node:assert/strict');
const vm = require('node:vm');

const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => vm.runInContext(code, ctx);

// 기간 목록 맨 앞, 1M보다 먼저.
assert.deepEqual(JSON.parse(run('JSON.stringify(chartRanges.slice(0, 2).map(range => range.key))')), ['1w', '1m']);

// 평일만 있는 일봉 60개(2026-09-01 ~), 마지막 날은 화요일 2026-11-24 직전 거래일까지.
const points = [];
for (let d = new Date(2026, 8, 1); points.length < 60; d.setDate(d.getDate() + 1)) {
  if (d.getDay() === 0 || d.getDay() === 6) continue;
  points.push({ date: run('chartLocalDateText')(d.getTime()), close: 100 + points.length });
}
ctx.testPoints = points;
const week = JSON.parse(run('JSON.stringify(filterChartPoints(testPoints, "1w"))'));
const last = points[points.length - 1].date;
assert.equal(week[week.length - 1].date, last);
assert.equal(week.length, 6, '7일 전 같은 요일부터 마지막 날까지 거래일 6개');
const spanDays = (new Date(`${last}T00:00:00`) - new Date(`${week[0].date}T00:00:00`)) / 86400000;
assert.equal(spanDays, 7);

// 세로 격자: 단위는 day, 거래일마다 한 줄이고 라벨은 그 거래일 날짜(주말로 밀리지 않는다).
ctx.weekPoints = week;
const grid = JSON.parse(run('JSON.stringify(indexedChartVerticalGrid(weekPoints, index => index * 10, "1w"))'));
assert.equal(grid.unit, 'day');
assert.deepEqual(grid.ticks.map(tick => tick.date), week.map(point => point.date));
assert.deepEqual(grid.ticks.map(tick => tick.x), week.map((_, index) => index * 10));
const firstTick = new Date(grid.ticks[0].time);
assert.equal(run('chartGridLabel')(grid.ticks[0].time, 'day'), `${firstTick.getMonth() + 1}/${firstTick.getDate()}`);

// 시간축 차트(성과·비교)는 달력 날짜마다 한 줄.
const from = new Date(2026, 10, 17).getTime();
const to = new Date(2026, 10, 24).getTime();
const calendar = JSON.parse(run('JSON.stringify')(run('verticalDateGrid')(from, to, '1w')));
assert.equal(calendar.unit, 'day');
assert.equal(calendar.lines.length, 8);
// 기존 단위는 그대로.
assert.equal(run('chartGridUnit')('1m'), 'week');
assert.equal(run('chartGridUnit')('1y'), 'month');
assert.equal(run('chartGridUnit')('5y'), 'quarter');

// 이력이 3일뿐이어도 1W는 고를 수 있고(1M은 막힌다), 일봉만 허용된다.
const extent = { start: to - 3 * 86400000, end: to, startDate: new Date(to - 3 * 86400000), endDate: new Date(to), months: 0.1 };
ctx.shortExtent = extent;
assert.equal(run('chartRangeUnavailable(chartRanges.find(range => range.key === "1w"), shortExtent)'), false);
assert.equal(run('chartRangeUnavailable(chartRanges.find(range => range.key === "1m"), shortExtent)'), true);
run('chartRange = "1w"');
assert.deepEqual(JSON.parse(run('JSON.stringify(allowedChartIntervals())')), ['day']);
console.log('chart range 1W: filter, day grid, availability and interval ok');

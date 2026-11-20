// 개별종목 지표판 묶음 제목(2026-11-20 디자인 재검토 03): 묶음이 바뀌는 자리에 제목 줄, 제목이 열 끝에 홀로 남지 않게 나눈다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());

const item = () => ({ item: [] });
const head = name => ({ head: name });
const shape = (items, columns) => {
  const result = ctx.splitStatColumns(items, columns);
  return { size: result.size, lengths: h.plain(result.columns.map(column => column.length)) };
};

// 딱 맞게 나뉘면 그대로.
assert.deepEqual(shape([head('a'), item(), item(), head('b'), item(), item()], 2), { size: 3, lengths: [3, 3] });
// 제목이 첫 열의 마지막 칸에 오면 그 칸을 비우고 다음 열로 넘긴다.
assert.deepEqual(shape([head('a'), item(), item(), head('b'), item(), item(), item()], 2), { size: 4, lengths: [3, 4] });
// 어떤 열도 제목으로 끝나지 않는다.
const many = [];
[5, 5, 9, 7, 6, 9, 11].forEach((count, index) => { many.push(head(`g${index}`)); for (let i = 0; i < count; i += 1) many.push(item()); });
for (const columns of [2, 4]) {
  const result = ctx.splitStatColumns(many, columns);
  assert.equal(result.columns.length, columns);
  assert.equal(result.columns.flat().length, many.length);
  result.columns.forEach(column => {
    assert.ok(column.length <= result.size);
    if (column.length) assert.ok(!column[column.length - 1].head, '열이 제목으로 끝나면 안 된다');
  });
}
assert.deepEqual(shape(many, 4), { size: 15, lengths: [15, 15, 15, 14] });
assert.deepEqual(shape(many, 2), { size: 30, lengths: [30, 29] });

// 묶음 일곱 개, 지표 52개. 순서는 묶음끼리 이어진다.
const rows = h.plain(ctx.chartStatMetricRows({ ticker: 'TEST', currency: 'USD' }).map(row => row[0]));
assert.equal(rows.length, 52);
const groups = rows.filter((name, index) => index === 0 || rows[index - 1] !== name);
assert.deepEqual(groups, ['밸류에이션', '배당', '수익성·성장', '재무·수급', '기술 지표', '기간 수익률', '추세·위험']);

const css = h.readStatic('styles.css');
assert.doesNotMatch(css, /#chartStats \.cstat-row:nth-(last-)?child/, '끝 칸은 클래스(pc-col-end·pc-row-end)로 가린다');
assert.match(css, /\.cstat-row\.cstat-head \{/);
console.log('chart stat groups ok');

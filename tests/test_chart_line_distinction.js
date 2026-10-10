// 일목 전환·기준선은 계단선, 선 끝 이름표는 겹치지 않게 밀어 둔다(2026-10-10).
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

// 계단선: 값이 다음 봉까지 수평 유지 후 그 봉에서 수직 이동, 결측이면 끊는다
ctx.__pts = [{k: 10}, {k: 10}, {k: 12}, {k: null}, {k: 5}, {k: 6}];
const paths = run('chartStepSeriesPaths(__pts, "k", i => i * 10, v => 100 - v)');
assert.equal(paths.length, 2);
assert.equal(paths[0], 'M0.00,90.00 H10.00 V90.00 H20.00 V88.00');
assert.equal(paths[1], 'M40.00,95.00 H50.00 V94.00');

// 이름표: 최소 간격 확보, 아래 경계를 넘으면 위로 밀고 위 경계도 지킨다
const labels = run(`chartLineEndLabels([
  {text: "20", y: 100}, {text: "기준", y: 103}, {text: "50", y: 104}, {text: "200", y: 300},
], 11, 10, 200)`);
const ys = Object.fromEntries(labels.map(l => [l.text, l.y]));
assert.equal(ys['20'], 100);
assert.equal(ys['기준'], 111);
assert.equal(ys['50'], 122);
assert.equal(ys['200'], 200);   // 아래 경계로 끌어올림
for (let i = 1; i < labels.length; i += 1) assert.ok(labels[i].y - labels[i - 1].y >= 11);

// 색: 기준선과 이평선이 같은 색이면 안 된다(예전엔 기준선 = 20일선 #d97706)
const fs = require('node:fs');
const css = fs.readFileSync(require('node:path').join(__dirname, '../portfolio_static/styles.css'), 'utf8');
for (const block of css.split(/(?=@media|:root\[data-theme)/)) {
  const token = name => (block.match(new RegExp(`--${name}:\\s*([^;]+);`)) || [])[1];
  const ichi = ['chart-ichi-tenkan', 'chart-ichi-kijun'].map(token).filter(Boolean);
  const ma = ['chart-ma-short', 'chart-ma-medium', 'chart-ma-long'].map(token).filter(Boolean);
  for (const color of ichi) assert.ok(!ma.includes(color), `일목·이평선 색 중복: ${color}`);
}
console.log('chart line distinction ok');

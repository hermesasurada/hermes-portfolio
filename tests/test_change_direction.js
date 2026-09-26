// 등락 방향(up/down/flat·▲/▼/→)은 format.js changeDirection 한 곳에서만 정한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const dir = v => h.plain(ctx.changeDirection(v));

assert.deepEqual(dir(1.5), {cls: 'up', arrow: '▲'});
assert.deepEqual(dir('0.01'), {cls: 'up', arrow: '▲'});
assert.deepEqual(dir(-0.01), {cls: 'down', arrow: '▼'});
for (const flat of [0, -0, null, undefined, '', 'abc', NaN, Infinity, -Infinity]) {
  assert.deepEqual(dir(flat), {cls: 'flat', arrow: '→'}, `보합이어야 한다: ${String(flat)}`);
}
// 쓰는 쪽이 같은 규칙을 따르는지 몇 군데 실제 출력으로 확인
assert.match(ctx.signedPercentText(-2.5), /class="down"><span aria-hidden="true">▼<\/span>2\.5%/);
assert.match(ctx.changeKrwText(250000), /change-cell up"><span aria-hidden="true">▲/);
assert.equal(ctx.chartPriceClass(0), 'flat');
assert.equal(ctx.chartPriceClass('-3'), 'down');
assert.match(ctx.dividendHistoryPercent(4), /class="up"><span aria-hidden="true">▲/);
assert.equal(JSON.stringify(ctx.changePercentParts(-1.234)), JSON.stringify({cls: 'down', arrow: '▼', text: '1.23%'}));

// 부호로 방향을 가르는 삼항식이 다시 흩어지지 않는다(임계값·상태·매수/매도 구분은 다른 의미라 허용).
const allowed = [/pct >= 60 \? "up"/, /state === "buy" \? "up"/, /buy \? "up" : "down"/];
const dirStatic = path.join(__dirname, '../portfolio_static');
for (const file of fs.readdirSync(dirStatic).filter(f => f.endsWith('.js'))) {
  const lines = fs.readFileSync(path.join(dirStatic, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/\? "up" : .*"down"|\? "▲" : .*"▼"/.test(line)) return;
    if (file === 'format.js' && /function changeDirection/.test(lines.slice(Math.max(0, i - 4), i).join('\n'))) return;
    if (allowed.some(re => re.test(line))) return;
    assert.fail(`${file}:${i + 1} 등락 방향을 직접 판정한다 — changeDirection을 쓸 것: ${line.trim()}`);
  });
}
console.log('Change direction: single definition, flat for zero/missing, callers aligned, no scattered ternaries');

// 변동성 손익비 표기: 이력 길이(3Y·1Y)·배당 반영(P) 각주를 붙이지 않는다(2026-10-23 사용자 지시).
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.equal(run('riskRewardScoreText(7.234)'), '<span class="up">+7.2</span>');
assert.equal(run('riskRewardScoreText(-1.25)'), '<span class="down">-1.3</span>');
assert.equal(run('riskRewardScoreText(null)'), '-');
// 예전 호출처럼 basis·quality를 넘겨도 각주가 생기지 않는다
assert.doesNotMatch(run('riskRewardScoreText(3.1, "3y", "P")'), /<small|3Y|·P/);
// 호출처에서 basis·quality 인자를 다시 넘기지 않는다
for (const file of ['app-holdings.js', 'app-interest-columns.js', 'app-chart-metrics.js'])
  assert.doesNotMatch(h.readStatic(file), /riskRewardScoreText\([^)]*risk_reward_basis/, file);
console.log('risk reward text ok');

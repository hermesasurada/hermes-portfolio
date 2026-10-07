// 관심목록 스크리닝 — 수치 열 조건 최대 5개 AND, 표에 보이는 단위로 입력, 값 없음은 탈락(배당율은 0%).
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

const rows = [
  {ticker: 'A', rsi_day: 25, perf_1y: 40, gross_margin: 0.62, market_cap_usd: 3e12, dividend_yield: 0.5},
  {ticker: 'B', rsi_day: 45, perf_1y: 12, gross_margin: 0.30, market_cap_usd: 5e9, dividend_yield: null},
  {ticker: 'C', rsi_day: null, perf_1y: 80, gross_margin: 0.70, market_cap_usd: 2e11, dividend_yield: 3.2},
  {ticker: 'D', rsi_day: 28, perf_1y: -5, gross_margin: null, market_cap_usd: 8e10, dividend_yield: 4},
];
ctx.__rows = rows;
const screen = conditions => { ctx.__conditions = conditions; return run('__rows.filter(row => passesInterestScreen(row, __conditions))').map(r => r.ticker); };

// 단일 조건, 이상/이하, 경계 포함
assert.deepEqual(screen([{key: 'rsi_day', op: 'lte', value: 28}]), ['A', 'D']);
assert.deepEqual(screen([{key: 'perf_1y', op: 'gte', value: 40}]), ['A', 'C']);
// AND 결합
assert.deepEqual(screen([{key: 'rsi_day', op: 'lte', value: 30}, {key: 'perf_1y', op: 'gte', value: 0}]), ['A']);
// 같은 항목 두 번 = 범위
assert.deepEqual(screen([{key: 'perf_1y', op: 'gte', value: 10}, {key: 'perf_1y', op: 'lte', value: 50}]), ['A', 'B']);
// 소수 보관 열은 % 입력(60% → 0.6)
assert.deepEqual(screen([{key: 'gross_margin', op: 'gte', value: 60}]), ['A', 'C']);
// 시총은 B$ 입력(100 → 1천억 달러)
assert.deepEqual(screen([{key: 'market_cap_usd', op: 'gte', value: 100}]), ['A', 'C']);
// 값 없음은 탈락, 배당율만 0%로 본다
assert.deepEqual(screen([{key: 'gross_margin', op: 'lte', value: 100}]), ['A', 'B', 'C']);
assert.deepEqual(screen([{key: 'dividend_yield', op: 'lte', value: 1}]), ['A', 'B']);

// 필드 목록: 통화가 다른 가격·FCF, 날짜·문자 열은 없다. 단위 표기
const fields = run('interestScreenFields()');
const keys = new Set(fields.map(f => f.key));
for (const excluded of ['current_price', 'target_price', 'free_cash_flow', 'next_earnings_date', 'trade_timing', 'rating_rank', 'name'])
  assert.ok(!keys.has(excluded), excluded);
for (const key of ['rsi_day', 'perf_1y', 'gross_margin', 'market_cap_usd', 'risk_reward_score', 'ma200_pct']) assert.ok(keys.has(key), key);
const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
assert.equal(byKey.gross_margin.unit, '%');
assert.equal(byKey.market_cap_usd.unit, 'B$');
assert.equal(byKey.rsi_day.unit, '');
assert.equal(byKey.perf_1y.label, '수익률 1년');
assert.equal(byKey.rsi_day.label, 'RSI (일)');

// 저장: 잘못된 조건은 버리고 5개까지만, 이 브라우저에 남는다
run(`saveInterestScreen([
  {key:'rsi_day',op:'lte',value:'30'}, {key:'nope',op:'gte',value:1}, {key:'perf_1y',op:'gte',value:''},
  {key:'perf_1y',op:'gte',value:1}, {key:'perf_3m',op:'gte',value:1}, {key:'perf_6m',op:'gte',value:1},
  {key:'ma50_pct',op:'gte',value:0}, {key:'ma200_pct',op:'gte',value:0},
])`);
const saved = run('interestScreenConditions');
assert.equal(saved.length, 5);
assert.equal(JSON.stringify(saved[0]), JSON.stringify({key: 'rsi_day', op: 'lte', value: 30}));
run('interestScreenConditions = []; loadInterestScreen()');
assert.equal(run('interestScreenConditions').length, 5);
// 깨진 저장값은 조용히 비운다
run(`storageSet(detailStorage.interestScreen, '{oops'); loadInterestScreen()`);
assert.equal(run('interestScreenConditions').length, 0);

// applyInterestScreen: 조건 없으면 그대로, 있으면 거르고 직전 행을 미리보기용으로 남긴다
run('interestScreenConditions = []');
assert.equal(run('applyInterestScreen(__rows)').length, 4);
run("interestScreenConditions = [{key:'rsi_day',op:'lte',value:30}]");
assert.deepEqual(run('applyInterestScreen(__rows)').map(r => r.ticker), ['A', 'D']);
assert.equal(run('interestPreScreenRows').length, 4);
console.log('interest screen ok');

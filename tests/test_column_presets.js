// 표 열 묶음(2026-11-20 디자인 재검토 05): 도구 줄의 '열' 선택으로 종목·등락·현재가 옆에 고른 묶음만 본다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.plain(h.evaluate(ctx, code));

// 선택지: 계좌표는 재무·컨센서스가 없다(열이 없다).
assert.deepEqual(run('columnPresetOptions("detail").map(p => p.label)'), ['전체', '요약', '기술', '밸류', '배당', '수익률', '추세·위험']);
assert.deepEqual(run('columnPresetOptions("interest").map(p => p.label)'), ['전체', '요약', '기술', '밸류', '배당', '수익률', '추세·위험', '재무', '컨센서스']);

// 종목·등락·현재가는 어느 묶음에서나 보인다. '전체'는 아무것도 숨기지 않는다.
for (const preset of ['summary', 'tech', 'value', 'dividend', 'perf', 'trend']) {
  for (const key of ['logo', 'name', 'display_change_pct', 'current_price']) {
    assert.equal(run(`columnInPreset("${key}", "${preset}", "detail", "", false)`), true, `${preset}:${key}`);
  }
}
assert.equal(run('columnInPreset("perf_1y", "all", "detail", "", true)'), true);
// 묶음마다 제 열만.
assert.equal(run('columnInPreset("value_krw", "summary", "detail", "", false)'), true);
assert.equal(run('columnInPreset("value_krw", "value", "detail", "", false)'), false);
assert.equal(run('columnInPreset("rsi_day", "tech", "detail", "", false)'), true);
assert.equal(run('columnInPreset("yield_on_cost", "dividend", "detail", "", false)'), true);
assert.equal(run('columnInPreset("trend10_strength", "trend", "detail", "", false)'), true);
assert.equal(run('columnInPreset("trade", "summary", "detail", "", false)'), true);
// 좁은 화면의 계좌표 '요약'은 보유 현황만(연장·현재단가·수량 제외). PC와 다른 묶음은 그대로.
for (const key of ['extended_change_pct', 'current_price', 'qty']) {
  assert.equal(run(`columnInPreset("${key}", "summary", "detail", "", true)`), false, key);
  assert.equal(run(`columnInPreset("${key}", "summary", "detail", "", false)`), true, key);
}
assert.equal(run('columnInPreset("current_price", "perf", "detail", "", true)'), true);
assert.equal(run('columnInPreset("value_krw", "summary", "detail", "", true)'), true);
// 관심목록: 요약에 시총·52주 고점 대비·실적일, 재무·컨센서스는 열 정의의 group으로.
assert.equal(run('columnInPreset("market_cap_usd", "summary", "interest", "", true)'), true);
assert.equal(run('columnInPreset("market_cap_usd", "summary", "detail", "", false)'), false);
assert.equal(run('columnInPreset("gross_margin", "fund", "interest", "profitability", false)'), true);
assert.equal(run('columnInPreset("target_price", "consensus", "interest", "consensus", false)'), true);
assert.equal(run('columnInPreset("target_price", "fund", "interest", "consensus", false)'), false);

// 모든 열이 '전체' 말고도 적어도 한 묶음에 든다(새 열을 더하고 묶음을 빠뜨리지 않게). 삭제 열 등 늘 보이는 열은 예외.
const orphans = run(`INTEREST_COLUMNS.filter(c => !COLUMN_PRESET_ALWAYS.has(c.key)
  && !columnPresetOptions("interest").some(p => p.key !== "all" && columnInPreset(c.key, p.key, "interest", c.group, false))).map(c => c.key)`);
assert.deepEqual(orphans, []);
const html = h.readStatic('index.html');
const detailKeys = [...html.slice(html.indexOf('detail-group-head'), html.indexOf('<tbody id="holdings">')).matchAll(/data-(?:column-)?key="([a-z0-9_]+)"/g)].map(m => m[1]);
assert.ok(detailKeys.length >= 45, detailKeys.length);
for (const key of new Set(detailKeys)) {
  if (['ticker', 'name'].includes(key)) continue;   // 종목 열 안의 정렬 버튼
  const inSome = ['summary', 'tech', 'value', 'dividend', 'perf', 'trend'].some(p => run(`columnInPreset("${key}", "${p}", "detail", "", false)`));
  assert.ok(inSome, `계좌표 열 ${key}가 어느 묶음에도 없다`);
}

// 기본값: 고른 적이 없으면 좁은 화면은 요약, PC는 전체. 고르면 표마다 기억한다.
assert.equal(run('activeColumnPreset("detail")'), 'all');
h.evaluate(ctx, 'setColumnPreset("detail", "perf")');
assert.equal(run('activeColumnPreset("detail")'), 'perf');
assert.equal(run('activeColumnPreset("interest")'), 'all');
h.evaluate(ctx, 'setColumnPreset("detail", "consensus")');   // 계좌표에 없는 묶음은 기본값으로
assert.equal(run('activeColumnPreset("detail")'), 'all');

// 관심목록은 열 정의를 걸러 그린다.
h.evaluate(ctx, 'setColumnPreset("interest", "dividend")');
const row = '{ticker: "AAA", dividend_yield: 2, perf_1y: 10, rsi_day: 40, trailing_pe: 12, extended_change_pct: 1}';
assert.deepEqual(run(`visibleInterestColumns([${row}]).map(c => c.key)`), ['logo', 'name', 'display_change_pct', 'current_price', 'dividend_yield', 'delete']);
h.evaluate(ctx, 'setColumnPreset("interest", "all")');
assert.ok(run(`visibleInterestColumns([${row}]).map(c => c.key)`).includes('perf_1y'));

assert.match(html, /<select id="columnPresetSelect"/);
assert.match(h.readStatic('app-holdings.js'), /syncDetailColumnPreset\(\);\s*\n\s*const rows = applyTagFilter/);
console.log('column presets ok');

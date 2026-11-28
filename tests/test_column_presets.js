// 표 열 묶음(2026-11-20 디자인 재검토 05): 도구 줄의 '열' 선택으로 종목·등락·현재가 옆에 고른 묶음만 본다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.plain(h.evaluate(ctx, code));

// 선택지: 계좌표도 관심목록과 같은 묶음(2026-11-20부터 재무·컨센서스 열이 있다).
assert.deepEqual(run('columnPresetOptions("detail").map(p => p.label)'), ['전체', '요약', '기술', '밸류', '배당', '수익률', '추세·위험', '재무', '컨센서스']);
assert.deepEqual(run('columnPresetOptions("interest").map(p => p.label)'), ['전체', '요약', '기술', '밸류', '배당', '수익률', '추세·위험', '재무', '컨센서스']);

// 종목·등락·현재가는 어느 묶음에서나 보인다. '전체'는 아무것도 숨기지 않는다.
for (const preset of ['summary', 'tech', 'value', 'dividend', 'perf', 'trend']) {
  for (const key of ['logo', 'name', 'display_change_pct', 'current_price']) {
    assert.equal(run(`columnInPreset("${key}", "${preset}", "detail", "")`), true, `${preset}:${key}`);
  }
}
assert.equal(run('columnInPreset("perf_1y", "all", "detail", "")'), true);
// 묶음마다 제 열만.
assert.equal(run('columnInPreset("value_krw", "summary", "detail", "")'), true);
assert.equal(run('columnInPreset("value_krw", "value", "detail", "")'), false);
assert.equal(run('columnInPreset("rsi_day", "tech", "detail", "")'), true);
assert.equal(run('columnInPreset("yield_on_cost", "dividend", "detail", "")'), true);
assert.equal(run('columnInPreset("trend10_strength", "trend", "detail", "")'), true);
assert.equal(run('columnInPreset("trade", "summary", "detail", "")'), true);
// '요약'은 좁은 화면도 PC와 같은 열 — 연장·현재단가·수량이 보인다(2026-11-21 사용자 지시).
for (const key of ['extended_change_pct', 'current_price', 'qty', 'change_krw', 'value_krw', 'weight_pct', 'trade']) {
  assert.equal(run(`columnInPreset("${key}", "summary", "detail", "")`), true, key);
}
assert.equal(run('columnInPreset("extended_change_pct", "summary", "interest", "")'), true);
assert.doesNotMatch(h.readStatic('app-interest-columns.js'), /COMPACT_SUMMARY_HIDDEN/);
// 관심목록: 요약에 시총·52주 고점 대비·실적일, 재무·컨센서스는 열 정의의 group으로.
assert.equal(run('columnInPreset("market_cap_usd", "summary", "interest", "")'), true);
assert.equal(run('columnInPreset("market_cap_usd", "summary", "detail", "")'), false);
assert.equal(run('columnInPreset("gross_margin", "fund", "interest", "profitability")'), true);
assert.equal(run('columnInPreset("target_price", "consensus", "interest", "consensus")'), true);
assert.equal(run('columnInPreset("target_price", "fund", "interest", "consensus")'), false);

// 모든 열이 '전체' 말고도 적어도 한 묶음에 든다(새 열을 더하고 묶음을 빠뜨리지 않게). 삭제 열 등 늘 보이는 열은 예외.
const orphans = run(`INTEREST_COLUMNS.filter(c => !COLUMN_PRESET_ALWAYS.has(c.key)
  && !columnPresetOptions("interest").some(p => p.key !== "all" && columnInPreset(c.key, p.key, "interest", c.group, false))).map(c => c.key)`);
assert.deepEqual(orphans, []);
const html = h.readStatic('index.html');
const detailKeys = [...html.slice(html.indexOf('detail-group-head'), html.indexOf('<tbody id="holdings">')).matchAll(/data-(?:column-)?key="([a-z0-9_]+)"/g)].map(m => m[1]);
assert.ok(detailKeys.length >= 45, detailKeys.length);
for (const key of new Set(detailKeys)) {
  if (['ticker', 'name'].includes(key)) continue;   // 종목 열 안의 정렬 버튼
  const inSome = ['summary', 'tech', 'value', 'dividend', 'perf', 'trend', 'fund', 'consensus'].some(p => run(`columnInPreset("${key}", "${p}", "detail", "")`));
  assert.ok(inSome, `계좌표 열 ${key}가 어느 묶음에도 없다`);
}

// 기본값: 고른 적이 없으면 좁은 화면은 요약, PC는 전체. 고르면 표마다 기억한다.
assert.equal(run('activeColumnPreset("detail")'), 'all');
h.evaluate(ctx, 'setColumnPreset("detail", "perf")');
assert.equal(run('activeColumnPreset("detail")'), 'perf');
assert.equal(run('activeColumnPreset("interest")'), 'all');
h.evaluate(ctx, 'setColumnPreset("detail", "nonexistent")');   // 없는 묶음은 기본값으로
assert.equal(run('activeColumnPreset("detail")'), 'all');
assert.equal(run('columnInPreset("target_price", "consensus", "detail", "")'), true);
assert.equal(run('columnInPreset("gross_margin", "fund", "detail", "")'), true);

// 관심목록은 좁은 화면에서만 열 정의를 걸러 그린다. PC는 늘 전체(버튼은 그 위치로 스크롤 — 2026-11-20 사용자 지시).
h.evaluate(ctx, 'setColumnPreset("interest", "dividend")');
const rowPc = '{ticker: "AAA", dividend_yield: 2, perf_1y: 10, rsi_day: 40, trailing_pe: 12, extended_change_pct: 1}';
assert.ok(run(`visibleInterestColumns([${rowPc}]).map(c => c.key)`).includes('perf_1y'), 'PC는 거르지 않는다');
assert.equal(run('effectiveColumnPreset("detail", false)'), 'all');
assert.deepEqual(run('columnPresetNavOptions("detail").map(p => p.key)'), ['summary', 'tech', 'value', 'dividend', 'perf', 'trend', 'fund', 'consensus']);
ctx.window.matchMedia = () => ({ matches: true, addEventListener() {} });
const row = '{ticker: "AAA", dividend_yield: 2, perf_1y: 10, rsi_day: 40, trailing_pe: 12, extended_change_pct: 1}';
assert.deepEqual(run(`visibleInterestColumns([${row}]).map(c => c.key)`), ['logo', 'name', 'display_change_pct', 'current_price', 'dividend_yield', 'delete']);
h.evaluate(ctx, 'setColumnPreset("interest", "all")');
assert.ok(run(`visibleInterestColumns([${row}]).map(c => c.key)`).includes('perf_1y'));

assert.match(html, /<select id="columnPresetSelect"/);
assert.match(h.readStatic('app-holdings.js'), /const rows = applyTagFilter[^\n]*\n\s*syncDetailColumnPreset\(rows\);/);
// PC는 통화처럼 버튼 묶음, 모바일은 선택 상자(2026-11-20 사용자 지시).
assert.match(html, /<div class="segmented column-preset-segments" id="columnPresetSegments"/);
assert.match(h.readStatic('app-holdings.js'), /data-column-preset="\$\{preset\.key\}"/);
// 계좌표: 보이는 종목 전부가 값이 없는 지표 열은 숨긴다(2026-11-28 — 연금 계좌는 ETF만이라 밸류·수익성 등이 빈다).
// 요약 열은 비어도 두고, 통계·컨센서스가 다 오기 전에는 숨기지 않는다.
const leaves = '["qty", "trailing_pe", "gross_margin", "dividend_yield", "perf_1y", "target_price"].map(key => ({key}))';
const etfRows = '[{ticker: "ETF1", category: "kr", qty: 0, dividend_yield: 3, perf_1y: 5}, {ticker: "ETF2", category: "kr", perf_1y: 2}]';
h.evaluate(ctx, 'statsData = {}; quoteFetchedTickers = new Set()');
assert.deepEqual(run(`[...emptyDetailColumnKeys(${leaves}, ${etfRows})]`), []);
h.evaluate(ctx, 'statsData = {ETF1: {}, ETF2: {}}');
assert.deepEqual(run(`[...emptyDetailColumnKeys(${leaves}, ${etfRows})]`), ['trailing_pe', 'gross_margin']);
h.evaluate(ctx, 'quoteFetchedTickers = new Set(["ETF1", "ETF2"])');
assert.deepEqual(run(`[...emptyDetailColumnKeys(${leaves}, ${etfRows})]`), ['trailing_pe', 'gross_margin', 'target_price']);
assert.deepEqual(run(`[...emptyDetailColumnKeys(${leaves}, [])]`), []);
h.evaluate(ctx, 'statsData = {}; quoteFetchedTickers = new Set()');
console.log('column presets ok');

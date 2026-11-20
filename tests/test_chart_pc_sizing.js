// PC 개별종목 화면(2026-11-15): 넓은 화면에서 그림을 늘리지 않고 넓게 그리고, 아주 넓으면 지표를 오른쪽 레일로.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const W = canvasPx => ctx.chartViewBoxWidth({ clientWidth: canvasPx }, false);

// 배율 1.4배까지는 예전처럼 980 단위를 늘린다(기본 폭 화면 그대로)
assert.equal(W(1000), 980);
assert.equal(W(1344), 980);
assert.equal(W(1372), 980);
// 그보다 넓으면 배율을 1.4에 묶고 viewBox를 넓힌다 — 글자·선 크기가 그대로
assert.equal(W(1513), Math.round(1513 / 1.4));
assert.equal(W(2800), 2000);
assert.ok(1513 / W(1513) <= 1.4001);
// 모바일은 늘 980
assert.equal(ctx.chartViewBoxWidth({ clientWidth: 2800 }, true), 980);

// 높이: PC는 화면 아래까지 — 레일은 기본 ~ 1.6배, 한 단은 0.75 ~ 1.6배
const view = { classList: { contains: c => c === 'chart-rail' && view.rail }, rail: false };
const orig = ctx.document.getElementById.bind(ctx.document);
ctx.document.getElementById = id => (id === 'chartView' ? view : orig(id));
const canvas = { clientWidth: 1512, getBoundingClientRect: () => ({ top: 380 }) };
ctx.window.innerHeight = 1300; ctx.window.scrollY = 0;
// 한 단(레일 아님)도 화면 아래까지 채우고, 낮은 화면에서는 기본 높이의 0.75배까지 낮춘다(2026-11-20)
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), Math.round((1300 - 380 - 64) / 1.4));
ctx.window.innerHeight = 700;
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), Math.round(530 * 0.75));
ctx.window.innerHeight = 1300;
view.rail = true;
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), Math.round((1300 - 380 - 64) / 1.4));
ctx.window.innerHeight = 700;
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), 530);       // 레일은 기본 높이 아래로 줄이지 않는다
ctx.window.innerHeight = 4000;
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), 848);       // 1.6배 상한
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, true), 530);        // 모바일 제외

// 레일 기준 폭: 레일을 둬도 차트가 기본 폭 최대치(약 1,340px) 아래로 줄지 않아야 한다
const railMin = h.evaluate(ctx, 'CHART_RAIL_MIN_WIDTH');
assert.ok(railMin - 440 - 16 - 28 >= 1340, railMin);
// CSS: 레일 배치는 PC에서만, 지표판은 2열 세로 우선(모바일과 같은 --mobile-order)
const css = h.readStatic('styles.css');
const pc = h.mediaBlocks(css, '(min-width: 981px)').map(b => b.text).join('\n');
assert.match(pc, /\.chart-view\.chart-rail \{[^}]*grid-template-areas: "head rail" "stage rail"/);
assert.match(pc, /\.chart-view\.chart-rail > \.chart-stats \{[^}]*align-self: stretch/);   // 레일 아래 끝 = 차트 아래 끝
assert.match(pc, /\.chart-view\.chart-rail #chartStats \.cstat-board \{[^}]*flex: 1 1 0;[^}]*minmax\(24px, 1fr\)/);
assert.match(pc, /\.chart-view\.chart-rail #chartStats \.cstat-row \{[^}]*order: var\(--mobile-order/);
// 배율은 화면 높이에도 맞춘다(2026-11-20): 넓지만 낮은 화면은 배율을 낮추고 viewBox를 넓힌다.
{
  const wide = { clientWidth: 1345, getBoundingClientRect: () => ({ top: 271 }) };
  ctx.window.scrollY = 0;
  ctx.window.innerHeight = 900;      // 쓸 수 있는 높이 565px → 배율 565/530
  assert.equal(ctx.chartViewBoxWidth(wide, false, 530), Math.round(1345 / (565 / 530)));
  assert.equal(ctx.chartViewBoxWidth(wide, false), 980);                 // 높이를 주지 않으면 예전 규칙
  ctx.window.innerHeight = 600;      // 아주 낮은 화면도 배율 1 아래로는 내리지 않는다
  assert.equal(ctx.chartViewBoxWidth(wide, false, 530), 1345);
  ctx.window.innerHeight = 3000;     // 높은 화면은 폭 기준 배율(1345/980) 그대로
  assert.equal(ctx.chartViewBoxWidth(wide, false, 530), 980);
  assert.equal(ctx.chartViewBoxWidth(wide, true, 900), 980);             // 모바일 제외
}
// reserve: 차트별로 화면 아래에 더 남길 높이(성과 차트 100px, 2026-11-20)
{
  const c = { clientWidth: 1020, getBoundingClientRect: () => ({ top: 396 }) };
  ctx.window.scrollY = 0; ctx.window.innerHeight = 1100;
  const w = ctx.chartViewBoxWidth(c, false, 432, 100);
  assert.equal(ctx.chartViewBoxHeight(c, w, 432, false, 100), Math.round((1100 - 396 - 64 - 100) / (1020 / w)));
  assert.ok(ctx.chartViewBoxHeight(c, w, 432, false, 100) < ctx.chartViewBoxHeight(c, w, 432, false));
}
console.log('PC chart sizing: capped scale, rail height fill, rail threshold and layout ok');

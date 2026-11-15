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

// 높이: 레일이 아니면 기본 높이, 레일이면 화면 아래까지(기본 ~ 1.6배)
const view = { classList: { contains: c => c === 'chart-rail' && view.rail }, rail: false };
const orig = ctx.document.getElementById.bind(ctx.document);
ctx.document.getElementById = id => (id === 'chartView' ? view : orig(id));
const canvas = { clientWidth: 1512, getBoundingClientRect: () => ({ top: 380 }) };
ctx.window.innerHeight = 1300; ctx.window.scrollY = 0;
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), 530);
view.rail = true;
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), Math.round((1300 - 380 - 64) / 1.4));
ctx.window.innerHeight = 700;
assert.equal(ctx.chartViewBoxHeight(canvas, 1080, 530, false), 530);       // 낮은 화면은 기본 높이 아래로 줄이지 않는다
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
assert.match(pc, /\.chart-view\.chart-rail #chartStats \.cstat-board \{[^}]*flex: 1 1 0;[^}]*minmax\(28px, 1fr\)/);
assert.match(pc, /\.chart-view\.chart-rail #chartStats \.cstat-row \{[^}]*order: var\(--mobile-order/);
console.log('PC chart sizing: capped scale, rail height fill, rail threshold and layout ok');

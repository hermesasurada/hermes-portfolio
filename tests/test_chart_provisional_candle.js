// 잠정 봉(2026-10-16): 당일 정규장 봉 수집 전 라이브 점은 서버가 직전 종가→라이브 가격 봉을 붙이고
// provisional로 표시한다. 일봉은 속 빈 몸통·툴팁 '잠정', 주·월 봉에 확정 일봉이 섞이면 잠정 표시를 뗀다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);
const json = code => JSON.parse(run(`JSON.stringify(${code})`));

const real = '{date: "2026-10-12", open: 10, high: 12, low: 9, close: 11}';
const prov = '{date: "2026-10-13", open: 11, high: 13, low: 11, close: 13, live: true, extended: true, provisional: true}';
// 같은 주에 확정 일봉이 있으면 주봉은 확정
assert.equal(json(`aggregateChartPoints([${real}, ${prov}], "week")`)[0].provisional, undefined);
// 잠정 일봉뿐인 주는 잠정 유지, 일봉 간격은 그대로
assert.equal(json(`aggregateChartPoints([${prov}], "week")`)[0].provisional, true);
assert.equal(json(`aggregateChartPoints([${real}, ${prov}], "day")`)[1].provisional, true);
// 툴팁: 캔들 모드에서 잠정 줄
run('chartType = "candle"');
const tip = JSON.stringify(json(`chartPointTooltipLines(${prov}, {currency: "USD", ticker: "NVDA"})`));
assert.match(tip, /잠정/);
assert.match(tip, /직전 종가→장외가/);
assert.doesNotMatch(JSON.stringify(json(`chartPointTooltipLines(${real}, {currency: "USD", ticker: "NVDA"})`)), /잠정/);
// 렌더: 잠정 봉에 provisional 클래스, CSS는 몸통만 비운다(소스 검사)
assert.match(h.readStatic('app-line-chart.js'), /chart-candle \$\{cls\}\$\{point\.provisional \? " provisional" : ""\}/);
assert.match(h.readStatic('styles.css'), /\.chart-candle\.provisional \.chart-candle-body \{ fill: var\(--panel\); \}/);
console.log('provisional candle ok');

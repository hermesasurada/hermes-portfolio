// '배당 포함' 토글 — 기간 수익률(1주~10년)을 배당 재투자 값으로 바꾸고, 이 브라우저에 저장한다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const toggle = h.element({ checked: false });
const byId = ctx.document.getElementById.bind(ctx.document);
ctx.document.getElementById = id => (id === 'dividendReturnToggle' ? toggle : byId(id));

ctx.__stats = {
  SCHD: {
    performance: { one_year: 21.2, five_year: 30.7, ten_year: 134.8 },
    performance_tr: { one_year: 25.5, five_year: 56.3, ten_year: 229.0 },
    performance_tr_quality: { one_year: 'TR', five_year: 'TR', ten_year: 'TR' },
  },
  K: {  // 배당 이력이 5년을 덮지 못한 한국 ETF
    performance: { one_year: 9.2, five_year: 169.2 },
    performance_tr: { one_year: 9.5, five_year: 169.9 },
    performance_tr_quality: { one_year: 'TR', five_year: 'P' },
  },
  OLD: { performance: { one_year: 5 } },  // 아직 배당 포함 값이 계산되지 않은 캐시
};
h.evaluate(ctx, 'statsData = __stats; data = {fx: {USD: 1400}}');
const rows = () => h.plain(ctx.statsRows([{ ticker: 'SCHD' }, { ticker: 'K' }, { ticker: 'OLD' }]));

// 꺼져 있으면 가격 수익률, 품질 표시 없음
let [schd, k, old] = rows();
assert.equal(schd.perf_1y, 21.2);
assert.equal(k.perf_quality.perf_5y, null);
// 켜면 배당 포함 값 — 3년 이상은 기존처럼 연평균으로 환산
toggle.checked = true;
[schd, k, old] = rows();
assert.equal(schd.perf_1y, 25.5);
assert.ok(Math.abs(schd.perf_5y - ((1 + 56.3 / 100) ** (1 / 5) - 1) * 100) < 1e-9);
assert.equal(k.perf_quality.perf_1y, 'TR');
assert.equal(k.perf_quality.perf_5y, 'P');
// 계산 전 캐시는 가격 값을 쓰되 전 기간 '일부 반영'으로 표시
assert.equal(old.perf_1y, 5);
assert.equal(old.perf_quality.perf_1y, 'P');

// 칸 표시: 품질 P는 흐리게 + 툴팁, 값이 없으면 '-' 그대로
assert.match(ctx.perfText(k, 'perf_5y', 1), /class="perf-partial" title="배당 일부만 반영/);
assert.doesNotMatch(ctx.perfText(k, 'perf_1y', 0), /perf-partial/);
assert.equal(ctx.perfText({ perf_5y: null, perf_quality: { perf_5y: 'P' } }, 'perf_5y', 1), '-');

// 두 표 모두 perfText로 그린다(한쪽만 바뀌면 같은 열이 표마다 달라진다)
const holdings = h.readStatic('app-holdings.js');
const columns = h.readStatic('app-interest-columns.js');
for (const key of ['perf_1w', 'perf_1m', 'perf_3m', 'perf_6m', 'perf_ytd', 'perf_1y', 'perf_3y', 'perf_5y', 'perf_10y']) {
  assert.ok(holdings.includes(`perfText(r, "${key}"`), `계좌표 ${key}`);
  assert.ok(columns.includes(`perfText(r, "${key}"`), `관심목록 ${key}`);
}
// 표 위 컨트롤 영역(환율 적용 옆)에 있고, 로컬 옵션 저장 대상이다
const html = h.readStatic('index.html');
assert.match(html, /id="fxAdjustedControl"[\s\S]*?<\/label>\s*<\/span>\s*<span class="filter-toggle-control" id="dividendReturnControl"/);
assert.match(h.readStatic('state.js'), /dividendReturns: "portfolio\.detail\.dividendReturns"/);
assert.match(h.readStatic('app.js'), /storageSet\(detailStorage\.dividendReturns,/);
assert.match(h.readStatic('app.js'), /checked = storageGet\(detailStorage\.dividendReturns\) === "true"/);
console.log('Dividend returns toggle: values switch, CAGR kept, partial marking, both tables, toolbar + local storage');

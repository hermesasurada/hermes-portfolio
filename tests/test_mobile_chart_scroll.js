// 모바일 개별종목 화면(2026-11-16): 열면 툴바(목록·관심목록·거래내역…)가 화면 맨 위에 오게 페이지를 스크롤한다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());

let mobile = true;
const scrolls = [];
const toolbar = { getBoundingClientRect: () => ({ top: 225 - ctx.window.scrollY }) };
ctx.window.matchMedia = () => ({ matches: mobile });
ctx.document.querySelector = sel => (sel === '.holdings-section .toolbar' ? toolbar : null);
ctx.window.scrollTo = (x, y) => { scrolls.push(y); ctx.window.scrollY = y; };

// 목록을 조금 내린 상태에서 열면 툴바 위치(225)로
ctx.window.scrollY = 120;
ctx.scrollChartToolbarToTop();
assert.deepEqual(scrolls, [225]);

// 그린 뒤 재조정: 문서가 짧아 끝까지 못 내려갔으면(위에 있으면) 다시 맞춘다
ctx.window.scrollY = 103; scrolls.length = 0;
ctx.scrollChartToolbarToTop({ onlyIfAbove: true });
assert.deepEqual(scrolls, [225]);
// 그 사이 사용자가 더 내려 봤으면 건드리지 않는다
ctx.window.scrollY = 600; scrolls.length = 0;
ctx.scrollChartToolbarToTop({ onlyIfAbove: true });
assert.deepEqual(scrolls, []);

// PC(>980px)는 표가 스크롤되므로 페이지를 움직이지 않는다
mobile = false; ctx.window.scrollY = 120; scrolls.length = 0;
ctx.scrollChartToolbarToTop();
assert.deepEqual(scrolls, []);

// openChart가 스켈레톤 직후와 그린 뒤 두 번 부른다
const src = h.readStatic('app-charts.js');
const open = src.slice(src.indexOf('async function openChart('), src.indexOf('async function reloadPriceChartForMarketMode'));
assert.ok(open.indexOf('chart-skeleton') < open.indexOf('scrollChartToolbarToTop();'));
assert.ok(open.indexOf('renderLineChart(payload);') < open.indexOf('scrollChartToolbarToTop({ onlyIfAbove: true })'));
console.log('mobile chart scroll checks passed');

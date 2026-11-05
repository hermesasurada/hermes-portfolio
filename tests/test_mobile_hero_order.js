// 한 단 화면(≤980px)에서 세로 순서는 계좌/관심목록/성과 탭 → 전광판이다(2026-11-05 사용자 지시로 되돌림).
const assert = require('assert');
const h = require('./harness');

const css = h.readStatic('styles.css');
const mobile = h.mediaBlocks(css, '(max-width: 980px)').map(block => block.text).join('\n');

assert.match(mobile, /\.layout \{ grid-template-columns: 1fr; \}/);
assert.doesNotMatch(mobile, /\.main-col \{[^}]*display: contents/);
assert.doesNotMatch(mobile, /\.hero-strip \{[^}]*order:/);

const html = h.readStatic('index.html');
assert.ok(html.indexOf('class="side-col"') < html.indexOf('id="heroStrip"'), 'DOM 순서는 선택기 → 전광판');

console.log('mobile hero order tests passed');

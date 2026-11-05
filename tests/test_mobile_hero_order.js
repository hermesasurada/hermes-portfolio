// 한 단 화면(≤980px)에서 전광판이 계좌/관심목록 선택기 위로 온다. 데스크톱 순서는 그대로다.
const assert = require('assert');
const h = require('./harness');

const css = h.readStatic('styles.css');
const mobile = h.mediaBlocks(css, '(max-width: 980px)').map(block => block.text).join('\n');
const base = h.withoutMediaBlocks(css, '(max-width: 980px)');

assert.match(mobile, /\.main-col \{ display: contents; \}/);
assert.match(mobile, /\.hero-strip \{ order: -1; margin-bottom: 0; \}/);
// 풀린 항목이 넓은 표에 밀려 트랙을 넓히지 않도록 0부터 시작한다
assert.match(mobile, /\.layout \{ grid-template-columns: minmax\(0, 1fr\); gap: 8px; \}/);
// 간격을 gap이 맡으므로 거래내역 여백이 겹치면 안 된다
assert.match(mobile, /\.transaction-panel \{ margin-top: 0; \}/);
assert.doesNotMatch(base, /\.main-col \{[^}]*display: contents/);

const html = h.readStatic('index.html');
assert.ok(html.indexOf('class="side-col"') < html.indexOf('id="heroStrip"'), '데스크톱 DOM 순서는 선택기 → 전광판');

console.log('mobile hero order tests passed');

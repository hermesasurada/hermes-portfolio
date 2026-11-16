// 모바일 개별종목 툴바 한 줄(2026-11-16): '목록'은 아이콘, 편입 ETF·촉매·일정 개수 배지는 숨김. PC는 그대로.
const assert = require('node:assert/strict');
const h = require('./harness');
const html = h.readStatic('index.html');
const css = h.readStatic('styles.css');
const back = html.slice(html.indexOf('id="chartBack"') - 60, html.indexOf('</button>', html.indexOf('id="chartBack"')));
assert.match(back, /aria-label="목록"/, '아이콘만 보일 때 접근성 이름');
assert.match(back, /<svg class="nav-icon"/);
assert.match(back, /<span>목록<\/span>/, 'PC는 글자 그대로');
const mobile = h.mediaBlocks(css, '(max-width: 980px)').map(b => b.text).join('\n');
assert.match(mobile, /#chartBack\.chart-back-btn > span \{ display: none; \}/);
assert.match(mobile, /#chartBack\.chart-back-btn \.nav-icon \{ display: block; \}/);
assert.match(mobile, /:is\(#chartEtfExposure, #chartCompanyEvents\) \.company-events-badge \{ display: none; \}/);
assert.match(mobile, /title-tools:has\(> #chartBack:not\(\.hidden\)\) \{[^}]*flex-wrap: nowrap/);
// 스크롤바 정책: 표준 scrollbar-width 선언 금지
assert.doesNotMatch(mobile.slice(mobile.indexOf('title-tools:has(> #chartBack')), /scrollbar-width\s*:/);
console.log('mobile chart toolbar checks passed');

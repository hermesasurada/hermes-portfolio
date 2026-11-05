// 모바일 세로 밀도(2026-11-05): 여백만 줄이고 터치 목표는 유지, 행 수는 제목 옆 숫자로 붙인다.
const assert = require('node:assert/strict');
const h = require('./harness');
const css = h.readStatic('styles.css');
const html = h.readStatic('index.html');
const mobile = h.mediaBlocks(css, '(max-width: 980px)').map(block => block.text).join('\n');

assert.match(mobile, /--list-row-height: 40px;/);       // 표 행은 터치 목표
assert.match(mobile, /--table-head-height: 34px;/);
assert.match(mobile, /\.toolbar \{ min-height: 40px; padding: 6px 12px; \}/);
assert.match(mobile, /\.layout \{[^}]*gap: 8px;/);
assert.match(mobile, /#nameFilterControl \{ flex: 1 1 90px;/);   // 150px면 필터 버튼이 셋째 줄로 밀린다

// 'rows'는 PC에서만. 값은 rowCountValue에 쓰고 단위는 CSS로 숨긴다
assert.match(html, /id="rowCount"><span id="rowCountValue">0<\/span><span class="row-count-unit"> rows<\/span>/);
assert.match(mobile, /\.row-count-unit \{ display: none; \}/);
for (const file of ['app-tabs.js', 'app-holdings.js', 'app-interest-watchlists.js']) {
  assert.doesNotMatch(h.readStatic(file), /getElementById\("rowCount"\)\.textContent/, file);
}
// 추가·일괄 버튼 글자가 세로로 꺾이지 않는다
assert.match(mobile, /\.interest-main-form button \{ flex: 0 0 auto;[^}]*white-space: nowrap;/);
console.log('mobile density ok');

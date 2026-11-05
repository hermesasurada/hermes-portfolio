// 모바일 배치(2026-11-05): 툴바·헤더를 두 줄로 묶되 세로 여백과 행 높이는 줄이지 않는다(사용자 지시로 원복).
const assert = require('node:assert/strict');
const h = require('./harness');
const css = h.readStatic('styles.css');
const html = h.readStatic('index.html');
const mobile = h.mediaBlocks(css, '(max-width: 980px)').map(block => block.text).join('\n');

assert.match(mobile, /--list-row-height: 40px;/);       // 표 행은 터치 목표
assert.match(mobile, /--table-head-height: 34px;/);
assert.doesNotMatch(mobile, /\.toolbar \{ min-height: 40px/);       // 툴바·카드 간격·그룹 행 높이는 원래 값
assert.doesNotMatch(mobile, /\.layout \{[^}]*gap:/);
assert.doesNotMatch(mobile, /\.interest-group \{ min-height: 36px/);
assert.match(mobile, /main \{\s*padding: 10px 8px 32px;/);
assert.match(mobile, /#nameFilterControl \{ flex: 1 1 90px;/);   // 150px면 필터 버튼이 셋째 줄로 밀린다

// 'rows'는 PC에서만. 값은 rowCountValue에 쓰고 단위는 CSS로 숨긴다
assert.match(html, /id="rowCount"><span id="rowCountValue">0<\/span><span class="row-count-unit"> rows<\/span>/);
assert.match(mobile, /\.row-count-unit \{ display: none; \}/);
assert.match(mobile, /\.controls \{ justify-content: flex-start; gap: 8px 4px; \}/);   // 헤더 두 줄은 가로 간격으로만
for (const file of ['app-tabs.js', 'app-holdings.js', 'app-interest-watchlists.js']) {
  assert.doesNotMatch(h.readStatic(file), /getElementById\("rowCount"\)\.textContent/, file);
}
// 추가·일괄 버튼 글자가 세로로 꺾이지 않는다
assert.match(mobile, /\.interest-main-form button \{ flex: 0 0 auto;[^}]*white-space: nowrap;/);
console.log('mobile density ok');

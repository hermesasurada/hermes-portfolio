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
for (const file of ['app-tabs.js', 'app-holdings.js', 'app-interest-watchlists.js']) {
  assert.doesNotMatch(h.readStatic(file), /getElementById\("rowCount"\)\.textContent/, file);
}
// 추가·일괄 버튼 글자가 세로로 꺾이지 않는다
assert.match(mobile, /\.interest-main-form button \{ flex: 0 0 auto;[^}]*white-space: nowrap;/);
// 모바일 헤더 한 줄: 버전·도움말을 빼고 제목은 남긴다. 폰 폭(480px 이하)은 메뉴를 아이콘으로, 전부 오른쪽 정렬
assert.match(mobile, /\.service-brand em, \.help-icon-btn \{ display: none; \}/);
const phone = h.mediaBlocks(css, '(max-width: 480px)').map(block => block.text).join('\n');
assert.match(phone, /\.controls \{[^}]*flex-wrap: nowrap;/);
assert.doesNotMatch(phone, /\.service-name \{ display: none/);
assert.match(mobile, /\.controls \{[^}]*margin-left: auto;/);
assert.match(phone, /\.controls \.ctrl-group \.ghost-btn \.nav-icon \{ display: block; \}/);
assert.match(h.withoutMediaBlocks(css, '(max-width: 980px)'), /\.nav-icon \{ display: none;/);
for (const id of ['scheduleOpen', 'cashFlowsOpen']) {
  assert.match(html, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"[^>]*><svg class="nav-icon"`), id);   // 아이콘만 보여도 이름이 남는다
}
// 검색·관리종목은 대화상자 하나, 성과는 사이드바 세 번째 탭. 성과 탭은 저장하지 않고 차트 상태에서 파생한다
assert.doesNotMatch(html, /id="(watchModal|watchlistOpen|performanceOpen|watchTickerInput)"/);
assert.match(html, /id="tickerSearchModal"[\s\S]*id="watchPanel"[\s\S]*id="watchApply"/);
assert.match(html, /data-sidebar-tab="performance"/);
assert.match(css, /\.sidebar-tabs \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
const sidebar = h.readStatic('app-interest-watchlists.js');
assert.match(sidebar, /const current = performanceChartOpen \? "performance" : activeSidebarTab;/);
assert.match(sidebar, /const nextTab = btn\.dataset\.sidebarTab === "interest" \? "interest" : "accounts";/);   // 저장값에 성과가 섞이지 않는다
// 아이콘은 버튼 가운데, 패널 접기는 탭 재선택으로만
assert.match(phone, /\.controls \.ctrl-group \.ghost-btn \{ display: inline-grid; place-items: center;/);
assert.doesNotMatch(html, /accountCollapseToggle/);
console.log('mobile density ok');

// 모바일(≤980px) 표(그리드) 글자 축소: 셀 기준값 하나와 거기 딸린 보조 텍스트만
// 같은 비율로 줄인다. 데스크톱 기본값은 건드리지 않는다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../portfolio_static/styles.css'), 'utf8');

// 축소 규칙이 들어 있는 ≤980px 블록만 잘라낸다(중괄호 깊이로 끝을 찾는다).
const start = css.lastIndexOf('@media (max-width: 980px)', css.indexOf('--grid-fs:'));
assert.ok(start >= 0, '--grid-fs를 담은 980px 미디어 블록을 찾지 못했다');
let depth = 0, end = start;
for (let i = css.indexOf('{', start); i < css.length; i += 1) {
  if (css[i] === '{') depth += 1;
  else if (css[i] === '}' && (depth -= 1) === 0) { end = i; break; }
}
const mobile = css.slice(start, end);

// 네 변수가 한자리에 모여 있고, 값이 데스크톱보다 작다.
const sizes = Object.fromEntries(['--grid-fs', '--grid-fs-sub', '--grid-fs-chip', '--grid-fs-tiny']
  .map(name => {
    const hit = mobile.match(new RegExp(`${name}:\\s*([\\d.]+)px`));
    assert.ok(hit, `${name} 정의 없음`);
    return [name, Number(hit[1])];
  }));
assert.ok(sizes['--grid-fs'] < 12, `셀 글자는 데스크톱 12px보다 작아야 한다: ${sizes['--grid-fs']}`);
assert.ok(sizes['--grid-fs-sub'] < 10.5, '티커·원화환산은 10.5px보다 작아야 한다');
assert.ok(sizes['--grid-fs-chip'] < 11, '등락 칩은 11px보다 작아야 한다');
assert.ok(sizes['--grid-fs-tiny'] <= sizes['--grid-fs-sub'], '각주가 보조 텍스트보다 크면 위계가 뒤집힌다');
assert.ok(sizes['--grid-fs-sub'] < sizes['--grid-fs'], '보조 텍스트가 셀보다 커서는 안 된다');

// 네 그리드 모두 같은 변수를 쓴다(하드코딩 px 재등장 방지).
for (const grid of ['#detailTableWrap', '.dividend-list', '.interest-detail-list', '.tx-list']) {
  assert.ok(mobile.includes(grid), `${grid}가 축소 대상에서 빠졌다`);
}
assert.match(mobile, /#detailTableWrap th, #detailTableWrap td,[\s\S]*?font-size: var\(--grid-fs\);/);
assert.match(mobile, /\.ticker-symbol, \.krw-sub, \.sector-chip\)[\s\S]*?font-size: var\(--grid-fs-sub\);/);
assert.match(mobile, /\.pct-chip, \.trade-timing-value\)[\s\S]*?font-size: var\(--grid-fs-chip\);/);
// 관심목록 헤더는 우선순위가 높은 자체 규칙이 있어 따로 덮어야 한다.
assert.match(mobile, /\.interest-group-head th\[rowspan\] \{\s*font-size: var\(--grid-fs\);/);
assert.match(mobile, /\.interest-group-head th:not\(\[rowspan\]\) \{\s*font-size: var\(--grid-fs-tiny\);/);

// 데스크톱 기본값은 그대로 — 모바일 블록 밖에서 확인한다.
const desktop = css.slice(0, start) + css.slice(end);
assert.match(desktop, /\.ticker-symbol \{[^}]*font-size: 10\.5px/);
assert.match(desktop, /\.pct-chip \{[^}]*font-size: 11px/);
assert.match(desktop, /\.interest-detail-list thead \.interest-group-head th\[rowspan\] \{[^}]*font-size: 12px/);

// ── 정보 밀도 ────────────────────────────────────────────────────────────
// 행 높이·세로 여백·로고를 줄이되, 항목 구분용 최소 여백은 남긴다.
const density = Object.fromEntries(['--list-row-height', '--list-cell-y', '--list-icon-size', '--table-head-height']
  .map(name => {
    const hit = mobile.match(new RegExp(`${name}:\\s*([\\d.]+)px`));
    assert.ok(hit, `${name} 모바일 정의 없음`);
    return [name, Number(hit[1])];
  }));
const base = Object.fromEntries(['--list-row-height', '--list-cell-y', '--list-icon-size', '--table-head-height']
  .map(name => [name, Number(css.match(new RegExp(`${name}:\\s*([\\d.]+)px`))[1])]));
for (const name of Object.keys(density)) {
  assert.ok(density[name] < base[name], `${name}: 모바일(${density[name]})이 데스크톱(${base[name]})보다 작아야 한다`);
}
// 최소 구분 여백 — 0으로 붙이지 않는다. 행 구분선도 그대로 남아 있어야 한다.
assert.ok(density['--list-cell-y'] >= 2, `세로 여백이 너무 좁다: ${density['--list-cell-y']}px`);
assert.match(css, /^th, td \{[\s\S]*?border-bottom: 1px solid var\(--line\);/m);
// 가로 여백은 컬럼 구분이라 건드리지 않는다(세로만 변수로 조정).
assert.doesNotMatch(mobile, /--list-cell-x/);

// 전역 button{height:36px}가 셀 안 로고·배당률 버튼을 키워 행이 부풀던 것을 끊는다.
assert.match(css, /button, input, select, textarea \{\s*height: 36px;/);
assert.match(mobile, /tbody :is\(\.company-profile-logo, \.stat-yield-link\) \{\s*height: auto;\s*min-height: 0;/);
// 액션 버튼은 자연 높이로 뭉개지 않고 한 단계만 줄여 누를 수 있게 남긴다.
const action = mobile.match(/tbody :is\(\.tx-pick, \.interest-row-delete\) \{\s*height: ([\d.]+)px/);
assert.ok(action && Number(action[1]) >= 24, `액션 버튼이 너무 작다: ${action && action[1]}`);

// thead 높이 규칙은 :is()에 #id를 섞지 않는다 — 특이도가 id급으로 올라가
// 관심목록 그룹 라벨 띠(22px) 자체 규칙까지 덮어써 헤더가 되레 두꺼워졌던 회귀.
const headRule = mobile.match(/([^}]*)\{\s*height: var\(--table-head-height\);/);
assert.ok(headRule, 'thead 높이 규칙 없음');
assert.doesNotMatch(headRule[1], /:is\([^)]*#/, 'thead 높이 셀렉터에 :is(#id …)를 쓰면 그룹 라벨 띠를 덮어쓴다');
for (const grid of ['#detailTableWrap thead th', '.interest-detail-list thead th']) {
  assert.ok(headRule[1].includes(grid), `${grid}가 thead 높이 규칙에서 빠졌다`);
}
assert.match(desktop, /\.interest-detail-list thead \.interest-group-head th:not\(\[rowspan\]\) \{[^}]*height: 22px/);


// ── 가로 밀도 ────────────────────────────────────────────────────────────
// 컬럼 폭은 --col-scale 하나로 줄인다. 계좌표는 CSS min-width, 관심목록은
// colgroup <col>과 표 전체 폭(JS)까지 같은 배율을 타야 fixed 레이아웃이
// 남는 폭을 열마다 비례 배분해 축소를 무효로 만들지 않는다.
const colScale = Number(mobile.match(/--col-scale:\s*(\.?\d*\.?\d+)/)[1]);
assert.ok(colScale > 0 && colScale < 1, `--col-scale은 0~1 사이여야 한다: ${colScale}`);
assert.ok(colScale >= 0.75, `너무 좁히면 숫자가 서로 붙는다: ${colScale}`);
// 데스크톱 기본은 1 — calc의 fallback으로 보장한다.
assert.match(desktop, /#detailTableWrap th:nth-child\(3\)[^{]*\{ min-width: calc\(76px \* var\(--col-scale, 1\)\); \}/);
const scaledWidths = (desktop.match(/calc\(\d+px \* var\(--col-scale, 1\)\)/g) || []).length;
assert.ok(scaledWidths >= 20, `계좌표 컬럼 폭이 배율을 타지 않는다: ${scaledWidths}개만 적용`);

const columnsJs = fs.readFileSync(path.join(__dirname, '../portfolio_static/app-interest-columns.js'), 'utf8');
assert.match(columnsJs, /calc\(\$\{column\.width\}px \* var\(--col-scale, 1\)\)/, 'colgroup 폭이 배율을 타야 한다');
const watchlistsJs = fs.readFileSync(path.join(__dirname, '../portfolio_static/app-interest-watchlists.js'), 'utf8');
assert.match(watchlistsJs, /table\.style\.width = `calc\(\$\{scaled\}px \* var\(--col-scale, 1\) \+ \$\{nameWidth\}px\)`/,
  '표 전체 폭이 배율을 타지 않으면 fixed 레이아웃이 축소를 되돌린다');

// 좌우 여백도 줄이되 0으로 붙이지는 않는다.
const padX = Number(mobile.match(/--grid-pad-x, ([\d.]+)px/)[1]);
assert.ok(padX >= 3 && padX < 6, `좌우 여백이 범위를 벗어났다: ${padX}px`);
assert.match(mobile, /:is\(th, td\)\.group-start \{\s*padding-left: [\d.]+px;/, '열 묶음 경계는 조금 더 띄운다');

console.log('mobile grid: font scale, 40px rows, column scale across both tables, minimum gaps and head specificity ok');

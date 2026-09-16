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
console.log('mobile grid font scale: variables, four grids, interest head override and desktop defaults ok');

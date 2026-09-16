const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "../portfolio_static");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
const font = fs.readFileSync(path.join(root, "RobotoMono-Variable.woff2"));
assert.equal(font.toString("ascii", 0, 4), "wOF2");
assert.equal(font.readUInt32BE(8), font.length);
assert.match(css, /--chart-num-font: "Roboto Mono",/);
// 히어로(상단 총액·지수)는 고정폭 유지, 사이드바 계좌·관심그룹 숫자는 표와 같은 글꼴.
// #heroValue는 제목 글꼴 규칙에도 나오므로 이 블록만 가리키는 #heroChange를 기준으로 잡는다.
const heroAt = css.indexOf('#heroChange');
const heroBlock = css.slice(heroAt, css.indexOf('}', heroAt));
for (const selector of ['#heroChange', '.hero-index-value', '.hero-index-change']) {
  assert.ok(heroBlock.includes(selector), `Numeric font missing: ${selector}`);
}
assert.ok(heroBlock.includes('font-family: var(--chart-num-font)'));
const sidebarBlock = css.slice(css.indexOf('#accounts .account .meta'), css.indexOf('}', css.indexOf('#accounts .account .meta')));
for (const selector of ['#accounts .account .meta', '#accounts .account-count', '.interest-count']) {
  assert.ok(sidebarBlock.includes(selector), `Sidebar numeric font missing: ${selector}`);
}
assert.ok(sidebarBlock.includes('font-family: var(--grid-num-font)'), '사이드바 숫자가 고정폭으로 돌아갔다');
assert.ok(sidebarBlock.includes('tabular-nums'), '사이드바 자릿수 정렬이 빠졌다');
const holdings = fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8');
assert.ok(holdings.includes('class="account-count"'));
assert.ok(css.includes('#dividendRows > tr:is(.dividend-paid-row, .dividend-upcoming-row) > td:is(:first-child, :nth-child(n+4):nth-child(-n+14))'));
// 표(그리드) 숫자는 고정폭을 쓰지 않는다(2026-09-16) — 본문 글꼴 + tabular-nums로
// 자릿수만 맞춘다. 차트·사이드바·히어로는 --chart-num-font(고정폭) 그대로.
assert.match(css, /--grid-num-font: "Pretendard Variable",/);
assert.doesNotMatch(css.slice(css.indexOf('--grid-num-font')).split(';')[0], /mono/i);
assert.match(css, /#dividendRows \.dividend-month-summary strong\s*\{\s*font-family: var\(--grid-num-font\);\s*font-weight: 500;/);
for (const grid of ['#holdings > tr > td:nth-child(n+3)', '#interestRows > tr > td.numeric-cell']) {
  const at = css.indexOf(grid);
  assert.ok(at > 0, `그리드 숫자 규칙 없음: ${grid}`);
  const block = css.slice(at, css.indexOf('}', at));
  assert.ok(block.includes('font-family: var(--grid-num-font)'), `${grid}가 고정폭을 다시 쓴다`);
  assert.ok(block.includes('tabular-nums'), `${grid}에 tabular-nums가 빠지면 자릿수가 어긋난다`);
}
assert.match(css, /\.trade-timing-value \{ font-family: var\(--grid-num-font\)/);
assert.match(css, /@font-face\s*\{\s*font-family: "Roboto Mono";\s*src: url\("\/static\/RobotoMono-Variable\.woff2"\) format\("woff2"\);\s*font-style: normal;\s*font-weight: 100 700;/);
assert.match(page, /rel="preload" href="\/static\/RobotoMono-Variable\.woff2" as="font" type="font\/woff2" crossorigin/);
assert.doesNotMatch(css + page, /https?:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)/);
assert.match(fs.readFileSync(path.join(root, "RobotoMono-OFL.txt"), "utf8"), /SIL Open Font License/);
console.log(`Local numeric font checks passed (${font.length} bytes).`);

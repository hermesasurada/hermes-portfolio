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
for (const selector of ['#accounts .account .meta', '#accounts .account-count', '#heroValue', '#heroChange', '#heroIndexAsOf time', '.hero-index-value', '.hero-index-change']) {
  const block = css.slice(css.indexOf('#accounts .account .meta'), css.indexOf('}', css.indexOf('#accounts .account .meta')));
  assert.ok(block.includes(selector), `Numeric font missing: ${selector}`);
  assert.ok(block.includes('font-family: var(--chart-num-font)'));
}
const holdings = fs.readFileSync(path.join(root, 'app-holdings.js'), 'utf8');
assert.ok(holdings.includes('class="account-count"'));
assert.ok(holdings.includes('<time>${esc(updated)}</time>'));
assert.ok(css.includes('#dividendRows > tr:is(.dividend-paid-row, .dividend-upcoming-row) > td:is(:first-child, :nth-child(n+4):nth-child(-n+14))'));
assert.match(css, /#dividendRows \.dividend-month-summary strong\s*\{\s*font-family: var\(--chart-num-font\);\s*font-weight: 500;/);
assert.match(css, /@font-face\s*\{\s*font-family: "Roboto Mono";\s*src: url\("\/static\/RobotoMono-Variable\.woff2"\) format\("woff2"\);\s*font-style: normal;\s*font-weight: 100 700;/);
assert.match(page, /rel="preload" href="\/static\/RobotoMono-Variable\.woff2" as="font" type="font\/woff2" crossorigin/);
assert.doesNotMatch(css + page, /https?:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)/);
assert.match(fs.readFileSync(path.join(root, "RobotoMono-OFL.txt"), "utf8"), /SIL Open Font License/);
console.log(`Local numeric font checks passed (${font.length} bytes).`);

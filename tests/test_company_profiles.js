const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '../portfolio_static', f), 'utf8');
const ctx = vm.createContext({window: {addEventListener(){}}, document: {addEventListener(){}},
  URL, esc: s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')});
vm.runInContext(read('app-company-profile.js'), ctx);
const button = ctx.companyProfileButton('A"<', '이름"<');
assert.match(button, /data-company-profile="A&quot;&lt;"/);
assert.match(button, /aria-label="이름&quot;&lt; 소개"/);
assert.match(button, /aria-haspopup="dialog"/);
assert.match(button, /aria-expanded="false"/);
assert.ok(ctx.window.__loaded.has('app-company-profile'));
const source = read('app-company-profile.js');
assert.doesNotMatch(source, /\.innerHTML\s*=/); // All remotely returned text stays text.
assert.match(source, /request !== companyProfileRequest/);
assert.match(source, /url\.protocol !== "https:"/);
assert.match(source, /Date\.now\(\) - cached.at < 300000/);
for (const f of ['app-holdings.js', 'app-interest-columns.js']) {
  assert.match(read(f), /<\/a>\s*\$\{companyProfileButton\(r.ticker, r.name\)\}/);
}
const app = read('app.js');
assert.ok(app.indexOf('const profileBtn') < app.indexOf('const dividendBtn'));
assert.match(read('index.html'), /popover="manual" role="dialog"/);
console.log('Company profiles: escaped sibling buttons, safe text, URL guard, cache, stale response guard and boot marker passed.');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '../portfolio_static', f), 'utf8');
const ctx = vm.createContext({window: {addEventListener(){}}, document: {addEventListener(){}},
  URL, esc: s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')});
vm.runInContext(read('format.js'), ctx);
vm.runInContext(read('app-company-profile.js'), ctx);
const button = ctx.companyProfileLogo({ticker:'A"<', name:'이름"<', logo:{text:'<A',url:'/logo.png"'}});
assert.match(button, /data-company-profile="A&quot;&lt;"/);
assert.match(button, /aria-label="이름&quot;&lt; 소개"/);
assert.match(button, /aria-haspopup="dialog"/);
assert.match(button, /aria-expanded="false"/);
assert.match(button, /class="company-profile-logo"/);
assert.match(button, /class="asset-icon has-image"/);
assert.match(button, /src="\/logo.png&quot;"/);
assert.doesNotMatch(button, /<svg|company-info-btn|<a /);
assert.match(ctx.companyProfileLogo({ticker:'TEST',name:'Test'}), /fallback-text">TE/);
assert.ok(ctx.window.__loaded.has('app-company-profile'));
const source = read('app-company-profile.js');
assert.doesNotMatch(source, /\.innerHTML\s*=/); // All remotely returned text stays text.
assert.match(source, /request !== companyProfileRequest/);
assert.match(source, /url\.protocol !== "https:"/);
assert.match(source, /Date\.now\(\) - cached.at < 300000/);
for (const f of ['app-holdings.js', 'app-interest-columns.js']) {
  assert.match(read(f), /companyProfileLogo\(r\)/);
  assert.doesNotMatch(read(f), /companyProfileButton|ticker-with-info/);
  assert.match(read(f), /class="ticker-link"/);
}
assert.match(read('app-line-chart.js'), /companyProfileLogo\(row\)/);
assert.match(read('styles.css'), /--company-profile-bg: rgba\(/);
assert.match(read('styles.css'), /padding: 12px;[^\n]*background: var\(--company-profile-bg\)/);
assert.match(source, /Math.min\(400, window.innerWidth/);
const app = read('app.js');
assert.ok(app.indexOf('const profileBtn') < app.indexOf('const dividendBtn'));
assert.match(read('index.html'), /popover="manual" role="dialog"/);
console.log('Company profiles: logo trigger, preserved chart links, compact translucent panel, safe text and request guards passed.');

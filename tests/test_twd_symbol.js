// 대만달러는 코드(TWD) 대신 NT$로 표기한다(2026-11-07 사용자 지시).
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);

assert.match(run('money(1234, "TWD")'), /^NT\$1,234/);
assert.match(run('unitMoney(1234, "TWD", "2330.TW")'), /^NT\$1,234/);
assert.match(run('dividendAmountText(3.5, "TWD")'), /^NT\$3\.5/);
assert.match(run('marketCapText(2e12, "TWD")'), /^NT\$2/);
console.log('TWD symbol: money, unit price, dividend, market cap');

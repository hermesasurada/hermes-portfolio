// 관심목록 그룹 아이콘(2026-11-20 디자인 재검토 10): 국가 그룹은 국기, 나머지는 한 벌의 선 아이콘.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const icon = (name, fixed = false, favorite = false) => ctx.interestGroupIcon(name, fixed, favorite);

for (const [name, flag] of [['미국', '🇺🇸'], ['한국', '🇰🇷'], ['일본', '🇯🇵'], ['유럽 종목', '🇪🇺'], ['대만/중국', '🇹🇼']]) {
  assert.equal(icon(name), `<span class="interest-group-flag">${flag}</span>`, name);
}
for (const [name, kind, args] of [['주요 지수', 'index'], ['환율', 'fx'], ['디지털자산', 'crypto'], ['투자종료', 'ended'],
  ['레버리지/롱숏 ETF', 'leverage'], ['반도체 모음', 'folder'], ['찐관심', 'favorite', [false, true]], ['기타', 'more', [true, false]]]) {
  const html = icon(name, ...(args || []));
  assert.match(html, new RegExp(`^<svg class="interest-group-line-icon" data-icon="${kind}" viewBox="0 0 24 24"`), name);
  assert.doesNotMatch(html, /[📈₩₿★✓•…]/u, `${name}: 글자·그림 기호를 섞지 않는다`);
}
// '한국 지수'처럼 나라 이름이 든 지수·환율 그룹은 국기가 아니라 종류 아이콘.
assert.match(icon('한국 지수'), /data-icon="index"/);
console.log('interest group icons ok');

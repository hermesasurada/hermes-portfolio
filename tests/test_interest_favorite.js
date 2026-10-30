// 찐관심 별(2026-10-30): 목록 종목명 앞 ☆/★, 찐관심 그룹은 이름변경·삭제·추가 폼 없음.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
ctx.render = () => {};
ctx.applyInterestWatchlistPayload({groups: [
  {id: 3, name: '미국', items: [{ticker: 'AAPL', name: 'Apple'}]},
  {id: 16, name: '찐관심', favorite: true, items: [{ticker: 'NVDA', name: 'NVIDIA'}]},
], group_aliases: {}});

const on = ctx.favoriteStarMarkup({ticker: 'nvda', name: 'NVIDIA'});
assert.match(on, /class="fav-star on"[^>]*data-favorite-ticker="nvda"[^>]*aria-pressed="true"[^>]*title="찐관심에서 빼기"/);
assert.match(on, />★<\/button>$/);
const off = ctx.favoriteStarMarkup({ticker: 'AAPL', name: 'Apple'});
assert.match(off, /class="fav-star"[^>]*aria-pressed="false"[^>]*title="찐관심에 추가"/);
assert.equal(ctx.favoriteStarMarkup({ticker: '^GSPC', category: 'index'}), '');
assert.equal(ctx.favoriteStarMarkup({ticker: 'USDKRW=X', category: 'fx'}), '');

// 그룹 목록: 찐관심은 ★ 아이콘, 이름변경·삭제 버튼 없음(순서 이동 핸들은 유지)
const fav = ctx.interestGroupMarkup(h.evaluate(ctx, 'interestWatchlists[1]'));
assert.match(fav, /interest-group-icon" aria-hidden="true">★/);
assert.doesNotMatch(fav, /data-interest-rename=|data-interest-group-delete=/);
assert.match(fav, /data-interest-drag="16"/);
assert.match(ctx.interestGroupMarkup(h.evaluate(ctx, 'interestWatchlists[0]')), /data-interest-group-delete="3"/);

// 목록 이름 칸 두 곳 모두 별을 붙인다
const fs = require('node:fs');
const path = require('node:path');
for (const file of ['app-holdings.js', 'app-interest-columns.js']) {
  const source = fs.readFileSync(path.join(__dirname, '../portfolio_static', file), 'utf8');
  assert.match(source, /<span class="ticker-text">\$\{favoriteStarMarkup\(r\)\}/, file);
}
const holdings = fs.readFileSync(path.join(__dirname, '../portfolio_static/app-holdings.js'), 'utf8');
assert.match(holdings, /activeInterestGroup\(\)\?\.fixed \|\| activeInterestGroup\(\)\?\.favorite/);
console.log('Interest favorite: star markup, protected favorite group and hidden add form');

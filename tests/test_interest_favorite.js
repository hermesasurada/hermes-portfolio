// 찐관심 별(2026-10-30): 목록 맨 끝 칸·개별종목 이름 옆 ☆/★, 찐관심 그룹은 이름변경·삭제·추가 폼·차트 팝업 없음.
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

// 관심목록 맨 끝 칸: 별이 삭제 버튼 앞
const deleteColumn = h.evaluate(ctx, 'INTEREST_COLUMNS.find(c => c.key === "delete")');
const usGroup = h.evaluate(ctx, 'interestWatchlists[0]');
assert.match(deleteColumn.cell({ticker: 'AAPL', name: 'Apple'}, usGroup),
  /^<span class="row-actions"><button class="fav-star"[\s\S]*<\/button><button class="interest-row-delete"[^>]*data-interest-main-remove="AAPL"/);
const fs = require('node:fs');
const path = require('node:path');
const holdings = fs.readFileSync(path.join(__dirname, '../portfolio_static/app-holdings.js'), 'utf8');
assert.match(holdings, /<td><span class="row-actions">\$\{favoriteStarMarkup\(r\)\}\$\{r\.is_watchlist \? "" : `<button class="ghost-btn tx-pick"/);
assert.doesNotMatch(holdings + fs.readFileSync(path.join(__dirname, '../portfolio_static/app-interest-columns.js'), 'utf8'),
  /ticker-text">\$\{favoriteStarMarkup/);

// 개별종목 페이지: 이름 옆 별, 차트 관심목록 팝업에는 찐관심 없음
const slot = ctx.document.getElementById('chartFavorite');
ctx.findTickerMeta = t => (t === 'NVDA' ? {ticker: 'NVDA', name: 'NVIDIA', category: 'us'} : null);
h.evaluate(ctx, 'chartTicker = "NVDA"; performanceChartOpen = false;');
ctx.renderChartFavorite();
assert.match(slot.innerHTML, /fav-star on[^>]*data-favorite-ticker="NVDA"/);
h.evaluate(ctx, 'chartTicker = "UNKNOWN";');
ctx.renderChartFavorite();
assert.equal(slot.innerHTML, '');
assert.deepEqual(h.plain(ctx.chartInterestGroups('NVDA')).map(g => g.name), ['미국']);
assert.match(holdings, /activeInterestGroup\(\)\?\.fixed \|\| activeInterestGroup\(\)\?\.favorite/);
console.log('Interest favorite: row-end and chart-page stars, protected favorite group, hidden add form and popup entry');

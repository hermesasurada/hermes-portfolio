// 관심목록 가상 '전체' 그룹(2026-11-21 사용자 지시): 환율 다음, 지수·환율을 뺀 모든 수집 종목, 화면에서만 만든다.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.plain(h.evaluate(ctx, code));

const groups = [
  { id: 1, name: '주요 지수', items: [{ ticker: 'SP500', category: 'index' }] },
  { id: 2, name: '환율', items: [{ ticker: 'USDKRW', category: 'fx' }] },
  { id: 3, name: '찐관심', favorite: true, items: [{ ticker: 'NVDA', category: 'overseas' }] },
  { id: 4, name: '미국', items: [{ ticker: 'NVDA', category: 'overseas' }, { ticker: 'AAPL', category: 'overseas' }] },
  { id: 5, name: '디지털자산', items: [{ ticker: 'BTC', category: 'crypto' }] },
  { id: 0, name: '기타', fixed: true, items: [{ ticker: 'ASX', category: 'overseas' }] },
];
h.evaluate(ctx, `__g = ${JSON.stringify(groups)}`);
const out = run('withAllInterestGroup(__g)');
assert.deepEqual(out.map(g => g.name), ['주요 지수', '환율', '전체', '찐관심', '미국', '디지털자산', '기타']);
const all = out[2];
assert.equal(all.id, -1);
assert.equal(all.fixed, true);
assert.equal(all.all, true);
assert.deepEqual(all.items.map(i => i.ticker), ['NVDA', 'AAPL', 'BTC', 'ASX']);   // 중복 없이, 지수·환율 제외
// 다시 불러도 '전체'가 둘이 되지 않는다.
h.evaluate(ctx, '__g2 = withAllInterestGroup(__g)');
assert.equal(run('withAllInterestGroup(__g2).filter(g => g.all).length'), 1);
// '기타' 찾기는 '전체'를 잡지 않는다.
h.evaluate(ctx, 'interestWatchlists = withAllInterestGroup(__g)');
assert.equal(run('otherInterestGroup().name'), '기타');
assert.equal(run('interestGroupIconKind("전체", true, false)'), 'all');
// 서버 응답(공시 수집이 읽는 API)에는 넣지 않는다.
assert.doesNotMatch(h.readStatic('../portfolio_core/interest_watchlists.py'), /"전체"/);
// 행에는 별만(삭제·수집 제외 버튼 없음).
const cells = run(`INTEREST_COLUMNS.find(c => c.key === 'delete').cell({ticker:'AAPL', name:'Apple'}, {id:-1, all:true, fixed:true})`);
assert.doesNotMatch(cells, /interest-row-delete/);
console.log('interest all group ok');

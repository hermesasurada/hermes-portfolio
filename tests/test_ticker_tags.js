// 종목 태그: 입력 정리, OR 필터, 목록 칩(+n), 필터 선택 저장·복원, 사라진 태그 선택 정리.
const assert = require('node:assert/strict');
const h = require('./harness');
const ctx = h.loadScripts(h.createContext());
const run = code => h.evaluate(ctx, code);
const json = code => JSON.parse(run(`JSON.stringify(${code})`));

assert.deepEqual(json('parseTagInput("#반도체 #CPU, 파운드리 #cpu ##AI")'), ['반도체', 'CPU', '파운드리', 'AI']);

run(`setTagData({tags: {INTC: ["반도체","CPU","파운드리","미국"], NVDA: ["반도체","AI"], KO: ["음료"]},
  all: [{tag:"반도체",count:2},{tag:"CPU",count:1},{tag:"파운드리",count:1},{tag:"미국",count:1},{tag:"AI",count:1},{tag:"음료",count:1}]})`);
assert.deepEqual(json('tagsFor("intc")'), ['반도체', 'CPU', '파운드리', '미국']);
ctx.__rows = [{ticker: 'INTC'}, {ticker: 'NVDA'}, {ticker: 'KO'}, {ticker: 'AAPL'}];
// 선택 없음 = 전부
assert.equal(run('applyTagFilter(__rows).length'), 4);
// OR: 하나라도 가진 종목
run('tagFilterSelection.add("AI"); tagFilterSelection.add("음료")');
assert.deepEqual(json('applyTagFilter(__rows).map(r => r.ticker)'), ['NVDA', 'KO']);
// 선택은 이 브라우저에 저장되고 복원된다
run('saveTagFilterSelection(); tagFilterSelection.clear(); restoreTagFilterSelection()');
assert.deepEqual(json('[...tagFilterSelection].sort()'), ['AI', '음료']);
// 더는 없는 태그는 선택에서 빠진다
run('setTagData({tags: {NVDA: ["AI"]}, all: [{tag:"AI",count:1}]})');
assert.deepEqual(json('[...tagFilterSelection]'), ['AI']);
// 목록 칩: 3개까지 + 나머지 수
run('setTagData({tags: {INTC: ["반도체","CPU","파운드리","미국"]}, all: []})');
const chips = run('rowTagChips("INTC")');
assert.equal((chips.match(/class="tag-chip"/g) || []).length, 3);
assert.match(chips, /\+1</);
assert.match(chips, /title="#반도체 #CPU #파운드리 #미국"/);
assert.equal(run('rowTagChips("AAPL")'), '');
console.log('ticker tags ok');

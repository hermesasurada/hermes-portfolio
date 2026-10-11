// 공용 테스트 도구 자체의 계약.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');

// 1) 로드 순서는 index.html에서 읽는다 — 파일마다 로드 마커가 있고 state.js가 맨 앞, app.js가 맨 뒤.
assert.ok(h.SCRIPT_ORDER.length >= 20 && h.SCRIPT_ORDER[0] === 'state.js' && h.SCRIPT_ORDER.at(-1) === 'app.js', String(h.SCRIPT_ORDER));
// 1b) mediaBlocks는 같은 질의의 블록을 전부, 중괄호 깊이로 자른다
const sample = '.a{x:1} @media (max-width: 980px){.b{y:2} @supports (c:d){.c{z:3}}} .d{w:4} @media (max-width: 980px){.e{v:5}}';
assert.deepEqual(h.mediaBlocks(sample, '(max-width: 980px)').map(b => b.text.trim()), ['.b{y:2} @supports (c:d){.c{z:3}}', '.e{v:5}']);
assert.equal(h.withoutMediaBlocks(sample, '(max-width: 980px)').replace(/\s+/g, ' ').trim(), '.a{x:1} .d{w:4}');

// 2) 모든 스크립트가 가짜 브라우저 환경에서 통째로 로드된다(최상위 코드가 요소 없음으로 죽지 않는다).
const ctx = h.loadScripts(h.createContext());
const loaded = h.evaluate(ctx, 'window.__loaded');
assert.ok(loaded.size >= 20, `로드 마커가 모자라다: ${loaded.size}`);

// 3) 소스를 글자 위치로 잘라 실행하는 테스트가 다시 생기지 않는다(함수 순서만 바뀌어도 깨졌다).
//    소스 문자열을 '검사'하는 slice는 괜찮다 — 잘라낸 코드를 vm으로 '실행'하는 것만 막는다.
for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith('.js'))) {
  const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
  assert.doesNotMatch(text, /runInContext\(\s*[\w.]+\.slice\(/, `${file}: 소스를 잘라 실행한다 — harness.loadScripts를 쓸 것`);
}
console.log('Harness: script order matches index.html, all scripts load, no slice-and-run tests');

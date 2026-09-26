// 공용 테스트 도구 자체의 계약.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');

// 1) 로드 순서는 index.html의 <script src> 순서와 같아야 한다 — 어긋나면 실제 브라우저와 다른 전역 상태에서 테스트한다.
const html = h.readStatic('index.html');
const htmlOrder = [...html.matchAll(/<script src="\/static\/([^"]+)"/g)].map(m => m[1]);
assert.equal(JSON.stringify(h.SCRIPT_ORDER), JSON.stringify(htmlOrder), 'harness SCRIPT_ORDER가 index.html과 다르다');

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

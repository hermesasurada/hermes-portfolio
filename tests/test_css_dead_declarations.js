// 같은 문맥(@media 등)·같은 선택자·같은 속성이 뒤에서 다시 선언돼 절대 적용되지 않는 '죽은 선언'이 없어야 한다.
// 앞쪽 값을 고쳐도 화면이 안 바뀌는 함정이었다(2026-09-26에 115개 제거, 계산 스타일 전후 비교로 무변화 확인).
const assert = require('node:assert/strict');
const h = require('./harness');
const css = h.readStatic('styles.css');

function splitTop(head) {
  const out = []; let depth = 0, cur = '';
  for (const c of head) {
    if ('(['.includes(c)) depth++;
    else if (')]'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

// 아주 작은 파서 — 규칙(문맥, 선택자들, 선언들)만 뽑는다. 문자열·괄호·주석을 건너뛴다.
function parse(text) {
  const rules = []; const stack = []; let i = 0; const n = text.length;
  const skip = j => { for (;;) { if (text.startsWith('/*', j)) { const k = text.indexOf('*/', j + 2); j = k < 0 ? n : k + 2; } else if (j < n && /\s/.test(text[j])) j++; else return j; } };
  const scan = (j, stops) => { let depth = 0, q = null;
    while (j < n) { const c = text[j];
      if (q) { if (c === '\\') { j += 2; continue; } if (c === q) q = null; }
      else if (text.startsWith('/*', j)) { const k = text.indexOf('*/', j + 2); j = k < 0 ? n : k + 2; continue; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++; else if (c === ')') depth--;
      else if (depth === 0 && stops.includes(c)) return j;
      j++; }
    return j; };
  while (i < n) {
    i = skip(i); if (i >= n) break;
    if (text[i] === '}') { stack.pop(); i++; continue; }
    const j = scan(i, '{;'); const head = stripComments(text.slice(i, j)).trim();
    if (text[j] === ';') { i = j + 1; continue; }
    if (/^@(-webkit-)?keyframes/.test(head)) { let d = 0, k = j; for (; k < n; k++) { if (text[k] === '{') d++; else if (text[k] === '}' && --d === 0) break; } i = k + 1; continue; }
    if (head.startsWith('@') && !head.startsWith('@font-face')) { stack.push(head.replace(/\s+/g, ' ')); i = j + 1; continue; }
    const decls = []; let k = j + 1, start = k;
    for (;;) { const e = scan(k, ';}'); const raw = stripComments(text.slice(start, e));
      if (raw.includes(':')) decls.push({ prop: raw.split(':')[0].trim().toLowerCase(), important: /!\s*important\s*$/i.test(raw.trim()), line: text.slice(0, start).split('\n').length + (raw.match(/^\s*\n/) ? 1 : 0) });
      if (e >= n || text[e] === '}') { k = e; break; } k = start = e + 1; }
    if (!head.startsWith('@')) rules.push({ ctx: stack.join(' | '), sels: splitTop(head), decls });
    i = k + 1;
  }
  return rules;
}

const rules = parse(css);
// 구형 브라우저용 대체값으로 일부러 남긴 것(뒤에서 100dvh로 덮는 100vh).
const ALLOWED = new Set(['max-height|calc(100vh - 10px)']);
const later = new Map(); const dead = [];
for (let r = rules.length - 1; r >= 0; r--) {
  const rule = rules[r]; const inRule = new Map();
  for (const d of [...rule.decls].reverse()) {
    const imp = d.important ? 1 : 0;
    const overridden = rule.sels.every(sel => (later.get(`${rule.ctx}\u0000${sel}\u0000${d.prop}`) ?? -1) >= imp) || (inRule.get(d.prop) ?? -1) >= imp;
    if (overridden) dead.push({ ...d, sels: rule.sels.join(', '), ctx: rule.ctx });
    inRule.set(d.prop, Math.max(inRule.get(d.prop) ?? -1, imp));
  }
  for (const d of rule.decls) for (const sel of rule.sels) {
    const key = `${rule.ctx}\u0000${sel}\u0000${d.prop}`;
    later.set(key, Math.max(later.get(key) ?? -1, d.important ? 1 : 0));
  }
}
const lines = css.split('\n');
const real = dead.filter(d => !ALLOWED.has(`${d.prop}|${(lines[d.line - 1] || '').split(':').slice(1).join(':').replace(/;.*$/, '').trim()}`));
assert.equal(real.length, 0, '뒤에서 덮여 적용되지 않는 선언:\n' + real.slice(0, 10).map(d => `  styles.css:${d.line} ${d.prop} — ${d.sels} ${d.ctx}`).join('\n'));
console.log(`CSS dead declarations: 0 across ${rules.length} rules (1 intentional fallback allowed)`);

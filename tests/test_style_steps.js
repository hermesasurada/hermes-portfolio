// 글자 크기·굵기·분기점의 단계(2026-11-20 디자인 재검토 09).
// styles.css에 새 값을 하나씩 더하다 보니 크기 36가지·굵기 9단계·좁은 화면 분기점 9가지까지 늘었다.
// 여기 적힌 값만 쓴다 — 새 값이 필요하면 가까운 단계를 쓰고, 정말 필요할 때만 이 목록을 고친다.
const assert = require('node:assert/strict');
const h = require('./harness');

const css = h.readStatic('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const used = pattern => [...new Set([...css.matchAll(pattern)].map(m => m[1]))].sort((a, b) => Number(a) - Number(b));

// 굵기 4단계. @font-face의 범위 표기(100 900 등)는 굵기 지정이 아니라 글꼴이 가진 범위다.
const weights = used(/font-weight:\s*(\d+)\s*[;}]/g);
assert.deepEqual(weights, ['400', '500', '600', '700'], `굵기는 400·500·600·700만: ${weights}`);

// px로 직접 적는 글자 크기. 표·차트의 작은 글자(8~10px)와 본문(10.5~14px), 제목(15~28px).
const ALLOWED_SIZES = ['8', '9', '9.5', '10', '10.5', '11', '11.5', '12', '12.5', '13', '14', '15', '16', '17', '20', '24', '28'];
const sizes = used(/font-size:\s*([\d.]+)px/g);
const extra = sizes.filter(size => !ALLOWED_SIZES.includes(size));
assert.deepEqual(extra, [], `단계에 없는 글자 크기: ${extra.join(', ')}px`);

// 좁은 화면 분기점 4단계: 345(로고 숨김) · 480(상단 아이콘 버튼) · 700(팝업·표 압축) · 980(한 단 배치).
const breakpoints = used(/@media[^{]*\(max-width:\s*(\d+)px\)/g);
assert.deepEqual(breakpoints, ['345', '480', '700', '980', '1599'], `좁은 화면 분기점: ${breakpoints}`);   // 1599는 PC 도구 줄 전용(min-width: 981px와 함께)
const minWidths = used(/@media[^{]*\(min-width:\s*(\d+)px\)/g);
assert.deepEqual(minWidths, ['981'], `PC 분기점: ${minWidths}`);
console.log('style steps ok');

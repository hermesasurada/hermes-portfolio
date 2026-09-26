// 공용 테스트 도구 — 프런트 스크립트를 '파일 통째로' 가짜 브라우저 환경에 불러온다.
//
// 예전 테스트는 소스를 indexOf('function foo(')로 잘라 필요한 구간만 vm에 넣었다.
// 함수 순서만 바뀌어도 깨지고, 리팩토링 때마다 테스트부터 무너졌다. 여기서는
// index.html과 같은 순서로 파일 전체를 불러오고, 테스트는 필요한 전역만 덮어쓴다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '../portfolio_static');
// index.html의 <script src> 순서 그대로 — 로드 순서가 바뀌면 여기도 함께 바꾼다.
const SCRIPT_ORDER = [
  'state.js', 'format.js', 'api.js', 'chart-utils.js', 'app-consensus.js', 'app-company-profile.js',
  'app-interest-columns.js', 'app-tabs.js', 'app-charts.js', 'app-holdings.js', 'app-chart-scale.js',
  'app-chart-metrics.js', 'app-line-chart.js', 'app-chart-compare.js', 'app-transactions.js',
  'app-trade-controls.js', 'app-watchlist.js', 'app-interest-watchlists.js', 'app-ticker-search.js',
  'app-calendar.js', 'app-cash-flows.js', 'app.js',
];

function readStatic(name) {
  return fs.readFileSync(path.join(STATIC, name), 'utf8');
}

function classList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach(n => set.add(n)),
    remove: (...names) => names.forEach(n => set.delete(n)),
    contains: n => set.has(n),
    toggle(n, force) {
      const on = force === undefined ? !set.has(n) : Boolean(force);
      if (on) set.add(n); else set.delete(n);
      return on;
    },
    get length() { return set.size; },
    toString: () => [...set].join(' '),
    values: () => set.values(),
  };
}

// 조작은 기록만 하고 조회는 무해한 기본값을 돌려주는 가짜 요소.
function element(props = {}) {
  const el = {
    tagName: 'DIV', nodeType: 1, dataset: {}, attrs: {}, children: [], childNodes: [],
    style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; }, getPropertyValue(k) { return this[k] ?? ''; } },
    classList: classList(), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
    offsetParent: null, offsetHeight: 0, offsetWidth: 0, clientWidth: 0, clientHeight: 0, scrollWidth: 0, scrollHeight: 0, scrollLeft: 0, scrollTop: 0,
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }, matches() { return false; },
    appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); }, prepend() {}, remove() {},
    replaceChildren(...c) { this.children = c; }, insertAdjacentHTML() {}, contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
    getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; },
    focus() {}, blur() {}, click() {}, scrollTo() {}, scrollIntoView() {}, setPointerCapture() {}, releasePointerCapture() {},
    ...props,
  };
  return el;
}

// getElementById는 id마다 같은 가짜 요소를 돌려준다(app.js 부트스트랩은 요소가 있다고 가정한다).
// 테스트는 byId에 원하는 요소를 미리 넣거나 getElementById 자체를 덮어쓴다.
function fakeDocument(overrides = {}) {
  const byId = new Map();
  return {
    byId,
    body: element(), documentElement: element(), head: element(),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, element({ id }));
      return byId.get(id);
    },
    // querySelector도 선택자마다 같은 가짜 요소 — 없음(null)을 검사하려는 테스트는 덮어쓴다.
    bySelector: new Map(),
    querySelector(selector) {
      if (!this.bySelector.has(selector)) this.bySelector.set(selector, element({ selector }));
      return this.bySelector.get(selector);
    },
    querySelectorAll: () => [],
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    createElement: tag => element({ tagName: String(tag).toUpperCase() }),
    createElementNS: (_, tag) => element({ tagName: String(tag).toUpperCase() }),
    createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
    createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', hidden: false,
    ...overrides,
  };
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k), clear: () => data.clear(), key: i => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

// globals: 컨텍스트에 먼저 심을 전역(스크립트가 로드 중에 읽는 값). 로드 후에 바꿀 것은 ctx에 직접 대입.
function createContext(globals = {}) {
  const document = globals.document || fakeDocument();
  const window = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    location: { hash: '', href: 'http://localhost:8765/', origin: 'http://localhost:8765', pathname: '/', search: '', hostname: 'localhost', reload() {} },
    history: { replaceState() {}, pushState() {} },
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    __loaded: new Set(),
  };
  const ctx = {
    console, Intl, Math, Date, JSON, Number, String, Boolean, Array, Object, Map, Set, WeakMap, WeakSet, Promise,
    RegExp, Error, TypeError, Symbol, parseFloat, parseInt, isFinite, isNaN, encodeURIComponent, decodeURIComponent,
    URLSearchParams, URL, AbortController, structuredClone, queueMicrotask,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    // 영원히 대기 — 거절하면 로드 때 app.js가 시작한 비동기 흐름이 테스트 도중 오류 경로로 튄다.
    // 네트워크 응답이 필요한 테스트는 ctx.fetch를 직접 덮어쓴다.
    fetch: () => new Promise(() => {}),
    performance: { now: () => Date.now() },
    navigator: { userAgent: 'node', maxTouchPoints: 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    CSS: { supports: () => false, escape: s => String(s) },
    ...window, window, document, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    location: window.location, history: window.history,
    ...globals,
  };
  ctx.window = Object.assign(ctx.window, { document: ctx.document });
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

// files를 주면 그 파일만(순서는 SCRIPT_ORDER 기준으로 정렬), 없으면 전부 불러온다.
// 파일 안의 최상위 const/let도 같은 스크립트 스코프에 남도록 한 번에 이어 붙여 실행한다.
function loadScripts(ctx, files = SCRIPT_ORDER) {
  const wanted = new Set(files);
  const ordered = SCRIPT_ORDER.filter(f => wanted.has(f)).concat(files.filter(f => !SCRIPT_ORDER.includes(f)));
  for (const file of ordered) {
    vm.runInContext(readStatic(file), ctx, { filename: file });
  }
  return ctx;
}

// 스크립트 스코프(최상위 let/const)의 값을 읽거나 바꿀 때 쓴다 — ctx 속성으로는 보이지 않는다.
function evaluate(ctx, code) {
  return vm.runInContext(code, ctx);
}

// vm 컨텍스트에서 만든 객체는 realm이 달라 assert.deepStrictEqual이 실패한다 — JSON으로 옮겨 비교.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = { SCRIPT_ORDER, STATIC, readStatic, element, classList, fakeDocument, memoryStorage, createContext, loadScripts, evaluate, plain };

// PC 종목 차트는 사이드바·전광판을 접은 한 단(2026-11-20 디자인 재검토 04). 성과 차트·모바일은 두 단 그대로.
const assert = require('node:assert/strict');
const h = require('./harness');

const css = h.readStatic('styles.css');
const pc = h.mediaBlocks(css, '(min-width: 981px)').map(block => block.text).join('\n');
assert.match(pc, /\.layout\.ticker-chart \{ grid-template-columns: minmax\(0, 1fr\); \}/);
assert.match(pc, /\.layout\.ticker-chart > \.side-col,\s*\.layout\.ticker-chart #heroStrip \{ display: none; \}/);
const outside = css.replace(/@media \(min-width: 981px\) \{[\s\S]*?\n\}\n/g, '');
assert.doesNotMatch(outside, /\.layout\.ticker-chart/, '모바일에는 적용하지 않는다');

const js = h.readStatic('app-holdings.js');
assert.match(js, /classList\.toggle\("ticker-chart", Boolean\(chartTicker\) && !performanceChartOpen\)/);
console.log('ticker chart layout ok');

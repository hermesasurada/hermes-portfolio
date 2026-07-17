const autoRefreshStorage = {
  enabled: "portfolio.autoRefresh.enabled",
  interval: "portfolio.autoRefresh.intervalMinutes"
};
const usPriceStorage = {
  extended: "portfolio.usPrice.extendedHours"
};
const detailStorage = {
  fxAdjusted: "portfolio.detail.fxAdjusted",
  showIndexes: "portfolio.detail.showIndexes",
  interestHeldOnly: "portfolio.detail.interestHeldOnly",
  currencyFilter: "portfolio.detail.currencyFilter",
  chartInterval: "portfolio.chart.interval",
  chartLogScale: "portfolio.chart.logScale",
  chartSmoothLines: "portfolio.chart.smoothLines",
  chartShowBollinger: "portfolio.chart.showBollinger",
  chartShowIchimoku: "portfolio.chart.showIchimoku",
  chartShowBuys: "portfolio.chart.showBuys",
  chartShowSells: "portfolio.chart.showSells"
};
const sidebarStorage = {
  activeTab: "portfolio.sidebar.activeTab",
  interestGroupId: "portfolio.sidebar.interestGroupId"
};
const defaultSortDir = {
  name: 1,
  sector: 1,
  display_change_pct: -1,
  extended_change_pct: -1,
  change_krw: -1,
  qty: -1,
  current_price: -1,
  current_price_krw: -1,
  value: -1,
  value_krw: -1,
  weight_pct: -1,
  next_earnings_date: 1,
  pay_date: 1,
  ex_date: 1,
  member: 1,
  ticker: 1,
  amount: -1,
  gross: -1,
  tax: -1,
  tax_rate: -1,
  net: -1,
  fx_rate: -1,
  net_krw: -1,
  market_cap_usd: -1,
  dividend_yield: -1,
  dividend_growth_5y: -1,
  rsi_day: -1,
  rsi_week: -1,
  rsi_month: -1,
  bb_day: -1,
  bb_week: -1,
  bb_month: -1,
  trailing_pe: -1,
  forward_pe: -1,
  price_to_book: -1,
  beta: -1,
  beta_adj: -1,
  drawdown_52w: -1,
  perf_1m: -1,
  perf_3m: -1,
  perf_6m: -1,
  perf_ytd: -1,
  perf_1y: -1,
  perf_3y: -1,
  perf_5y: -1
};
function storageGet(key) {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // 자동갱신 자체는 저장소 없이도 현재 화면에서 동작한다.
  }
}

function isIndexRow(row) {
  return (row?.category || row?.assetClass || row?.asset_class) === "index";
}

function tableRowClass(row) {
  return isIndexRow(row) ? "index-row" : "";
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("state");

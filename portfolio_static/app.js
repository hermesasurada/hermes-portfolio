let data = null;
let selectedAccounts = new Set();
let selectionMode = "all";
let sortState = {
  detail: { key: "value_krw", dir: -1 },
  stats: { key: "market_cap_usd", dir: -1 },
  dividend: { key: "pay_date", dir: 1 },
};
let sortKey = sortState.detail.key;
let sortDir = sortState.detail.dir;
let selectedTrade = { accountId: "", ticker: "" };
let autoRefreshTimer = null;
let usPriceTimer = null;
let loadInFlight = null;
let transactionsExpanded = false;
let activeDetailTab = "detail";
let statsData = {};
let statsLoadKey = "";
let statsInFlight = null;
let statsFetchedTickers = new Set();
let dividendData = null;
let dividendLoadKey = "";
let dividendInFlight = null;
let chartTicker = null;
let chartLoadInFlight = null;
let chartPayload = null;
let chartRange = "6m";
let chartCustomRange = { start: "", end: "" };
let chartComparePayloads = [];
let performanceChartOpen = false;
let performancePayload = null;
let performanceLoadInFlight = null;
let performanceIndexes = { SP500: true, NASDAQ: true, KOSPI: true };
let mobileAccountsCollapsed = true;
let watchLookupResult = null;
let watchPending = [];
let transactionRows = [];
let transactionPage = 1;
const transactionPageSize = 10;

const chartRanges = [
  { key: "1m", label: "1개월", months: 1 },
  { key: "3m", label: "3개월", months: 3 },
  { key: "6m", label: "6개월", months: 6 },
  { key: "1y", label: "1년", months: 12 },
  { key: "ytd", label: "YTD", ytd: true },
  { key: "3y", label: "3년", months: 36 },
  { key: "5y", label: "5년", months: 60 },
];
const chartCompareLimit = 10;
const chartCompareColors = ["var(--brand)", "#ea4335", "#34a853", "#fbbc04", "#9333ea", "#06b6d4", "#f97316", "#64748b", "#be123c", "#16a34a", "#7c3aed"];
const detailSortKeys = new Set(["name", "display_change_pct", "extended_change_pct", "change_krw", "qty", "current_price", "current_price_krw", "value", "value_krw", "weight_pct", "next_earnings_date"]);
const statsSortKeys = new Set(["name", "market_cap_usd", "dividend_yield", "rsi_day", "rsi_week", "rsi_month", "bb_day", "bb_week", "bb_month", "trailing_pe", "forward_pe", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y", "perf_3y", "perf_5y"]);
const dividendSortKeys = new Set(["pay_date", "target", "ticker", "name", "amount", "qty", "gross", "tax_rate", "net", "fx_rate", "net_krw"]);

// app-holdings.js loaded separately.
// app-line-chart.js loaded separately.
// app-transactions.js loaded separately.
const THEME_KEY = "theme";
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_META = {
  auto: { label: "자동", icon: "◐" },
  light: { label: "라이트", icon: "☀" },
  dark: { label: "다크", icon: "☾" },
};

function currentThemePref() {
  const pref = storageGet(THEME_KEY);
  return THEME_ORDER.includes(pref) ? pref : "auto";
}

function prefersDark() {
  return Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "auto" && prefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const btn = document.getElementById("themeToggle");
  if (btn) {
    const meta = THEME_META[pref] || THEME_META.auto;
    btn.innerHTML = `<span aria-hidden="true">${meta.icon}</span>${meta.label}`;
    btn.title = `테마: ${meta.label}${pref === "auto" ? ` (현재 ${dark ? "다크" : "라이트"})` : ""}`;
  }
}

function initThemeControl() {
  applyTheme(currentThemePref());
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(currentThemePref()) + 1) % THEME_ORDER.length];
      storageSet(THEME_KEY, next);
      applyTheme(next);
    });
  }
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (currentThemePref() === "auto") applyTheme("auto");
    });
  }
}

function initDataHelpModal() {
  const modal = document.getElementById("dataHelpModal");
  const open = document.getElementById("dataHelpOpen");
  const close = document.getElementById("dataHelpClose");
  if (!modal || !open || !close) return;
  open.addEventListener("click", () => modal.showModal());
  close.addEventListener("click", () => modal.close());
}

function render() {
  renderAccounts();
  const rows = filteredRows();
  renderSummary(rows);
  renderTable();
  renderTradeControls();
  syncMobileCollapsePanels();
}

async function load() {
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
    data = await apiFetchPortfolio(usExtendedEnabled());
    if (!document.getElementById("tradeDate").value) document.getElementById("tradeDate").value = todayLocal();
    renderCurrencyFilter();
    render();
    if (transactionsExpanded) loadTransactions().catch(() => {});
  })();
  try {
    await loadInFlight;
  } finally {
    loadInFlight = null;
  }
}

function autoRefreshMinutes() {
  const input = document.getElementById("autoRefreshInterval");
  const value = Number(input.value);
  const minutes = Number.isFinite(value) ? Math.min(1440, Math.max(1, Math.round(value))) : 5;
  input.value = String(minutes);
  return minutes;
}

function saveAutoRefreshSettings() {
  storageSet(autoRefreshStorage.enabled, String(document.getElementById("autoRefreshToggle").checked));
  storageSet(autoRefreshStorage.interval, String(autoRefreshMinutes()));
}

function renderAutoRefreshControl() {
  document.querySelector(".auto-refresh-control").classList.toggle("enabled", document.getElementById("autoRefreshToggle").checked);
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const enabled = document.getElementById("autoRefreshToggle").checked;
  if (!enabled) return;
  const intervalMs = autoRefreshMinutes() * 60 * 1000;
  autoRefreshTimer = setInterval(() => {
    load().catch(err => showTradeStatus(err.message || String(err), true));
  }, intervalMs);
}

function initAutoRefreshControls() {
  const toggle = document.getElementById("autoRefreshToggle");
  const interval = document.getElementById("autoRefreshInterval");
  interval.value = storageGet(autoRefreshStorage.interval) || interval.value || "5";
  toggle.checked = storageGet(autoRefreshStorage.enabled) === "true";
  const apply = () => {
    saveAutoRefreshSettings();
    renderAutoRefreshControl();
    scheduleAutoRefresh();
  };
  toggle.addEventListener("change", apply);
  interval.addEventListener("change", apply);
  interval.addEventListener("blur", apply);
  renderAutoRefreshControl();
  scheduleAutoRefresh();
}

function initUsPriceControls() {
  const toggle = document.getElementById("usExtendedToggle");
  toggle.checked = storageGet(usPriceStorage.extended) === "true";
  toggle.addEventListener("change", () => {
    storageSet(usPriceStorage.extended, String(toggle.checked));
    load().catch(err => showTradeStatus(err.message || String(err), true));
  });
}

// app-trade-controls.js loaded separately.
// app-watchlist.js loaded separately.
document.getElementById("chartBack").addEventListener("click", closeChart);
document.getElementById("performanceOpen").addEventListener("click", () => {
  history.pushState(null, "", "#performance");
  openPerformanceChart();
});
document.getElementById("performanceDetailToggle").addEventListener("change", () => {
  syncFilterToggleControls();
  if (performanceChartOpen) renderPerformanceChart(performancePayload);
});
document.getElementById("accountCollapseToggle").addEventListener("click", () => {
  mobileAccountsCollapsed = !mobileAccountsCollapsed;
  syncMobileCollapsePanels();
});
// Make the whole panel header line a hit target for its collapse caret. Clicking
// anywhere on the head fires the caret button (its handler stays the single
// source of truth). Ignore clicks on the caret itself (its own handler already
// ran) or on interactive children, and only act while the caret is visible
// (mobile breakpoint — getComputedStyle display !== "none").
[["accountPanel", ".mobile-panel-head", "accountCollapseToggle"]].forEach(([panelId, headSel, btnId]) => {
  const head = document.getElementById(panelId)?.querySelector(headSel);
  const btn = document.getElementById(btnId);
  if (!head || !btn) return;
  head.addEventListener("click", (e) => {
    if (e.target.closest(".mobile-collapse-toggle, a, input, label, .pill")) return;
    if (getComputedStyle(btn).display === "none") return;  // desktop: caret hidden
    btn.click();
  });
});
document.getElementById("transactionToggle").addEventListener("click", () => {
  setTransactionsExpanded(!transactionsExpanded, true);
});
document.querySelector(".transaction-panel > .toolbar").addEventListener("click", event => {
  if (event.target.closest("button, a, input, select, label")) return;
  setTransactionsExpanded(!transactionsExpanded, true);
});
document.getElementById("tradeAccount").addEventListener("change", () => {
  selectedTrade.accountId = document.getElementById("tradeAccount").value;
  renderTradeControls();
  loadTransactions().catch(showTradeError);
});
document.getElementById("tradeTicker").addEventListener("change", () => {
  selectedTrade.ticker = document.getElementById("tradeTicker").value.trim().toUpperCase();
  document.getElementById("tradeTicker").value = selectedTrade.ticker;
  applyTradeHoldingDefaults(true);
  loadTransactions().catch(showTradeError);
});
document.getElementById("tradeForm").addEventListener("submit", async event => {
  event.preventDefault();
  showTradeStatus("저장 중...");
  const payload = {
    account_id: document.getElementById("tradeAccount").value,
    ticker: document.getElementById("tradeTicker").value.trim().toUpperCase(),
    name: document.getElementById("tradeName").value.trim(),
    side: document.getElementById("tradeSide").value,
    qty: document.getElementById("tradeQty").value,
    price: document.getElementById("tradePrice").value,
    currency: document.getElementById("tradeCurrency").value,
    trade_date: document.getElementById("tradeDate").value,
    apply_to_holdings: document.getElementById("tradeApply").checked,
    note: ""
  };
  try {
    const result = await apiSaveTransaction(payload);
    data = result.portfolio;
    selectedTrade = { accountId: String(payload.account_id), ticker: payload.ticker };
    document.getElementById("tradeQty").value = "";
    setTradeApply(true);
    render();
    await loadTransactions();
    showTradeStatus("저장됨");
  } catch (err) {
    showTradeError(err);
  }
});
document.getElementById("activeOnlyToggle").addEventListener("change", () => {
  syncFilterToggleControls();
  render();
});
document.getElementById("fxAdjustedToggle").checked = storageGet(detailStorage.fxAdjusted) === "true";
document.getElementById("fxAdjustedToggle").addEventListener("change", () => {
  storageSet(detailStorage.fxAdjusted, String(document.getElementById("fxAdjustedToggle").checked));
  syncFilterToggleControls();
  render();
});
document.getElementById("currencyFilter").value = storageGet(detailStorage.currencyFilter) || "all";
document.getElementById("currencyFilter").addEventListener("change", () => {
  storageSet(detailStorage.currencyFilter, currencyFilterValue());
  syncFilterToggleControls();
  render();
});
document.addEventListener("click", event => {
  const btn = event.target.closest?.(".ticker-link");
  if (!btn) return;
  event.preventDefault();
  history.pushState(null, "", chartHref(btn.dataset.chartTicker));
  openChart(btn.dataset.chartTicker);
});
window.addEventListener("hashchange", syncChartRoute);
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const previousTab = activeDetailTab;
    const nextTab = btn.dataset.tab || "detail";
    if (previousTab === "detail" && nextTab === "stats") {
      sortState.stats = { ...sortState.detail };
    }
    activeDetailTab = nextTab;
    syncSortGlobals(activeDetailTab);
    renderTable();
  });
});
document.querySelectorAll("th[data-key]").forEach(th => {
  th.addEventListener("click", () => {
    setCurrentSort(th.dataset.key);
    renderTable();
  });
});
initAutoRefreshControls();
initUsPriceControls();
initThemeControl();
initDataHelpModal();
initWatchlistControls();
initChartRangeModal();
initTradeSideToggle();
initTradeApplyToggle();
setTransactionsExpanded(false);
load().then(syncChartRoute).catch(err => showTradeStatus(err.message || String(err), true));

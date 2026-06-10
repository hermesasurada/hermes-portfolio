let data = null;
let selectedAccounts = new Set();
let selectionMode = "all";
let defaultAccountSelectionApplied = false;
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
let collapsedDividendMonths = new Set();
let chartTicker = null;
let chartLoadInFlight = null;
let chartPayload = null;
let chartRange = "6m";
let chartInterval = "day";
let chartLogScale = false;
let chartSmoothLines = true;
let chartShowBuys = true;
let chartShowSells = true;
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
let editingTxId = null;
const transactionPageSize = 10;

const chartRanges = [
  { key: "1m", label: "1개월", months: 1 },
  { key: "3m", label: "3개월", months: 3 },
  { key: "6m", label: "6개월", months: 6 },
  { key: "1y", label: "1년", months: 12 },
  { key: "ytd", label: "YTD", ytd: true },
  { key: "3y", label: "3년", months: 36 },
  { key: "5y", label: "5년", months: 60 },
  { key: "all", label: "전체", all: true },
];
const chartCompareLimit = 10;
const chartCompareColors = ["var(--brand)", "#ea4335", "#34a853", "#fbbc04", "#9333ea", "#06b6d4", "#f97316", "#64748b", "#be123c", "#16a34a", "#7c3aed"];
const detailSortKeys = new Set(["ticker", "name", "display_change_pct", "extended_change_pct", "change_krw", "qty", "current_price", "current_price_krw", "value", "value_krw", "weight_pct", "next_earnings_date"]);
const statsSortKeys = new Set(["ticker", "name", "market_cap_usd", "dividend_yield", "drawdown_52w", "beta", "beta_adj", "rsi_day", "rsi_week", "rsi_month", "bb_day", "bb_week", "bb_month", "trailing_pe", "forward_pe", "price_to_book", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y", "perf_3y", "perf_5y"]);
const dividendSortKeys = new Set(["pay_date", "target", "ticker", "name", "amount", "qty", "gross", "tax", "tax_rate", "net", "fx_rate", "net_krw"]);

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

function renderDiagnostics(diag) {
  const box = document.getElementById("diagnosticsBox");
  if (!box) return;
  const chips = (items, cls) => items.map(t => `<span class="diag-chip ${cls}">${esc(t)}</span>`).join("");
  const divErrors = (diag.dividend_errors || []).map(d => d.ticker);
  const stale = (diag.stale_prices || []).map(d => `${d.ticker}(${(d.last_date || "").slice(5)})`);
  const run = diag.price_run;
  const runText = run?.updated_at
    ? `${new Date(run.updated_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })} · ${run.item_count}종목`
    : "기록 없음";
  const ok = divErrors.length === 0 && stale.length === 0;
  box.innerHTML = `
    <div class="diag-row"><span class="diag-key">마지막 가격 수집</span><span class="diag-val">${esc(runText)}</span></div>
    <div class="diag-row"><span class="diag-key">배당 수집 실패</span><span class="diag-val">${divErrors.length ? chips(divErrors, "bad") : '<span class="diag-ok">없음</span>'}</span></div>
    <div class="diag-row"><span class="diag-key">가격 지연(4일+)</span><span class="diag-val">${stale.length ? chips(stale, "warn") : '<span class="diag-ok">없음</span>'}</span></div>
    ${ok ? "" : '<div class="diag-note">실패/지연 종목은 다음 수집에서 자동 재시도됩니다. 계속되면 티커 유효성·소스 상태를 확인하세요.</div>'}
  `;
  box.classList.toggle("has-issue", !ok);
}

function initDataHelpModal() {
  const modal = document.getElementById("dataHelpModal");
  const open = document.getElementById("dataHelpOpen");
  const close = document.getElementById("dataHelpClose");
  if (!modal || !open || !close) return;
  open.addEventListener("click", () => {
    modal.showModal();
    const box = document.getElementById("diagnosticsBox");
    if (box) box.textContent = "수집 상태 확인 중…";
    apiFetchDiagnostics().then(renderDiagnostics).catch(() => {
      if (box) box.textContent = "수집 상태를 불러오지 못했습니다.";
    });
  });
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
    applyTimeBasedDefaultAccountSelection();
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
  resolveTradeName();   // 티커→종목명 자동완성 (DB에 없으면 lookup)
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
// 보유 필터: 세 상태를 항상 노출하고 원하는 상태를 바로 선택한다.
const positionFilterStates = ["held", "unheld", "all"];
(() => {
  const control = document.getElementById("positionFilterBtn");
  if (!control) return;
  const saved = storageGet(detailStorage.positionFilter);
  const initial = positionFilterStates.includes(saved) ? saved : "held";
  const selectPositionFilter = state => {
    if (!positionFilterStates.includes(state)) return;
    control.dataset.state = state;
    control.querySelectorAll("[data-position-state]").forEach(btn => {
      const selected = btn.dataset.positionState === state;
      btn.classList.toggle("active", selected);
      btn.setAttribute("aria-pressed", String(selected));
    });
  };
  selectPositionFilter(initial);
  control.addEventListener("click", event => {
    const btn = event.target.closest?.("[data-position-state]");
    if (!btn) return;
    const next = btn.dataset.positionState;
    selectPositionFilter(next);
    storageSet(detailStorage.positionFilter, next);
    syncFilterToggleControls();
    render();
  });
})();
chartLogScale = storageGet(detailStorage.chartLogScale) === "true";
chartSmoothLines = storageGet(detailStorage.chartSmoothLines) !== "false";
chartInterval = ["day", "week", "month"].includes(storageGet(detailStorage.chartInterval))
  ? storageGet(detailStorage.chartInterval)
  : "day";
chartShowBuys = storageGet(detailStorage.chartShowBuys) !== "false";   // 기본 ON
chartShowSells = storageGet(detailStorage.chartShowSells) !== "false"; // 기본 ON
document.getElementById("fxAdjustedToggle").checked = storageGet(detailStorage.fxAdjusted) === "true";
document.getElementById("fxAdjustedToggle").addEventListener("change", () => {
  storageSet(detailStorage.fxAdjusted, String(document.getElementById("fxAdjustedToggle").checked));
  syncFilterToggleControls();
  render();
});
document.getElementById("showIndexesToggle").checked = storageGet(detailStorage.showIndexes) === "true";
document.getElementById("showIndexesToggle").addEventListener("change", () => {
  storageSet(detailStorage.showIndexes, String(document.getElementById("showIndexesToggle").checked));
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
    // 세부내역 ↔ 통계: 정렬순서를 양방향으로 이어받음 (대상 탭에 존재하는 정렬키일 때만)
    const detailStats = (previousTab === "detail" && nextTab === "stats")
      || (previousTab === "stats" && nextTab === "detail");
    const carry = sortState[previousTab];
    if (detailStats && carry) {
      const targetKeys = nextTab === "stats" ? new Set([...statsSortKeys, ...detailSortKeys]) : detailSortKeys;
      if (targetKeys.has(carry.key)) sortState[nextTab] = { ...carry };
    }
    activeDetailTab = nextTab;
    syncSortGlobals(activeDetailTab);
    renderTable();
  });
});
// th[data-key] 헤더 + .name-head 안의 티커/종목 미니 정렬 라벨
document.querySelectorAll("th[data-key], .name-head .sort-mini[data-key]").forEach(el => {
  el.addEventListener("click", () => {
    setCurrentSort(el.dataset.key);
    renderTable();
  });
});
initAutoRefreshControls();
initUsPriceControls();
initThemeControl();
initDataHelpModal();
initDividendHistoryModal();
initWatchlistControls();
initTickerSearch();
initChartRangeModal();
initChartDisplayControls();
initChartIntervalControl();
initTradeSideToggle();
initTradeApplyToggle();
setTransactionsExpanded(false);
load().then(syncChartRoute).catch(err => showTradeStatus(err.message || String(err), true));

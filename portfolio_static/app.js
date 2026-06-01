let data = null;
let selectedAccounts = new Set();
let selectionMode = "all";
let sortKey = "value_krw";
let sortDir = -1;
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
let mobileAccountsCollapsed = false;
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
const dividendSortKeys = new Set(["pay_date", "ex_date", "member", "ticker", "currency", "name", "amount", "qty", "gross", "tax_rate", "tax", "net", "fx_rate", "gross_krw", "net_krw"]);

function ensureTabSortKey(tab) {
  const currentSet = tab === "stats" ? statsSortKeys : tab === "dividend" ? dividendSortKeys : detailSortKeys;
  if (currentSet.has(sortKey)) return;
  sortKey = tab === "dividend" ? "pay_date" : tab === "stats" ? "market_cap_usd" : "value_krw";
  sortDir = defaultSortDir[sortKey] || -1;
}

function flattenAccounts() {
  return data.members.flatMap(m => m.accounts.map(a => ({...a, memberName: m.name})));
}
function accountGroupKey(account) {
  const type = account.type || "other";
  // 연금저축(pension_kr)·퇴직연금(retirement_kr)을 하나의 "연금" 카테고리로 통합
  if (type === "pension_kr" || type === "retirement_kr") return "pension";
  return type;
}
function isAccountSelected(id) {
  return selectionMode === "all" || selectedAccounts.has(id);
}
function accountTotal(account, byAccount) {
  return (byAccount.get(account.id) || account).value_krw || account.value_krw || 0;
}
function krwRate(row) {
  const value = Number(row.value);
  const valueKrw = Number(row.value_krw);
  return Number.isFinite(value) && value !== 0 && Number.isFinite(valueKrw)
    ? valueKrw / value
    : Number(data.fx?.[row.currency] || 1);
}
function fxAdjustedEnabled() {
  return document.getElementById("fxAdjustedToggle")?.checked || false;
}
function performanceDetailEnabled() {
  return document.getElementById("performanceDetailToggle")?.checked || false;
}
function currencyFilterValue() {
  return document.getElementById("currencyFilter")?.value || "all";
}
function holdingChangePct(row, fxAdjusted = fxAdjustedEnabled()) {
  if (fxAdjusted && row.currency !== "KRW" && Number.isFinite(row.change_krw_pct)) return row.change_krw_pct;
  return Number.isFinite(row.change_pct) ? row.change_pct : null;
}
function holdingChangeKrw(row, fxAdjusted = fxAdjustedEnabled()) {
  if (fxAdjusted && row.currency !== "KRW") {
    const qty = Number(row.qty);
    const valueKrw = Number(row.value_krw);
    const previousPrice = Number(row.previous_price);
    const previousFxRate = Number(row.previous_fx_rate);
    if (
      Number.isFinite(qty) &&
      Number.isFinite(valueKrw) &&
      Number.isFinite(previousPrice) &&
      Number.isFinite(previousFxRate)
    ) {
      return valueKrw - qty * previousPrice * previousFxRate;
    }
  }
  const change = Number(row.change);
  const qty = Number(row.qty);
  if (!Number.isFinite(change) || !Number.isFinite(qty)) return null;
  const rate = krwRate(row);
  return qty * change * rate;
}
function holdingUnitKrw(row) {
  const price = Number(row.current_price);
  if (!Number.isFinite(price)) return null;
  return price * krwRate(row);
}
function accountChangeMarkup(stats) {
  if (!stats || !Number.isFinite(stats.change_krw) || !Number.isFinite(stats.previous_krw) || stats.previous_krw === 0) return "";
  const change = stats.change_krw;
  const pct = change / stats.previous_krw * 100;
  const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
  return `<span class="account-change ${cls}" title="전일 대비"><span aria-hidden="true">${arrow}</span>${krwShort(Math.abs(change))} · ${fmt2.format(Math.abs(pct))}%</span>`;
}
function normalizeSelection(accounts) {
  if (selectionMode !== "all" && selectedAccounts.size === accounts.length && accounts.length > 0) {
    selectedAccounts.clear();
    selectionMode = "all";
  }
}
function flattenHoldings() {
  return flattenAccounts().flatMap(a => a.holdings.map(h => ({
    ...h,
    accountId: a.id,
    accountName: a.name,
    accountKind: h.account_kind || a.kind,
    assetClass: h.asset_class,
    memberName: a.memberName
  })));
}
function tickerAssetClass(ticker, name, category) {
  const upperName = String(name || "").toUpperCase();
  const upperTicker = String(ticker || "").toUpperCase();
  if (category === "crypto" || upperTicker === "BTC") return "crypto";
  if (category === "index") return "index";
  if (["ARKG", "ARKK", "QLD", "TQQQ", "SQQQ", "SOXL", "SOXS", "SPY", "VOO", "VTI", "IVV", "QQQ", "DIA", "IWM", "SCHD", "1629.T", "200A.T"].includes(upperTicker)) return "etf";
  if (["KODEX", "TIGER", "ACE", "SOL", "ETF", "ISHARES", "PROSHARES", "DIREXION"].some(token => upperName.includes(token))) return "etf";
  return "stock";
}

// Scope is computed server-side (portfolio_core.tickers) and shipped on each
// account / ticker as `scope`, so the rule lives in one place. (#5)
function accountScope(account) {
  return account?.scope ?? null;
}

function tickerScope(tickerMeta) {
  return tickerMeta?.scope ?? null;
}

function watchlistAccountsForTicker(tickerMeta) {
  const scope = tickerScope(tickerMeta);
  if (!scope) return [];
  return flattenAccounts().filter(account => accountScope(account) === scope);
}

function watchlistRowForAccount(tickerMeta, account) {
  const price = Number(tickerMeta.current_price);
  const currentPrice = Number.isFinite(price) ? price : null;
  const previous = Number(tickerMeta.previous_price);
  const previousPrice = Number.isFinite(previous) ? previous : null;
  const change = currentPrice != null && previousPrice ? currentPrice - previousPrice : null;
  const changePct = change != null && previousPrice ? change / previousPrice * 100 : null;
  const currency = tickerMeta.currency || "USD";
  const fxRate = Number(data?.fx?.[currency] || 1);
  const assetClass = tickerAssetClass(tickerMeta.ticker, tickerMeta.name, tickerMeta.category);
  return {
    is_watchlist: true,
    ticker: tickerMeta.ticker,
    name: tickerMeta.name || tickerMeta.ticker,
    qty: null,
    avg_price: null,
    invested: null,
    currency,
    accountId: account?.id || "__watch",
    accountName: account?.name || "관리종목",
    accountKind: account?.kind || "watch",
    assetClass,
    memberName: account?.memberName || "Watchlist",
    current_price: currentPrice,
    previous_price: previousPrice,
    previous_date: tickerMeta.previous_date || null,
    change,
    change_pct: changePct,
    change_krw_pct: null,
    extended_change_pct: tickerMeta.extended_change_pct ?? null,
    fx_rate: fxRate,
    previous_fx_rate: fxRate,
    value: null,
    value_krw: null,
    price_source: tickerMeta.price_source || null,
    next_earnings_date: tickerMeta.next_earnings_date || null,
    logo: tickerMeta.logo || { kind: assetClass, text: String(tickerMeta.ticker).slice(0, 2).toUpperCase(), url: null },
  };
}

function watchlistRows() {
  const held = new Set(flattenHoldings().map(row => String(row.ticker || "").toUpperCase()));
  return (data?.tickers || [])
    .filter(t => t.ticker && !held.has(String(t.ticker).toUpperCase()) && t.category !== "fx")
    .flatMap(t => {
      const accounts = watchlistAccountsForTicker(t);
      if (selectionMode === "all") return [watchlistRowForAccount(t, accounts[0] || null)];
      const selectedMatches = accounts.filter(account => selectedAccounts.has(account.id));
      return selectedMatches.map(account => watchlistRowForAccount(t, account));
    });
}
function visibleAccounts() {
  const accounts = flattenAccounts();
  return selectionMode === "all" ? accounts : accounts.filter(a => selectedAccounts.has(a.id));
}
function holdingsForAccount(accountId) {
  const account = flattenAccounts().find(a => a.id === accountId);
  return account ? account.holdings.map(h => ({ ...h, accountId: account.id, accountName: account.name, memberName: account.memberName })) : [];
}
function findTradeHolding() {
  const accountId = document.getElementById("tradeAccount")?.value || selectedTrade.accountId;
  const ticker = (document.getElementById("tradeTicker")?.value || selectedTrade.ticker || "").trim().toUpperCase();
  return holdingsForAccount(accountId).find(h => h.ticker.toUpperCase() === ticker);
}
function findTickerMeta(ticker) {
  const key = String(ticker || "").trim().toUpperCase();
  return (data?.tickers || []).find(t => String(t.ticker || "").toUpperCase() === key);
}
function currentPriceForTicker(ticker) {
  const key = String(ticker || "").trim().toUpperCase();
  const holding = flattenHoldings().find(h => String(h.ticker || "").toUpperCase() === key && h.current_price != null);
  if (holding) return holding.current_price;
  return findTickerMeta(key)?.current_price ?? null;
}

function aggregateRows(rows) {
  const grouped = new Map();
  rows.forEach(r => {
    const key = `${r.ticker}|${r.currency}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...r,
        qty: 0,
        value: 0,
        value_krw: 0,
        change_krw: 0,
        change: r.change,
        change_pct: r.change_pct,
        current_price_krw: r.current_price_krw,
        memberSet: new Set(),
        accountSet: new Set()
      });
    }
    const g = grouped.get(key);
    g.qty += r.qty || 0;
    g.value += r.value || 0;
    g.value_krw += r.value_krw || 0;
    g.change_krw += r.change_krw || 0;
    g.memberSet.add(r.memberName);
    g.accountSet.add(r.accountName);
  });
  return Array.from(grouped.values()).map(r => {
    const members = Array.from(r.memberSet);
    const accounts = Array.from(r.accountSet);
    delete r.memberSet;
    delete r.accountSet;
    return {
      ...r,
      memberName: members.length > 2 ? `${members.length}명` : members.join(", "),
      accountName: accounts.length > 2 ? `여러 계좌 ${accounts.length}개` : accounts.join(", ")
    };
  });
}

function renderSummary(rows = null) {
  const updated = data.fx_updated ? ` · ${data.fx_updated} 갱신` : "";
  document.getElementById("fxTop").textContent = `환율 USD ${fmt.format(data.fx.USD)} · EUR ${fmt.format(data.fx.EUR)} · JPY ${fmt2.format(data.fx.JPY)}${updated}`;
  renderUsPriceControl();
}

function usExtendedEnabled() {
  return document.getElementById("usExtendedToggle").checked;
}

function renderUsPriceControl() {
  const market = data?.us_market || {};
  const control = document.getElementById("usPriceControl");
  const toggle = document.getElementById("usExtendedToggle");
  const status = document.getElementById("usMarketStatus");
  const regular = Boolean(market.is_regular);
  toggle.disabled = regular;
  control.classList.toggle("disabled", regular);
  control.classList.toggle("enabled", !regular && toggle.checked);
  if (regular) {
    toggle.checked = false;
    control.classList.remove("enabled");
    status.textContent = `정규장 · 실시간 반영`;
  } else {
    status.textContent = toggle.checked ? `장외 · 잔고 반영` : `장외 · 표시만`;
  }
  scheduleUsPriceRefresh();
}

function renderCurrencyFilter() {
  const select = document.getElementById("currencyFilter");
  if (!select || !data) return;
  const saved = storageGet(detailStorage.currencyFilter) || "all";
  const currencies = Array.from(new Set([
    ...flattenHoldings().map(row => row.currency),
    ...(data.tickers || []).map(row => row.currency),
  ].filter(Boolean))).sort((a, b) => {
    const order = { KRW: 0, USD: 1, JPY: 2, EUR: 3 };
    return (order[a] ?? 99) - (order[b] ?? 99) || String(a).localeCompare(String(b));
  });
  select.innerHTML = [
    `<option value="all">전체</option>`,
    ...currencies.map(currency => `<option value="${esc(currency)}">${esc(currency)}</option>`),
  ].join("");
  select.value = currencies.includes(saved) ? saved : "all";
  syncFilterToggleControls();
}

function scheduleUsPriceRefresh() {
  if (usPriceTimer) {
    clearInterval(usPriceTimer);
    usPriceTimer = null;
  }
  const market = data?.us_market || {};
  if (!market.use_live && (market.is_regular || !market.us_ticker_count)) return;
  usPriceTimer = setInterval(() => {
    load().catch(err => showTradeStatus(err.message || String(err), true));
  }, 10 * 60 * 1000);
}

function renderPriceUpdated() {
  const priceUpdated = data.price_updated_at || data.price_updated || "-";
  const priceDate = String(data.price_updated_at || data.price_updated || "").slice(0, 10);
  const fxUpdated = data.fx_updated && data.fx_updated !== priceDate ? ` · 환율 ${data.fx_updated}` : "";
  document.getElementById("priceUpdated").textContent = `가격 갱신: ${priceUpdated}${fxUpdated}`;
}

function syncMobileCollapsePanels() {
  const accountPanel = document.getElementById("accountPanel");
  const accountToggle = document.getElementById("accountCollapseToggle");
  accountPanel?.classList.toggle("mobile-collapsed", mobileAccountsCollapsed);
  if (accountToggle) {
    accountToggle.setAttribute("aria-expanded", String(!mobileAccountsCollapsed));
    accountToggle.setAttribute("aria-label", mobileAccountsCollapsed ? "계좌 펼치기" : "계좌 접기");
    accountToggle.title = mobileAccountsCollapsed ? "계좌 펼치기" : "계좌 접기";
  }
}

function renderAccounts() {
  const rows = filteredRows({ ignoreAccount: true, ignoreAggregate: true, ignoreCurrency: true });
  const byAccount = new Map();
  rows.forEach(r => {
    const current = byAccount.get(r.accountId) || { value_krw: 0, change_krw: 0, previous_krw: 0, count: 0 };
    const changeKrw = r.change_krw;
    const valueKrw = r.value_krw || 0;
    current.value_krw += r.value_krw || 0;
    if (changeKrw !== null && Number.isFinite(valueKrw)) {
      current.change_krw += changeKrw;
      current.previous_krw += valueKrw - changeKrw;
    }
    current.count += 1;
    byAccount.set(r.accountId, current);
  });
  const accounts = flattenAccounts().filter(a => byAccount.has(a.id));
  const totalStats = Array.from(byAccount.values()).reduce(
    (acc, item) => {
      acc.value_krw += item.value_krw || 0;
      acc.change_krw += item.change_krw || 0;
      acc.previous_krw += item.previous_krw || 0;
      return acc;
    },
    { value_krw: 0, change_krw: 0, previous_krw: 0 }
  );
  const total = {
    id: "all",
    name: "전체 계좌",
    memberName: "All",
    value_krw: totalStats.value_krw,
    holdings: []
  };
  const accountButton = a => `
    <button class="account ${isAccountSelected(a.id) ? "active" : ""}" data-account="${a.id}">
      <span class="name">${a.memberName} · ${a.name}</span>
      <span class="meta"><span>${krw(accountTotal(a, byAccount))}</span>${accountChangeMarkup(byAccount.get(a.id))}</span>
    </button>
  `;
  const groups = [
    { key: "overseas", label: "해외주식" },
    { key: "kr_individual", label: "한국개별주" },
    { key: "bitcoin", label: "비트코인" },
    { key: "pension", label: "연금" },
    { key: "other", label: "기타" }
  ];
  const totalButton = `
    <button class="account ${selectionMode === "all" ? "active" : ""}" data-account="all">
      <span class="name">All · 전체 계좌</span>
      <span class="meta"><span>${krw(total.value_krw)}</span>${accountChangeMarkup(totalStats)}</span>
    </button>
  `;
  const groupHtml = groups.map(group => {
    const groupAccounts = accounts.filter(a => accountGroupKey(a) === group.key);
    if (groupAccounts.length === 0) return "";
    const selectedCount = groupAccounts.filter(a => isAccountSelected(a.id)).length;
    const isFull = selectedCount === groupAccounts.length;
    const isPartial = selectedCount > 0 && !isFull;
    const action = isFull ? "해제" : "선택";
    return `
      <div class="account-group">
        <button class="group-head ${isPartial ? "partial" : ""}" data-group="${group.key}">
          <span>${group.label} · ${selectedCount}/${groupAccounts.length}</span>
          <span class="group-action">${action}</span>
        </button>
        ${groupAccounts.map(accountButton).join("")}
      </div>
    `;
  }).join("");
  document.getElementById("accounts").innerHTML = totalButton + groupHtml;
  renderPriceUpdated();
  document.querySelectorAll(".account").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.account;
      if (id === "all") {
        selectedAccounts.clear();
        selectionMode = "all";
      } else if (selectedAccounts.has(id)) {
        selectionMode = "custom";
        selectedAccounts.delete(id);
      } else {
        const wasAllSelected = selectionMode === "all";
        selectionMode = "custom";
        if (wasAllSelected) {
          selectedAccounts = new Set(accounts.map(a => a.id));
          selectedAccounts.delete(id);
        } else {
          selectedAccounts.add(id);
        }
      }
      normalizeSelection(accounts);
      render();
      if (performanceChartOpen) openPerformanceChart();
      loadTransactions().catch(showTradeError);
    });
  });
  document.querySelectorAll(".group-head").forEach(btn => {
    btn.addEventListener("click", () => {
      const group = btn.dataset.group;
      const groupIds = accounts.filter(a => accountGroupKey(a) === group).map(a => a.id);
      if (selectionMode === "all") {
        selectedAccounts = new Set(accounts.map(a => a.id));
        selectionMode = "custom";
      }
      const allSelected = groupIds.every(id => selectedAccounts.has(id));
      groupIds.forEach(id => {
        if (allSelected) selectedAccounts.delete(id);
        else selectedAccounts.add(id);
      });
      normalizeSelection(accounts);
      render();
      if (performanceChartOpen) openPerformanceChart();
      loadTransactions().catch(showTradeError);
    });
  });
}

function filteredRows(options = {}) {
  const activeOnly = document.getElementById("activeOnlyToggle").checked;
  const currencyFilter = currencyFilterValue();
  let rows = flattenHoldings();
  if (!activeOnly) rows = rows.concat(watchlistRows());
  const fxAdjusted = fxAdjustedEnabled();
  if (!options.ignoreAccount && selectionMode !== "all") rows = rows.filter(r => selectedAccounts.has(r.accountId));
  if (activeOnly) rows = rows.filter(r => (r.qty || 0) > 0);
  if (!options.ignoreCurrency && currencyFilter !== "all") rows = rows.filter(r => r.currency === currencyFilter);
  rows = rows.map(row => ({
      ...row,
      display_change_pct: holdingChangePct(row, fxAdjusted),
      change_krw: holdingChangeKrw(row, fxAdjusted),
      current_price_krw: holdingUnitKrw(row),
      next_earnings_date: row.next_earnings_date || null
    }));
  if (!options.ignoreAggregate) rows = aggregateRows(rows);
  const totalKrw = rows.reduce((sum, row) => sum + (Number(row.value_krw) || 0), 0);
  rows = rows.map(row => ({
    ...row,
    weight_pct: totalKrw > 0 && Number.isFinite(row.value_krw) ? row.value_krw / totalKrw * 100 : null
  }));
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av ?? "").localeCompare(String(bv ?? ""), "ko-KR", { numeric: true, sensitivity: "base" }) * sortDir;
    }
    const an = Number.isFinite(av) ? av : -Infinity;
    const bn = Number.isFinite(bv) ? bv : -Infinity;
    return (an - bn) * sortDir;
  });
  return rows;
}

function sortRows(rows) {
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av ?? "").localeCompare(String(bv ?? ""), "ko-KR", { numeric: true, sensitivity: "base" }) * sortDir;
    }
    const an = av != null && Number.isFinite(Number(av)) ? Number(av) : -Infinity;
    const bn = bv != null && Number.isFinite(Number(bv)) ? Number(bv) : -Infinity;
    return (an - bn) * sortDir;
  });
  return rows;
}

function syncFilterToggleControls() {
  [
    ["activeOnlyToggle", "activeOnlyControl"],
    ["fxAdjustedToggle", "fxAdjustedControl"],
    ["performanceDetailToggle", "performanceDetailControl"]
  ].forEach(([toggleId, controlId]) => {
    const toggle = document.getElementById(toggleId);
    const control = document.getElementById(controlId);
    if (toggle && control) control.classList.toggle("enabled", toggle.checked);
  });
  document.getElementById("currencyFilterControl")?.classList.toggle("active", currencyFilterValue() !== "all");
}

function syncDetailTabs() {
  const showingChart = Boolean(chartTicker) || performanceChartOpen;
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", !showingChart && btn.dataset.tab === activeDetailTab);
  });
  document.getElementById("tableTitle").classList.toggle("hidden", showingChart);
  document.getElementById("detailTableWrap").classList.toggle("hidden", showingChart || activeDetailTab !== "detail");
  document.getElementById("statsTableWrap").classList.toggle("hidden", showingChart || activeDetailTab !== "stats");
  document.getElementById("dividendTableWrap").classList.toggle("hidden", showingChart || activeDetailTab !== "dividend");
  document.getElementById("chartView").classList.toggle("hidden", !showingChart);
  document.getElementById("chartBack").classList.toggle("hidden", !showingChart);
  document.getElementById("performanceDetailControl")?.classList.toggle("hidden", !performanceChartOpen);
  document.querySelector(".detail-tabs").classList.toggle("hidden", showingChart);
  ["activeOnlyControl", "fxAdjustedControl", "currencyFilterControl", "rowCount", "accountTotal"].forEach(id => {
    document.getElementById(id)?.classList.toggle("hidden", showingChart);
  });
}

function chartHref(ticker) {
  return `#chart=${encodeURIComponent(ticker || "")}`;
}

function chartTickerFromHash() {
  const match = String(location.hash || "").match(/^#chart=(.+)$/);
  return match ? decodeURIComponent(match[1]).trim().toUpperCase() : "";
}

function performanceChartFromHash() {
  return String(location.hash || "") === "#performance";
}

function statsRows(rows) {
  return rows.map(row => {
    const stats = statsData[row.ticker] || {};
    const rsi = stats.rsi || {};
    const bb = stats.bollinger_pband || {};
    const perf = stats.performance || {};
    const isEtf = (row.assetClass || row.asset_class) === "etf";
    const marketCap = isEtf ? null : Number(stats.market_cap);
    return {
      ...row,
      market_cap: marketCap,
      market_cap_usd: toUsd(marketCap, row.currency),
      dividend_yield: isEtf ? null : stats.dividend_yield,
      next_earnings_date: stats.next_earnings_date || row.next_earnings_date || null,
      rsi_day: rsi.day,
      rsi_week: rsi.week,
      rsi_month: rsi.month,
      bb_day: bb.day,
      bb_week: bb.week,
      bb_month: bb.month,
      trailing_pe: isEtf ? null : stats.trailing_pe,
      forward_pe: isEtf ? null : stats.forward_pe,
      perf_1m: perf.one_month,
      perf_3m: perf.three_month,
      perf_6m: perf.six_month,
      perf_ytd: perf.ytd,
      perf_1y: perf.one_year,
      perf_3y: perf.three_year,
      perf_5y: perf.five_year
    };
  });
}

function hasMissingTechnicalStats(stats) {
  if (!stats) return true;
  const rsi = stats.rsi || {};
  const bb = stats.bollinger_pband || {};
  return ["day", "week", "month"].some(key => !Number.isFinite(Number(rsi[key])) || !Number.isFinite(Number(bb[key])));
}

async function loadStatsForRows(rows) {
  const tickers = Array.from(new Set(rows.map(row => row.ticker).filter(Boolean))).sort();
  const missing = tickers.filter(ticker => !statsData[ticker] || (!statsFetchedTickers.has(ticker) && hasMissingTechnicalStats(statsData[ticker])));
  const key = missing.join(",");
  if (!missing.length || statsLoadKey === key || statsInFlight) return;
  statsLoadKey = key;
  document.getElementById("statsRows").innerHTML = `<tr><td colspan="18">통계 loading...</td></tr>`;
  statsInFlight = (async () => {
    const payload = await apiFetchStats(missing);
    statsData = { ...statsData, ...(payload.stats || {}) };
    missing.forEach(ticker => statsFetchedTickers.add(ticker));
    renderStatsTable(rows);
  })();
  try {
    await statsInFlight;
  } catch (err) {
    document.getElementById("statsRows").innerHTML = `<tr><td colspan="18">${esc(err.message || String(err))}</td></tr>`;
  } finally {
    statsInFlight = null;
  }
}

function renderStatsTable(baseRows = null) {
  const rows = statsRows(baseRows || filteredRows());
  sortRows(rows);
  const tickers = Array.from(new Set(rows.map(row => row.ticker).filter(Boolean))).sort();
  if (tickers.some(ticker => !statsData[ticker] || (!statsFetchedTickers.has(ticker) && hasMissingTechnicalStats(statsData[ticker])))) loadStatsForRows(rows);
  if (statsInFlight && !rows.some(row => statsData[row.ticker])) return;
  document.getElementById("statsRows").innerHTML = rows.map(r => `
    <tr>
      <td>
        <div class="ticker-cell">
          ${logoMarkup(r)}
          <span class="ticker-text">
            <a class="ticker-link" href="${esc(chartHref(r.ticker))}" data-chart-ticker="${esc(r.ticker)}">
              <span class="asset-name">${r.name}</span>
              <span class="ticker-symbol">${r.ticker}</span>
            </a>
          </span>
        </div>
      </td>
      <td>${marketCapMarkup(r)}</td>
      <td>${dividendYieldText(r.dividend_yield)}</td>
      <td>${indicatorText(r.rsi_day, "rsi")}</td>
      <td>${indicatorText(r.rsi_week, "rsi")}</td>
      <td>${indicatorText(r.rsi_month, "rsi")}</td>
      <td>${indicatorText(r.bb_day, "bb")}</td>
      <td>${indicatorText(r.bb_week, "bb")}</td>
      <td>${indicatorText(r.bb_month, "bb")}</td>
      <td>${peText(r.trailing_pe)}</td>
      <td>${peText(r.forward_pe)}</td>
      <td>${signedPercentText(r.perf_1m, 1)}</td>
      <td>${signedPercentText(r.perf_3m, 0)}</td>
      <td>${signedPercentText(r.perf_6m, 0)}</td>
      <td>${signedPercentText(r.perf_ytd, 0)}</td>
      <td>${signedPercentText(r.perf_1y, 0)}</td>
      <td>${signedPercentText(r.perf_3y, 0)}</td>
      <td>${signedPercentText(r.perf_5y, 0)}</td>
    </tr>
  `).join("");
  bindChartLinks();
}

function dividendSelectionKey() {
  if (selectionMode === "all") return "all";
  return Array.from(selectedAccounts).sort((a, b) => String(a).localeCompare(String(b), "ko-KR", { numeric: true })).join(",");
}

async function loadDividendsForSelection() {
  const key = dividendSelectionKey();
  if (dividendInFlight || dividendLoadKey === key) return;
  dividendLoadKey = key;
  const accounts = visibleAccounts();
  const allAccounts = selectionMode === "all";
  document.getElementById("dividendRows").innerHTML = `<tr><td colspan="15">배당 loading...</td></tr>`;
  dividendInFlight = apiFetchDividends(accounts.map(account => account.id), allAccounts);
  try {
    dividendData = await dividendInFlight;
    renderDividendTable();
  } catch (err) {
    document.getElementById("dividendRows").innerHTML = `<tr><td colspan="15">${esc(err.message || String(err))}</td></tr>`;
  } finally {
    dividendInFlight = null;
  }
}

function renderDividendTable() {
  if (dividendLoadKey !== dividendSelectionKey() || !dividendData) {
    loadDividendsForSelection();
    return;
  }
  const rows = [...(dividendData.rows || [])];
  sortRows(rows);
  document.getElementById("rowCount").textContent = `${rows.length} rows`;
  const empty = `<tr><td colspan="15" class="flat">예정 배당 없음</td></tr>`;
  document.getElementById("dividendRows").innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${shortDateText(r.pay_date)}</td>
      <td>${shortDateText(r.ex_date)}</td>
      <td>${esc(r.member || "-")}</td>
      <td class="dividend-ticker"><a class="ticker-link" href="${esc(chartHref(r.ticker))}" data-chart-ticker="${esc(r.ticker)}">${esc(r.ticker)}</a></td>
      <td class="currency-code ${esc(String(r.currency || "").toLowerCase())}">${esc(r.currency || "-")}</td>
      <td>${esc(r.name || r.ticker || "-")}</td>
      <td>${dividendAmountText(r.amount, r.currency)}</td>
      <td>${fmt2.format(Number(r.qty) || 0)}</td>
      <td>${dividendMoneyText(r.gross, r.currency)}</td>
      <td class="tax-rate">${numberText(r.tax_rate, 2)}</td>
      <td>${dividendMoneyText(r.tax, r.currency)}</td>
      <td class="net-dividend">${dividendMoneyText(r.net, r.currency)}</td>
      <td class="fx-rate">${dividendFxText(r.fx_rate)}</td>
      <td class="krw-estimate">${dividendManText(r.gross_krw)}</td>
      <td class="net-krw">${fmt.format(Math.round(Number(r.net_krw) || 0))}</td>
    </tr>
  `).join("") : empty;
  bindChartLinks();
}

function syncTransactionPanel() {
  // 차트 화면에서는 하단 거래내역 패널을 숨긴다.
  const panel = document.querySelector(".transaction-panel");
  if (panel) panel.classList.toggle("hidden", Boolean(performanceChartOpen || chartTicker));
}

function renderTable() {
  syncTransactionPanel();
  const rows = filteredRows();
  const accounts = flattenAccounts();
  const selected = selectionMode === "all" ? accounts : accounts.filter(a => selectedAccounts.has(a.id));
  syncFilterToggleControls();
  syncDetailTabs();
  updateSortHeaders();
  if (!chartTicker) {
    document.getElementById("tableTitle").textContent = selectionMode === "all" ? "전체 계좌" : selected.length === 1 ? `${selected[0].memberName} · ${selected[0].name}` : selected.length > 1 ? `${selected.length}개 계좌` : "선택 없음";
  }
  document.getElementById("rowCount").textContent = `${rows.length} rows`;
  const total = rows.reduce((s, r) => s + (r.value_krw || 0), 0);
  document.getElementById("accountTotal").textContent = krw(total);
  document.getElementById("holdings").innerHTML = rows.map(r => `
    <tr>
      <td>
        <div class="ticker-cell">
          ${logoMarkup(r)}
          <span class="ticker-text">
            <a class="ticker-link" href="${esc(chartHref(r.ticker))}" data-chart-ticker="${esc(r.ticker)}">
              <span class="asset-name">${r.name}</span>
              <span class="ticker-symbol">${r.ticker}</span>
            </a>
          </span>
        </div>
      </td>
      <td>${changeMarkup(r)}</td>
      <td>${extendedChangeText(r) || "-"}</td>
      <td>${r.is_watchlist ? "-" : changeKrwText(r.change_krw)}</td>
      <td>${r.is_watchlist ? "-" : fmt2.format(r.qty)}</td>
      <td>${localCurrentPriceText(r)}</td>
      <td>${krwCurrentPriceText(r)}</td>
      <td>${r.is_watchlist ? "-" : localValueText(r)}</td>
      <td>${r.is_watchlist ? "-" : krwValueText(r)}</td>
      <td>${r.is_watchlist ? "-" : weightText(r.weight_pct)}</td>
      <td>${r.is_watchlist ? "-" : earningsText(r.next_earnings_date)}</td>
      <td>${r.is_watchlist ? "-" : `<button class="ghost-btn tx-pick" type="button" data-account="${esc(r.accountId)}" data-ticker="${esc(r.ticker)}">거래</button>`}</td>
    </tr>
  `).join("");
  document.querySelectorAll(".tx-pick").forEach(btn => {
    btn.addEventListener("click", () => {
      selectTradeTarget(btn.dataset.account, btn.dataset.ticker);
    });
  });
  bindChartLinks();
  if (activeDetailTab === "stats") renderStatsTable(rows);
  if (activeDetailTab === "dividend") renderDividendTable();
}

function bindChartLinks() {
  document.querySelectorAll(".ticker-link").forEach(btn => {
    btn.addEventListener("click", () => {
      openChart(btn.dataset.chartTicker);
    });
  });
}

function chartMoney(value, currency) {
  if (!Number.isFinite(value)) return "-";
  return unitMoney(value, currency).replace(/<[^>]+>/g, "");
}

function signedChartMoney(value, currency) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${chartMoney(Math.abs(value), currency)}`;
}

function chartDateLabel(dateText) {
  if (!dateText) return "-";
  const text = String(dateText);
  return text.length >= 10 ? text.slice(2, 10).replaceAll("-", ".") : text;
}

function chartFullDateLabel(dateText) {
  if (!dateText) return "-";
  const text = String(dateText);
  return text.length >= 10 ? text.slice(0, 10).replaceAll("-", ".") : text;
}

function chartDateObject(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) return null;
  const date = new Date(`${dateText}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function chartRangeStartDate(points, rangeKey) {
  const lastDateText = points[points.length - 1]?.date;
  if (!lastDateText) return null;
  const lastDate = new Date(`${lastDateText}T00:00:00`);
  if (Number.isNaN(lastDate.getTime())) return null;
  if (rangeKey === "ytd") {
    return new Date(lastDate.getFullYear(), 0, 1);
  }
  const range = chartRanges.find(item => item.key === rangeKey) || chartRanges.find(item => item.key === "1y");
  const start = new Date(lastDate);
  start.setMonth(start.getMonth() - (range.months || 12));
  return start;
}

function chartRangeBounds(points, rangeKey) {
  if (rangeKey === "custom") {
    return {
      startDate: chartDateObject(chartCustomRange.start),
      endDate: chartDateObject(chartCustomRange.end),
    };
  }
  return {
    startDate: chartRangeStartDate(points, rangeKey),
    endDate: null,
  };
}

function filterChartPoints(points, rangeKey) {
  if (!points.length) return points;
  const { startDate, endDate } = chartRangeBounds(points, rangeKey);
  if (!startDate && !endDate) return points;
  const filtered = points.filter(point => {
    const date = new Date(`${point.date}T00:00:00`);
    return (!startDate || date >= startDate) && (!endDate || date <= endDate);
  });
  if (rangeKey === "custom") return filtered;
  return filtered.length >= 2 ? filtered : points.slice(-Math.min(points.length, 2));
}

function niceChartStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / power;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * power;
}

function niceChartScale(values, desiredTicks = 5) {
  const cleanValues = values.filter(value => Number.isFinite(value));
  if (!cleanValues.length) return { min: 0, max: 1, ticks: [0, .25, .5, .75, 1] };
  const rawMin = Math.min(...cleanValues);
  const rawMax = Math.max(...cleanValues);
  const rawRange = rawMax - rawMin || Math.max(1, Math.abs(rawMax));
  const paddedMin = rawMin - rawRange * 0.05;
  const paddedMax = rawMax + rawRange * 0.12;
  const step = niceChartStep((paddedMax - paddedMin) / Math.max(1, desiredTicks - 1));
  const min = Math.floor(paddedMin / step) * step;
  const max = Math.ceil(paddedMax / step) * step;
  const ticks = [];
  for (let value = min; value <= max + step / 2; value += step) {
    ticks.push(Math.abs(value) < step / 1_000_000 ? 0 : value);
  }
  return { min, max, ticks };
}

function transactionsForChart(payload, points) {
  const start = points[0]?.date;
  const end = points[points.length - 1]?.date;
  if (!start || !end) return [];
  return (payload.transactions || [])
    .filter(tx => tx.date >= start && tx.date <= end && Number.isFinite(Number(tx.price)))
    .map(tx => ({ ...tx, price: Number(tx.price), qty: Number(tx.qty || 0) }));
}

function nearestPointIndex(points, dateText) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  const target = new Date(`${dateText}T00:00:00`).getTime();
  points.forEach((point, index) => {
    const distance = Math.abs(new Date(`${point.date}T00:00:00`).getTime() - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function chartLocalDateText(time) {
  const date = new Date(time);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function indexedChartVerticalGrid(points, xFor, rangeKey) {
  if (points.length < 2) return { unit: "month", ticks: [] };
  const minTime = new Date(`${points[0].date}T00:00:00`).getTime();
  const maxTime = new Date(`${points[points.length - 1].date}T00:00:00`).getTime();
  const grid = perfVerticalGrid(minTime, maxTime, rangeKey);
  const seen = new Set();
  const ticks = grid.lines
    .map(time => {
      const date = chartLocalDateText(time);
      const index = nearestPointIndex(points, date);
      if (seen.has(index)) return null;
      seen.add(index);
      return { time, index, x: xFor(index), date: points[index].date };
    })
    .filter(Boolean);
  if (ticks.length) return { unit: grid.unit, ticks };
  return {
    unit: grid.unit,
    ticks: [0, points.length - 1]
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .map(index => ({
        time: new Date(`${points[index].date}T00:00:00`).getTime(),
        index,
        x: xFor(index),
        date: points[index].date,
      })),
  };
}

function chartExtremes(values) {
  if (!values.length) return [];
  const highIndex = values.reduce((best, value, index) => value > values[best] ? index : best, 0);
  const lowIndex = values.reduce((best, value, index) => value < values[best] ? index : best, 0);
  return [
    { kind: "high", label: "고점", index: highIndex, value: values[highIndex] },
    { kind: "low", label: "저점", index: lowIndex, value: values[lowIndex] },
  ].filter((item, index, items) => index === 0 || item.index !== items[0].index);
}

function renderChartRangeButtons() {
  return `
    <div class="chart-ranges" role="group" aria-label="차트 기간">
      ${chartRanges.map(range => `
        <button class="chart-range-btn ${range.key === chartRange ? "active" : ""}" type="button" data-chart-range="${range.key}">${range.label}</button>
      `).join("")}
      <button class="chart-range-btn ${chartRange === "custom" ? "active" : ""}" type="button" data-chart-custom>직접설정</button>
    </div>
  `;
}

function chartPointDatesForModal() {
  const rawPoints = performanceChartOpen
    ? (performancePayload?.points || []).map(point => ({ date: point.date, close: Number(point.value) }))
    : (chartPayload?.points || []).map(point => ({ date: point.date, close: Number(point.close) }));
  const points = rawPoints.filter(point => point.date && Number.isFinite(point.close));
  if (!points.length) return { start: "", end: "" };
  const visible = chartRange === "custom"
    ? points
    : filterChartPoints(points, chartRange);
  const selected = visible.length >= 2 ? visible : points;
  return {
    start: selected[0]?.date || "",
    end: selected[selected.length - 1]?.date || "",
  };
}

function setChartRangeStatus(message, error = false) {
  const el = document.getElementById("chartRangeStatus");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", error);
}

function openChartRangeModal() {
  const modal = document.getElementById("chartRangeModal");
  const startInput = document.getElementById("chartRangeStart");
  const endInput = document.getElementById("chartRangeEnd");
  const defaults = chartPointDatesForModal();
  startInput.value = chartCustomRange.start || defaults.start;
  endInput.value = chartCustomRange.end || defaults.end;
  setChartRangeStatus("");
  modal.showModal();
  startInput.focus();
}

function applyChartCustomRange() {
  const modal = document.getElementById("chartRangeModal");
  const start = document.getElementById("chartRangeStart").value;
  const end = document.getElementById("chartRangeEnd").value;
  const startDate = chartDateObject(start);
  const endDate = chartDateObject(end);
  if (!startDate || !endDate) {
    setChartRangeStatus("시작일과 종료일을 모두 입력하세요.", true);
    return;
  }
  if (startDate > endDate) {
    setChartRangeStatus("시작일은 종료일보다 늦을 수 없습니다.", true);
    return;
  }
  chartCustomRange = { start, end };
  chartRange = "custom";
  modal.close();
  if (performanceChartOpen) renderPerformanceChart(performancePayload);
  else if (chartPayload) renderLineChart(chartPayload);
}

function initChartRangeModal() {
  document.getElementById("chartRangeClose").addEventListener("click", () => {
    document.getElementById("chartRangeModal").close();
  });
  document.getElementById("chartRangeApply").addEventListener("click", applyChartCustomRange);
  ["chartRangeStart", "chartRangeEnd"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyChartCustomRange();
      }
    });
  });
}

function chartLogoRow(payload) {
  const ticker = String(payload?.ticker || "").toUpperCase();
  const holding = flattenHoldings().find(row => String(row.ticker || "").toUpperCase() === ticker);
  const meta = findTickerMeta(ticker);
  return {
    ticker,
    name: payload?.name || holding?.name || meta?.name || ticker,
    logo: payload?.logo || holding?.logo || meta?.logo || null,
  };
}

function renderChartIdentity(payload) {
  const row = chartLogoRow(payload);
  document.getElementById("chartIcon").innerHTML = logoMarkup(row);
  document.getElementById("chartTicker").textContent = row.ticker || "";
  document.getElementById("chartName").textContent = row.name || row.ticker || "";
}

function bindLineChartControls(payload) {
  document.querySelectorAll(".chart-range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.chartCustom != null) {
        openChartRangeModal();
        return;
      }
      chartRange = btn.dataset.chartRange || "6m";
      renderLineChart(payload);
    });
  });
}

function tickerDisplayName(ticker) {
  const key = String(ticker || "").toUpperCase();
  const meta = findTickerMeta(key);
  return meta?.name || key;
}

function chartCompareSeries(payload) {
  return [payload, ...chartComparePayloads].map((item, index) => {
    const rawPoints = (item.points || [])
      .filter(point => point.date && Number.isFinite(Number(point.close)))
      .map(point => ({ date: point.date, value: Number(point.close) }));
    const filtered = filterChartPoints(rawPoints.map(point => ({ date: point.date, close: point.value })), chartRange)
      .map(point => ({
        date: point.date,
        value: Number(point.close),
        time: new Date(`${point.date}T00:00:00`).getTime(),
      }));
    if (filtered.length < 2) return null;
    const base = filtered.find(point => point.value > 0)?.value;
    if (!base) return null;
    return {
      key: String(item.ticker || `compare-${index}`).toUpperCase(),
      ticker: String(item.ticker || "").toUpperCase(),
      name: item.name || item.ticker,
      color: chartCompareColors[index % chartCompareColors.length],
      primary: index === 0,
      points: filtered.map(point => ({
        ...point,
        close: (point.value / base - 1) * 100,
      })),
    };
  }).filter(Boolean);
}

function renderChartCompareControls() {
  return `
    <div class="chart-compare-panel">
      <div class="chart-compare-add">
        <input id="chartCompareInput" placeholder="티커 직접 입력" autocomplete="off" spellcheck="false">
        <button class="ghost-btn" id="chartCompareAdd" type="button">추가</button>
      </div>
      <div class="chart-compare-list">
        ${chartComparePayloads.map(item => `
          <span class="compare-chip">
            ${esc(item.ticker)} · ${esc(item.name || item.ticker)}
            <button type="button" data-compare-remove="${esc(item.ticker)}" aria-label="${esc(item.ticker)} 삭제">&times;</button>
          </span>
        `).join("") || `<span class="compare-empty">비교 종목 없음</span>`}
      </div>
    </div>
  `;
}

function bindChartCompareControls(payload) {
  const input = document.getElementById("chartCompareInput");
  const add = document.getElementById("chartCompareAdd");
  if (add && input) {
    add.addEventListener("click", () => addChartCompareTicker(input.value));
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        addChartCompareTicker(input.value);
      }
    });
  }
  document.querySelectorAll("[data-compare-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const ticker = btn.dataset.compareRemove;
      chartComparePayloads = chartComparePayloads.filter(item => item.ticker !== ticker);
      renderLineChart(payload);
    });
  });
}

async function addChartCompareTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  if (!ticker || ticker === chartTicker) return;
  if (chartComparePayloads.some(item => item.ticker === ticker)) return;
  if (chartComparePayloads.length >= chartCompareLimit) {
    showTradeStatus(`비교 종목은 최대 ${chartCompareLimit}개까지 추가할 수 있습니다.`, true);
    return;
  }
  const input = document.getElementById("chartCompareInput");
  if (input) input.value = "";
  try {
    const payload = await apiFetchChart(ticker);
    const pricedPoints = (payload.points || []).filter(point => point.date && Number.isFinite(Number(point.close)));
    if (pricedPoints.length < 2) {
      showTradeStatus(`${ticker} 가격 이력이 없습니다.`, true);
      return;
    }
    chartComparePayloads = [...chartComparePayloads, payload];
    renderLineChart(chartPayload);
  } catch (err) {
    showTradeStatus(err.message || String(err), true);
  }
}

function bindCompareHover(series, geometry) {
  const svg = document.querySelector("#chartCanvas svg");
  const hoverLayer = document.getElementById("chartHoverLayer");
  const hoverGroup = document.getElementById("chartHoverGroup");
  const hoverLine = document.getElementById("chartHoverLine");
  const tooltip = document.getElementById("chartTooltip");
  const tooltipBox = document.getElementById("chartTooltipBox");
  if (!svg || !hoverLayer || !hoverGroup || !hoverLine || !tooltip || !tooltipBox) return;
  const nearest = (points, targetTime) => points.reduce((best, point) => {
    const distance = Math.abs(point.time - targetTime);
    return !best || distance < best.distance ? { point, distance } : best;
  }, null)?.point;
  const updateTooltipBox = () => {
    let bbox = tooltip.getBBox();
    let x = Number(tooltip.getAttribute("x") || 0);
    if (bbox.x + bbox.width > geometry.width - 8) x -= bbox.x + bbox.width - (geometry.width - 8);
    if (bbox.x < 8) x += 8 - bbox.x;
    tooltip.setAttribute("x", x.toFixed(2));
    tooltip.querySelectorAll("tspan").forEach(tspan => tspan.setAttribute("x", x.toFixed(2)));
    bbox = tooltip.getBBox();
    tooltipBox.setAttribute("x", (bbox.x - 8).toFixed(2));
    tooltipBox.setAttribute("y", (bbox.y - 6).toFixed(2));
    tooltipBox.setAttribute("width", (bbox.width + 16).toFixed(2));
    tooltipBox.setAttribute("height", (bbox.height + 12).toFixed(2));
  };
  const showPoint = clientX => {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    const targetTime = geometry.minTime + ratio * (geometry.maxTime - geometry.minTime);
    const x = geometry.xForTime(targetTime);
    const mainPoint = nearest(series[0]?.points || [], targetTime);
    const dateText = mainPoint?.date || new Date(targetTime).toISOString().slice(0, 10);
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    series.forEach(item => {
      const dot = document.getElementById(`compareDot-${item.key}`);
      const point = nearest(item.points, targetTime);
      if (!dot || !point) return;
      dot.setAttribute("cx", x.toFixed(2));
      dot.setAttribute("cy", geometry.yFor(point.close).toFixed(2));
      dot.style.display = "";
    });
    tooltip.textContent = "";
    const tx = x > geometry.width - 250 ? x - 176 : x + 14;
    [
      chartFullDateLabel(dateText),
      ...series.map(item => {
        const point = nearest(item.points, targetTime);
        return `${item.ticker || item.name} ${pctChartLabel(point?.close)}`;
      }),
    ].forEach((line, index) => {
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttribute("x", tx.toFixed(2));
      tspan.setAttribute("dy", index === 0 ? "0" : "11");
      tspan.textContent = line;
      tooltip.appendChild(tspan);
    });
    tooltip.setAttribute("x", tx.toFixed(2));
    tooltip.setAttribute("y", geometry.pad.top + 14);
    updateTooltipBox();
  };
  hoverLayer.addEventListener("pointermove", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerenter", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerleave", () => hoverGroup.classList.add("hidden"));
}

function renderCompareLineChart(payload) {
  const series = chartCompareSeries(payload);
  renderChartIdentity(payload);
  if (series.length < 2 || !series[0]?.points.length) {
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">비교 차트 데이터 없음</div>${renderChartCompareControls()}${renderChartRangeButtons()}`;
    bindChartCompareControls(payload);
    bindLineChartControls(payload);
    return;
  }
  const allPoints = series.flatMap(item => item.points);
  const minTime = Math.min(...allPoints.map(point => point.time));
  const maxTime = Math.max(...allPoints.map(point => point.time));
  const values = allPoints.map(point => point.close);
  const scale = niceChartScale([...values, 0]);
  const width = 980;
  const height = 350;
  const pad = { top: 28, right: 108, bottom: 34, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const min = scale.min;
  const max = scale.max;
  const range = max - min || 1;
  const xForTime = time => pad.left + (maxTime === minTime ? 0 : (time - minTime) / (maxTime - minTime) * plotW);
  const yFor = value => pad.top + (max - value) / range * plotH;
  const clampY = value => Math.max(pad.top + 4, Math.min(pad.top + plotH - 2, value));
  const pathFor = points => points.map((point, index) => `${index === 0 ? "M" : "L"}${xForTime(point.time).toFixed(2)},${yFor(point.close).toFixed(2)}`).join(" ");
  const main = series[0];
  const first = main.points[0];
  const last = main.points[main.points.length - 1];
  const cls = last.close > 0 ? "up" : last.close < 0 ? "down" : "flat";
  document.getElementById("chartMeta").innerHTML = `
    <span>${chartDateLabel(first.date)} - ${chartDateLabel(last.date)}</span>
    <span>비교 ${chartComparePayloads.length}개</span>
    <span class="${cls}">${pctChartLabel(last.close)}</span>
  `;
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
  const vGrid = perfVerticalGrid(minTime, maxTime, chartRange);
  const labelEvery = Math.max(1, Math.ceil(vGrid.lines.length / 8));
  const endLabels = series
    .map(item => {
      const lastPoint = item.points[item.points.length - 1];
      return { color: item.color, close: lastPoint.close, y: yFor(lastPoint.close) };
    })
    .sort((a, b) => a.y - b.y);
  const minGap = 13;
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < minGap) endLabels[i].y = endLabels[i - 1].y + minGap;
  }
  const legend = series.map(item => `<span class="perf-legend-item"><i style="background:${item.color}"></i>${esc(item.ticker || item.name)}</span>`).join("");
  document.getElementById("chartCanvas").innerHTML = `
    <div class="perf-chart-top">
      <div class="perf-legend">${legend}</div>
    </div>
    <svg class="line-chart compare-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(payload.name)} 비교 차트">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${pad.left - 8}" y="${(tick.y + 4).toFixed(2)}">${esc(pctChartLabel(tick.value))}</text>
      `).join("")}
      ${vGrid.lines.map(time => `
        <line class="chart-grid perf-vgrid" x1="${xForTime(time).toFixed(2)}" x2="${xForTime(time).toFixed(2)}" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(2)}"></line>
      `).join("")}
      <line class="perf-zero-line" x1="${pad.left}" x2="${pad.left + plotW}" y1="${yFor(0).toFixed(2)}" y2="${yFor(0).toFixed(2)}"></line>
      ${vGrid.lines.map((time, index) => {
        if (index % labelEvery !== 0) return "";
        const x = xForTime(time);
        const anchor = x < pad.left + 18 ? "start" : x > pad.left + plotW - 18 ? "end" : "middle";
        return `<text class="chart-x-label" x="${x.toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${esc(perfGridLabel(time, vGrid.unit))}</text>`;
      }).join("")}
      ${series.map(item => `<path class="perf-line ${item.primary ? "primary" : "index"}" d="${pathFor(item.points)}" style="stroke:${item.color}"></path>`).join("")}
      ${endLabels.map(label => `
        <text class="perf-end-label" x="${(pad.left + plotW + 7).toFixed(2)}" y="${(clampY(label.y) + 3.5).toFixed(2)}" style="fill:${label.color}">${esc(pctChartLabel(label.close))}</text>
      `).join("")}
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        ${series.map(item => `<circle id="compareDot-${item.key}" class="perf-hover-dot" r="3.6" cx="0" cy="0" style="stroke:${item.color}"></circle>`).join("")}
        <rect id="chartTooltipBox" class="chart-tooltip-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartTooltip" class="chart-tooltip perf-tooltip" x="0" y="0">-</text>
      </g>
    </svg>
    ${renderChartCompareControls()}
    ${renderChartRangeButtons()}
  `;
  bindCompareHover(series, { width, height, pad, plotW, plotH, minTime, maxTime, xForTime, yFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
}

function bindChartInteractions(points, payload, geometry) {
  const svg = document.querySelector("#chartCanvas svg");
  const hoverLayer = document.getElementById("chartHoverLayer");
  const hoverGroup = document.getElementById("chartHoverGroup");
  const hoverLine = document.getElementById("chartHoverLine");
  const hoverDot = document.getElementById("chartHoverDot");
  const tooltip = document.getElementById("chartTooltip");
  const tooltipBox = document.getElementById("chartTooltipBox");
  const selectionGroup = document.getElementById("chartSelectionGroup");
  const selectionRect = document.getElementById("chartSelectionRect");
  const selectionStartLine = document.getElementById("chartSelectionStartLine");
  const selectionEndLine = document.getElementById("chartSelectionEndLine");
  const selectionTooltip = document.getElementById("chartSelectionTooltip");
  const selectionTooltipBox = document.getElementById("chartSelectionTooltipBox");
  let dragStartIndex = null;
  let isDragging = false;
  if (!svg || !hoverLayer || !hoverGroup || !hoverLine || !hoverDot || !tooltip) return;

  const updateTooltipBox = () => {
    if (!tooltipBox) return;
    let bbox = tooltip.getBBox();
    let x = Number(tooltip.getAttribute("x") || 0);
    let y = Number(tooltip.getAttribute("y") || 0);
    if (bbox.x < 6) x += 6 - bbox.x;
    if (bbox.x + bbox.width > geometry.width - 6) x -= bbox.x + bbox.width - (geometry.width - 6);
    if (bbox.y < 6) y += 6 - bbox.y;
    if (bbox.y + bbox.height > geometry.height - 6) y -= bbox.y + bbox.height - (geometry.height - 6);
    tooltip.setAttribute("x", x.toFixed(2));
    tooltip.setAttribute("y", y.toFixed(2));
    bbox = tooltip.getBBox();
    tooltipBox.setAttribute("x", (bbox.x - 8).toFixed(2));
    tooltipBox.setAttribute("y", (bbox.y - 5).toFixed(2));
    tooltipBox.setAttribute("width", (bbox.width + 16).toFixed(2));
    tooltipBox.setAttribute("height", (bbox.height + 10).toFixed(2));
  };

  function showMarker(marker) {
    const x = Number(marker.dataset.x);
    const y = Number(marker.dataset.y);
    const tooltipY = y < geometry.pad.top + geometry.plotH / 2 ? y + 42 : y - 58;
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    hoverDot.setAttribute("cx", x.toFixed(2));
    hoverDot.setAttribute("cy", y.toFixed(2));
    tooltip.setAttribute("x", (x > geometry.width - 280 ? x - 218 : x + 14).toFixed(2));
    tooltip.setAttribute("y", tooltipY.toFixed(2));
    tooltip.textContent = marker.dataset.tooltip || "";
    updateTooltipBox();
  }

  function showPoint(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const svgY = clientY == null ? null : (clientY - rect.top) / rect.height * geometry.height;
    const marker = svgY == null ? null : Array.from(document.querySelectorAll(".trade-marker")).find(item => {
      const dx = Number(item.dataset.x) - svgX;
      const dy = Number(item.dataset.y) - svgY;
      return Math.hypot(dx, dy) <= 13;
    });
    if (marker) {
      showMarker(marker);
      return;
    }
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
    const point = points[index];
    const x = geometry.xFor(index);
    const y = geometry.yFor(Number(point.close));
    const tooltipX = x > geometry.width - 250 ? x - 188 : x + 12;
    const tooltipY = y < geometry.pad.top + geometry.plotH / 2 ? y + 42 : y - 58;
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    hoverDot.setAttribute("cx", x.toFixed(2));
    hoverDot.setAttribute("cy", y.toFixed(2));
    tooltip.setAttribute("x", tooltipX.toFixed(2));
    tooltip.setAttribute("y", tooltipY.toFixed(2));
    tooltip.textContent = `${chartFullDateLabel(point.date)} · ${chartMoney(Number(point.close), payload.currency)}`;
    updateTooltipBox();
  }

  function pointIndexFromClientX(clientX) {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
  }

  function updateSelection(fromIndex, toIndex) {
    if (!selectionGroup || !selectionRect || !selectionStartLine || !selectionEndLine || !selectionTooltip || !selectionTooltipBox) return;
    const startIndex = Math.min(fromIndex, toIndex);
    const endIndex = Math.max(fromIndex, toIndex);
    if (startIndex === endIndex) return;

    const start = points[startIndex];
    const end = points[endIndex];
    const startPrice = Number(start.close);
    const endPrice = Number(end.close);
    const change = endPrice - startPrice;
    const changePct = startPrice ? change / startPrice * 100 : 0;
    const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
    const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
    const x1 = geometry.xFor(startIndex);
    const x2 = geometry.xFor(endIndex);
    const labelX = Math.min(geometry.width - 10, Math.max(10, (x1 + x2) / 2));
    const lines = [
      `${arrow}${signedChartMoney(change, payload.currency)} (${changePct > 0 ? "+" : ""}${fmt2.format(changePct)}%)`,
      `${chartFullDateLabel(start.date)} - ${chartFullDateLabel(end.date)}`,
      `${chartMoney(startPrice, payload.currency)} → ${chartMoney(endPrice, payload.currency)}`,
    ];

    selectionGroup.classList.remove("hidden", "up", "down", "flat");
    selectionGroup.classList.add(cls);
    selectionRect.setAttribute("x", x1.toFixed(2));
    selectionRect.setAttribute("width", Math.max(1, x2 - x1).toFixed(2));
    [selectionStartLine, selectionEndLine].forEach((line, index) => {
      const x = index === 0 ? x1 : x2;
      line.setAttribute("x1", x.toFixed(2));
      line.setAttribute("x2", x.toFixed(2));
    });
    selectionTooltip.setAttribute("x", labelX.toFixed(2));
    selectionTooltip.setAttribute("y", (geometry.pad.top + 16).toFixed(2));
    selectionTooltip.textContent = "";
    lines.forEach((line, index) => {
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttribute("x", labelX.toFixed(2));
      tspan.setAttribute("dy", index === 0 ? "0" : "15");
      tspan.textContent = line;
      selectionTooltip.appendChild(tspan);
    });

    let bbox = selectionTooltip.getBBox();
    let adjustedX = labelX;
    if (bbox.x < 8) adjustedX += 8 - bbox.x;
    if (bbox.x + bbox.width > geometry.width - 8) adjustedX -= bbox.x + bbox.width - (geometry.width - 8);
    if (adjustedX !== labelX) {
      selectionTooltip.setAttribute("x", adjustedX.toFixed(2));
      selectionTooltip.querySelectorAll("tspan").forEach(tspan => tspan.setAttribute("x", adjustedX.toFixed(2)));
      bbox = selectionTooltip.getBBox();
    }
    selectionTooltipBox.setAttribute("x", (bbox.x - 9).toFixed(2));
    selectionTooltipBox.setAttribute("y", (bbox.y - 7).toFixed(2));
    selectionTooltipBox.setAttribute("width", (bbox.width + 18).toFixed(2));
    selectionTooltipBox.setAttribute("height", (bbox.height + 14).toFixed(2));
  }

  hoverLayer.addEventListener("pointerdown", event => {
    dragStartIndex = pointIndexFromClientX(event.clientX);
    isDragging = true;
    hoverGroup.classList.add("hidden");
    hoverLayer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  hoverLayer.addEventListener("pointermove", event => {
    if (isDragging && dragStartIndex != null) {
      updateSelection(dragStartIndex, pointIndexFromClientX(event.clientX));
      return;
    }
    showPoint(event.clientX, event.clientY);
  });
  hoverLayer.addEventListener("pointerup", event => {
    if (isDragging && dragStartIndex != null) {
      updateSelection(dragStartIndex, pointIndexFromClientX(event.clientX));
    }
    isDragging = false;
    dragStartIndex = null;
    hoverLayer.releasePointerCapture?.(event.pointerId);
  });
  hoverLayer.addEventListener("pointercancel", () => {
    isDragging = false;
    dragStartIndex = null;
  });
  hoverLayer.addEventListener("pointerenter", event => showPoint(event.clientX, event.clientY));
  hoverLayer.addEventListener("pointerleave", () => hoverGroup.classList.add("hidden"));

  document.querySelectorAll(".trade-marker").forEach(marker => {
    ["pointerenter", "mouseenter", "mouseover", "focus", "click"].forEach(eventName => {
      marker.addEventListener(eventName, () => showMarker(marker));
    });
  });
}

function renderLineChart(payload) {
  if (chartComparePayloads.length) {
    renderCompareLineChart(payload);
    return;
  }
  const allPoints = (payload.points || []).filter(point => Number.isFinite(Number(point.close)));
  const points = filterChartPoints(allPoints, chartRange);
  const chartTransactions = transactionsForChart(payload, points);
  renderChartIdentity(payload);
  if (points.length < 2) {
    document.getElementById("chartMeta").textContent = `${points.length} points`;
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">차트 데이터 없음</div>${renderChartCompareControls()}${renderChartRangeButtons()}`;
    bindChartCompareControls(payload);
    bindLineChartControls(payload);
    return;
  }

  const values = points.map(point => Number(point.close));
  const markerValues = chartTransactions.map(tx => tx.price);
  const scale = niceChartScale([...values, ...markerValues]);
  const min = scale.min;
  const max = scale.max;
  const first = values[0];
  const last = values[values.length - 1];
  const changePct = first ? (last - first) / first * 100 : null;
  const cls = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
  const arrow = changePct > 0 ? "▲" : changePct < 0 ? "▼" : "→";
  document.getElementById("chartMeta").innerHTML = `
    <span>${chartDateLabel(points[0].date)} - ${chartDateLabel(points[points.length - 1].date)}</span>
    <span>${points.length}일</span>
    <span class="${cls}">${arrow}${fmt2.format(Math.abs(changePct || 0))}%</span>
    <span>${chartMoney(last, payload.currency)}</span>
  `;

  const width = 980;
  const height = 340;
  const pad = { top: 28, right: 58, bottom: 32, left: 14 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const range = max - min || Math.max(1, Math.abs(max));
  const xFor = index => pad.left + (points.length === 1 ? 0 : index / (points.length - 1) * plotW);
  const yFor = value => pad.top + (max - value) / range * plotH;
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(2)},${yFor(Number(point.close)).toFixed(2)}`).join(" ");
  const area = `${line} L${pad.left + plotW},${pad.top + plotH} L${pad.left},${pad.top + plotH} Z`;
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
  const vGrid = indexedChartVerticalGrid(points, xFor, chartRange);
  const labelEvery = Math.max(1, Math.ceil(vGrid.ticks.length / 8));
  const markers = chartTransactions.map((tx, index) => {
    const pointIndex = nearestPointIndex(points, tx.date);
    const x = xFor(pointIndex);
    const y = yFor(tx.price);
    const isBuy = tx.side === "BUY";
    return {
      ...tx,
      key: `${tx.date}-${tx.side}-${index}`,
      label: isBuy ? "B" : "S",
      cls: isBuy ? "buy" : "sell",
      x,
      y,
      tooltip: `${tx.account || tx.member || "-"} · ${tx.side === "BUY" ? "매수" : "매도"} ${fmt2.format(tx.qty)}주 · ${chartMoney(tx.price, tx.currency || payload.currency)}`,
    };
  });
  const extremes = chartExtremes(values).map(item => {
    const x = xFor(item.index);
    const y = yFor(item.value);
    const leftSide = x > width - 180;
    const tooHigh = y < pad.top + 24;
    const tooLow = y > pad.top + plotH - 20;
    const labelY = item.kind === "high"
      ? (tooHigh ? y + 24 : y - 12)
      : (tooLow ? y - 12 : y + 24);
    return {
      ...item,
      x,
      y,
      labelX: leftSide ? x - 10 : x + 10,
      labelY,
      anchor: leftSide ? "end" : "start",
      text: `${item.label} ${chartMoney(item.value, payload.currency)}`,
    };
  });

  document.getElementById("chartCanvas").innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(payload.name)} 종가 차트">
      <defs>
        <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity=".18"></stop>
          <stop offset="72%" stop-color="var(--brand)" stop-opacity=".045"></stop>
          <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${width - 6}" y="${(tick.y + 4).toFixed(2)}">${esc(chartMoney(tick.value, payload.currency))}</text>
      `).join("")}
      ${vGrid.ticks.map(tick => `
        <line class="chart-grid perf-vgrid" x1="${tick.x.toFixed(2)}" x2="${tick.x.toFixed(2)}" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(2)}"></line>
      `).join("")}
      ${vGrid.ticks.map((tick, index) => {
        if (index % labelEvery !== 0) return "";
        const anchor = tick.x < pad.left + 18 ? "start" : tick.x > pad.left + plotW - 18 ? "end" : "middle";
        return `<text class="chart-x-label" x="${tick.x.toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${esc(perfGridLabel(tick.time, vGrid.unit))}</text>`;
      }).join("")}
      <path class="chart-area" d="${area}"></path>
      <path class="chart-line" d="${line}"></path>
      ${extremes.map(item => `
        <g class="chart-extreme ${item.kind}">
          <circle cx="${item.x.toFixed(2)}" cy="${item.y.toFixed(2)}" r="4"></circle>
          <text x="${item.labelX.toFixed(2)}" y="${item.labelY.toFixed(2)}" text-anchor="${item.anchor}">${esc(item.text)}</text>
        </g>
      `).join("")}
      <g id="chartSelectionGroup" class="chart-selection hidden">
        <rect id="chartSelectionRect" class="chart-selection-range" x="0" y="${pad.top}" width="0" height="${plotH}"></rect>
        <line id="chartSelectionStartLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        <line id="chartSelectionEndLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        <rect id="chartSelectionTooltipBox" class="chart-selection-box" x="0" y="0" width="0" height="0" rx="5"></rect>
        <text id="chartSelectionTooltip" class="chart-selection-tooltip" x="0" y="0"></text>
      </g>
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      ${markers.map(marker => `
        <g class="trade-marker ${marker.cls}" data-x="${marker.x.toFixed(2)}" data-y="${marker.y.toFixed(2)}" data-tooltip="${esc(marker.tooltip)}" tabindex="0" role="img" aria-label="${esc(marker.tooltip)}">
          <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="8"></circle>
          <text x="${marker.x.toFixed(2)}" y="${(marker.y + 4).toFixed(2)}">${marker.label}</text>
        </g>
      `).join("")}
      <circle class="chart-last-dot" cx="${xFor(points.length - 1).toFixed(2)}" cy="${yFor(last).toFixed(2)}" r="4"></circle>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        <circle id="chartHoverDot" class="chart-hover-dot" cx="0" cy="0" r="4"></circle>
        <rect id="chartTooltipBox" class="chart-tooltip-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartTooltip" class="chart-tooltip" x="0" y="0">-</text>
      </g>
    </svg>
    ${renderChartCompareControls()}
    ${renderChartRangeButtons()}
  `;
  bindChartInteractions(points, payload, { width, height, pad, plotW, plotH, xFor, yFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
}

function updateSortHeaders() {
  document.querySelectorAll("th[data-key]").forEach(th => {
    th.classList.toggle("sort-desc", th.dataset.key === sortKey && sortDir < 0);
    th.classList.toggle("sort-asc", th.dataset.key === sortKey && sortDir > 0);
  });
}

function renderTradeControls() {
  const accounts = flattenAccounts();
  const accountSelect = document.getElementById("tradeAccount");
  const tickerInput = document.getElementById("tradeTicker");
  const currentAccount = selectedTrade.accountId || accountSelect.value || (selectionMode !== "all" ? Array.from(selectedAccounts)[0] : "") || accounts[0]?.id || "";
  accountSelect.innerHTML = accounts.map(a => `
    <option value="${esc(a.id)}" ${a.id === currentAccount ? "selected" : ""}>${esc(a.memberName)} · ${esc(a.name)}</option>
  `).join("");
  if (!selectedTrade.accountId) selectedTrade.accountId = accountSelect.value;
  const tickerMap = new Map();
  (data.tickers || []).forEach(t => tickerMap.set(t.ticker, t.name || t.ticker));
  holdingsForAccount(accountSelect.value).forEach(h => tickerMap.set(h.ticker, h.name || h.ticker));
  document.getElementById("tickerOptions").innerHTML = Array.from(tickerMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([ticker, name]) => `
    <option value="${esc(ticker)}">${esc(name)}</option>
  `).join("");
  if (selectedTrade.ticker && tickerInput.value.toUpperCase() !== selectedTrade.ticker) tickerInput.value = selectedTrade.ticker;
  applyTradeHoldingDefaults(false);
  updateTradeScope();
}

function applyTradeHoldingDefaults(overwriteName = false) {
  const holding = findTradeHolding();
  const ticker = (document.getElementById("tradeTicker").value || selectedTrade.ticker || "").trim().toUpperCase();
  const meta = findTickerMeta(ticker);
  if (!holding && !meta) return;
  const nameInput = document.getElementById("tradeName");
  const priceInput = document.getElementById("tradePrice");
  const currency = holding?.currency || meta?.currency || "USD";
  const price = holding?.current_price ?? meta?.current_price;
  document.getElementById("tradeCurrency").value = currency;
  if (overwriteName || !nameInput.value) nameInput.value = holding?.name || meta?.name || ticker;
  if (!priceInput.value && price != null) priceInput.value = Number(price).toFixed(currency === "KRW" || currency === "JPY" ? 0 : 2);
}

function updateTradeScope() {
  const accounts = visibleAccounts();
  const ticker = (document.getElementById("tradeTicker").value || "").trim().toUpperCase();
  const accountText = selectionMode === "all" ? "전체 계좌" : accounts.length === 1 ? `${accounts[0].memberName} · ${accounts[0].name}` : `${accounts.length}개 계좌`;
  document.getElementById("tradeScope").textContent = ticker ? `${accountText} · 입력 ${ticker}` : accountText;
}

function renderTransactionPager(totalRows) {
  const pager = document.getElementById("transactionPager");
  const totalPages = Math.max(1, Math.ceil(totalRows / transactionPageSize));
  if (totalRows <= transactionPageSize) {
    pager.innerHTML = "";
    return;
  }
  pager.innerHTML = `
    <button class="ghost-btn" type="button" data-tx-page="prev" ${transactionPage <= 1 ? "disabled" : ""}>이전</button>
    <span class="pill">${transactionPage} / ${totalPages}</span>
    <button class="ghost-btn" type="button" data-tx-page="next" ${transactionPage >= totalPages ? "disabled" : ""}>다음</button>
  `;
  pager.querySelectorAll("[data-tx-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const total = Math.max(1, Math.ceil(transactionRows.length / transactionPageSize));
      transactionPage += btn.dataset.txPage === "next" ? 1 : -1;
      transactionPage = Math.min(total, Math.max(1, transactionPage));
      renderTransactions(transactionRows, false);
    });
  });
}

function renderTransactions(rows, resetPage = true) {
  transactionRows = rows || [];
  if (resetPage) transactionPage = 1;
  const tbody = document.getElementById("transactions");
  if (transactionRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="flat">거래내역 없음</td></tr>`;
    renderTransactionPager(0);
    return;
  }
  const totalPages = Math.max(1, Math.ceil(transactionRows.length / transactionPageSize));
  transactionPage = Math.min(totalPages, Math.max(1, transactionPage));
  const pageRows = transactionRows.slice((transactionPage - 1) * transactionPageSize, transactionPage * transactionPageSize);
  tbody.innerHTML = pageRows.map(tx => {
    const sideClass = tx.side === "BUY" ? "side-buy" : "side-sell";
    const sideText = tx.side === "BUY" ? "매수" : "매도";
    const amount = (tx.qty || 0) * (tx.price || 0);
    const account = `${tx.member || ""} · ${tx.account_name || tx.account_type || ""}`;
    const currentPrice = currentPriceForTicker(tx.ticker);
    const diff = currentPrice != null && tx.price ? currentPrice - tx.price : null;
    const pct = diff != null && tx.price ? diff / tx.price * 100 : null;
    const compareClass = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    const compareArrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "→";
    const compareText = diff != null
      ? `<span class="change-cell ${compareClass}"><span aria-hidden="true">${compareArrow}</span>${fmt2.format(Math.abs(pct))}%</span>`
      : "-";
    return `
      <tr>
        <td>${esc(tx.trade_date)}</td>
        <td>${esc(account)}</td>
        <td>${esc(tx.ticker)}</td>
        <td>${esc(tx.name || "")}</td>
        <td><span class="${sideClass}">${sideText}</span></td>
        <td>${fmt2.format(tx.qty || 0)}</td>
        <td>${unitMoney(tx.price, tx.currency)}</td>
        <td>${money(amount, tx.currency)}</td>
        <td>${compareText}</td>
      </tr>
    `;
  }).join("");
  renderTransactionPager(transactionRows.length);
}

function setTransactionsExpanded(expanded, shouldLoad = false) {
  transactionsExpanded = expanded;
  const panel = document.querySelector(".transaction-panel");
  const toggle = document.getElementById("transactionToggle");
  panel.classList.toggle("collapsed", !expanded);
  toggle.textContent = expanded ? "접기" : "펼치기";
  toggle.setAttribute("aria-expanded", String(expanded));
  if (expanded && shouldLoad) loadTransactions().catch(showTradeError);
}

async function loadTransactions() {
  if (!transactionsExpanded) return;
  if (!data) return;
  const accounts = visibleAccounts();
  const accountIds = accounts.map(a => a.id);
  const ticker = (document.getElementById("tradeTicker").value || "").trim().toUpperCase();
  selectedTrade = { accountId: document.getElementById("tradeAccount").value, ticker };
  updateTradeScope();
  if (accountIds.length === 0) {
    renderTransactions([]);
    return;
  }
  const payload = await apiFetchTransactions(accountIds, selectionMode === "all");
  renderTransactions(payload.transactions);
}

function selectTradeTarget(accountId, ticker) {
  selectedTrade = { accountId: String(accountId || ""), ticker: String(ticker || "").toUpperCase() };
  setTransactionsExpanded(true);
  document.getElementById("tradeAccount").value = selectedTrade.accountId;
  document.getElementById("tradeTicker").value = selectedTrade.ticker;
  document.getElementById("tradeName").value = "";
  document.getElementById("tradePrice").value = "";
  renderTradeControls();
  loadTransactions().catch(showTradeError);
  document.querySelector(".transaction-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showTradeStatus(message, isError = false) {
  const el = document.getElementById("tradeStatus");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function showTradeError(err) {
  showTradeStatus(err.message || String(err), true);
}

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

function setTradeSide(side) {
  const value = side === "SELL" ? "SELL" : "BUY";
  document.getElementById("tradeSide").value = value;
  document.querySelectorAll(".trade-side-toggle .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.side === value);
    btn.setAttribute("aria-pressed", String(btn.dataset.side === value));
  });
}

function initTradeSideToggle() {
  document.querySelectorAll(".trade-side-toggle .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => setTradeSide(btn.dataset.side));
  });
  setTradeSide(document.getElementById("tradeSide").value);
}

function setTradeApply(enabled) {
  const input = document.getElementById("tradeApply");
  const button = document.getElementById("tradeApplyToggle");
  input.checked = Boolean(enabled);
  button.classList.toggle("active", input.checked);
  button.setAttribute("aria-pressed", String(input.checked));
  button.textContent = input.checked ? "반영" : "미반영";
}

function initTradeApplyToggle() {
  const input = document.getElementById("tradeApply");
  const button = document.getElementById("tradeApplyToggle");
  button.addEventListener("click", () => setTradeApply(!input.checked));
  setTradeApply(input.checked);
}

function renderWatchPending() {
  const list = document.getElementById("watchPending");
  const apply = document.getElementById("watchApply");
  list.innerHTML = watchPending.map(item => `
    <li>
      <span><strong>${esc(item.ticker)}</strong> · ${esc(item.name)} · ${esc(item.currency)}</span>
      <button class="ghost-btn" type="button" data-watch-remove="${esc(item.ticker)}">삭제</button>
    </li>
  `).join("");
  apply.disabled = watchPending.length === 0;
  list.querySelectorAll("[data-watch-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      watchPending = watchPending.filter(item => item.ticker !== btn.dataset.watchRemove);
      renderWatchPending();
    });
  });
}

function setWatchStatus(message, error = false) {
  const el = document.getElementById("watchStatus");
  el.textContent = message || "";
  el.classList.toggle("error", error);
}

function renderWatchLookup(item = null) {
  watchLookupResult = item;
  const result = document.getElementById("watchResult");
  const add = document.getElementById("watchAdd");
  if (!item) {
    result.textContent = "-";
    add.disabled = true;
    return;
  }
  result.textContent = `${item.ticker} · ${item.name} · ${item.currency} · ${item.category}`;
  add.disabled = watchPending.some(row => row.ticker === item.ticker);
}

function initWatchlistControls() {
  const modal = document.getElementById("watchModal");
  const input = document.getElementById("watchTickerInput");
  document.getElementById("watchlistOpen").addEventListener("click", () => {
    setWatchStatus("");
    renderWatchLookup(null);
    modal.showModal();
    input.focus();
  });
  document.getElementById("watchClose").addEventListener("click", () => modal.close());
  document.getElementById("watchLookup").addEventListener("click", async () => {
    const query = input.value.trim();
    if (!query) return;
    setWatchStatus("검색 중...");
    try {
      const payload = await apiLookupTicker(query);
      renderWatchLookup(payload.ticker);
      setWatchStatus("");
    } catch (err) {
      renderWatchLookup(null);
      setWatchStatus(err.message || String(err), true);
    }
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      document.getElementById("watchLookup").click();
    }
  });
  document.getElementById("watchAdd").addEventListener("click", () => {
    if (!watchLookupResult) return;
    if (!watchPending.some(item => item.ticker === watchLookupResult.ticker)) {
      watchPending = [...watchPending, watchLookupResult];
      renderWatchPending();
    }
    input.value = "";
    renderWatchLookup(null);
  });
  document.getElementById("watchApply").addEventListener("click", async () => {
    if (!watchPending.length) return;
    setWatchStatus("등록 중...");
    document.getElementById("watchApply").disabled = true;
    try {
      const result = await apiAddWatchlist(watchPending);
      watchPending = [];
      renderWatchPending();
      statsData = {};
      statsLoadKey = "";
      statsFetchedTickers = new Set();
      await load();
      setWatchStatus(result.message || "등록되었습니다. 동기화는 백그라운드에서 진행됩니다.");
    } catch (err) {
      setWatchStatus(err.message || String(err), true);
      renderWatchPending();
    } finally {
      document.getElementById("watchApply").disabled = false;
    }
  });
  renderWatchPending();
}

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
    activeDetailTab = btn.dataset.tab || "detail";
    ensureTabSortKey(activeDetailTab);
    renderTable();
  });
});
document.querySelectorAll("th[data-key]").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (sortKey === key) sortDir *= -1;
    else { sortKey = key; sortDir = defaultSortDir[key] || -1; }
    renderTable();
  });
});
initAutoRefreshControls();
initUsPriceControls();
initThemeControl();
initWatchlistControls();
initChartRangeModal();
initTradeSideToggle();
initTradeApplyToggle();
setTransactionsExpanded(false);
load().then(syncChartRoute).catch(err => showTradeStatus(err.message || String(err), true));

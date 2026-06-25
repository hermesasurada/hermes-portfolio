function ensureTabSortKey(tab) {
  const currentSet = tab === "stats" ? new Set([...statsSortKeys, ...detailSortKeys]) : tab === "dividend" ? dividendSortKeys : detailSortKeys;
  const state = sortState[tab] || sortState.detail;
  if (currentSet.has(state.key)) return;
  state.key = tab === "dividend" ? "pay_date" : tab === "stats" ? "market_cap_usd" : "value_krw";
  state.dir = defaultSortDir[state.key] || -1;
}

function syncSortGlobals(tab = activeDetailTab) {
  ensureTabSortKey(tab);
  const state = sortState[tab] || sortState.detail;
  sortKey = state.key;
  sortDir = state.dir;
}

function setCurrentSort(key) {
  syncSortGlobals(activeDetailTab);
  const state = sortState[activeDetailTab] || sortState.detail;
  if (state.key === key) state.dir *= -1;
  else {
    state.key = key;
    state.dir = defaultSortDir[key] || -1;
  }
  syncSortGlobals(activeDetailTab);
}

function flattenAccounts() {
  return data.members.flatMap(m => m.accounts.map(a => ({...a, memberName: m.name})));
}
function isHenryOverseasAccount(account) {
  return String(account.memberName || "").trim().toLowerCase() === "henry"
    && account.type === "overseas";
}
function accountGroupKey(account) {
  if (isHenryOverseasAccount(account)) return "henry_overseas";
  const type = account.type || "other";
  // 연금저축(pension_kr)·퇴직연금(retirement_kr)을 하나의 "연금" 카테고리로 통합
  if (type === "pension_kr" || type === "retirement_kr") return "pension";
  return type;
}
function portfolioKstHour() {
  const asOfMatch = String(data?.as_of || "").match(/T(\d{2}):/);
  if (asOfMatch) return Number(asOfMatch[1]);
  const hourPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date()).find(part => part.type === "hour");
  return Number(hourPart?.value || 0);
}
function defaultAccountTypesForHour(hour) {
  const types = new Set(["bitcoin"]);
  if (hour >= 17 || hour < 8) types.add("overseas");
  if (hour >= 8 && hour < 18) {
    types.add("kr_individual");
    types.add("pension_kr");
    types.add("retirement_kr");
  }
  return types;
}
function applyTimeBasedDefaultAccountSelection() {
  if (defaultAccountSelectionApplied || !data) return;
  const accountTypes = defaultAccountTypesForHour(portfolioKstHour());
  selectedAccounts = new Set(
    flattenAccounts()
      .filter(account => accountTypes.has(account.type) && !isHenryOverseasAccount(account))
      .map(account => account.id)
  );
  selectionMode = "custom";
  defaultAccountSelectionApplied = true;
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
function showIndexesEnabled() {
  return document.getElementById("showIndexesToggle")?.checked || false;
}
function interestHeldOnlyEnabled() {
  return document.getElementById("interestHeldToggle")?.checked || false;
}
function heldTickerSet() {
  const set = new Set();
  flattenHoldings().forEach(h => {
    if (Number(h.qty) > 0) set.add(String(h.ticker).toUpperCase());
  });
  return set;
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
function hasPosition(row) {
  return Number(row?.qty) > 0;
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
  const nameTokens = new Set(upperName.split(/[^A-Z0-9]+/).filter(Boolean));
  if (category === "crypto" || upperTicker === "BTC") return "crypto";
  if (category === "index") return "index";
  if (["ARKG", "ARKK", "QLD", "TQQQ", "SQQQ", "SOXL", "SOXS", "SPY", "VOO", "VTI", "IVV", "QQQ", "DIA", "IWM", "SCHD", "1629.T", "200A.T"].includes(upperTicker)) return "etf";
  if (["KODEX", "TIGER", "ACE", "SOL", "ETF", "ISHARES", "PROSHARES", "DIREXION"].some(token => nameTokens.has(token))) return "etf";
  return "stock";
}

function watchlistRowForAccount(tickerMeta, account) {
  const price = Number(tickerMeta.current_price);
  const currentPrice = Number.isFinite(price) ? price : null;
  const previous = Number(tickerMeta.previous_price);
  const previousPrice = Number.isFinite(previous) ? previous : null;
  const fallbackChange = currentPrice != null && previousPrice ? currentPrice - previousPrice : null;
  const serverChange = Number(tickerMeta.change);
  const serverChangePct = Number(tickerMeta.change_pct);
  const change = Number.isFinite(serverChange) ? serverChange : fallbackChange;
  const changePct = Number.isFinite(serverChangePct)
    ? serverChangePct
    : fallbackChange != null && previousPrice ? fallbackChange / previousPrice * 100 : null;
  const currency = tickerMeta.currency || "USD";
  const fxRate = Number(data?.fx?.[currency] || 1);
  const assetClass = tickerAssetClass(tickerMeta.ticker, tickerMeta.name, tickerMeta.category);
  return {
    is_watchlist: true,
    ticker: tickerMeta.ticker,
    name: tickerMeta.name || tickerMeta.ticker,
    category: tickerMeta.category || null,
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

function indexRows() {
  const order = new Map(["SP500", "NASDAQ", "KOSPI"].map((ticker, index) => [ticker, index]));
  return (data?.tickers || [])
    .filter(t => t.ticker && t.category === "index")
    .map(t => watchlistRowForAccount(t, null))
    .sort((a, b) => (order.get(String(a.ticker).toUpperCase()) ?? 99) - (order.get(String(b.ticker).toUpperCase()) ?? 99));
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
        has_position: false,
        memberSet: new Set(),
        accountSet: new Set()
      });
    }
    const g = grouped.get(key);
    if (hasPosition(r)) {
      g.qty += r.qty || 0;
      g.value += r.value || 0;
      g.value_krw += r.value_krw || 0;
      g.change_krw += r.change_krw || 0;
      g.has_position = true;
    }
    g.memberSet.add(r.memberName);
    g.accountSet.add(r.accountName);
  });
  return Array.from(grouped.values()).map(r => {
    const members = Array.from(r.memberSet);
    const accounts = Array.from(r.accountSet);
    delete r.memberSet;
    delete r.accountSet;
    const positionFields = r.has_position ? {} : {
      qty: null,
      value: null,
      value_krw: null,
      change_krw: null,
      weight_pct: null,
    };
    return {
      ...r,
      ...positionFields,
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
  }, 60 * 1000);   // 서버 라이브 캐시 60s와 맞춤 (외부는 배치 1회/분)
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
  const panelName = typeof activeSidebarTab !== "undefined" && activeSidebarTab === "interest"
    ? "관심목록"
    : "계좌";
  accountPanel?.classList.toggle("mobile-collapsed", mobileAccountsCollapsed);
  if (accountToggle) {
    accountToggle.setAttribute("aria-expanded", String(!mobileAccountsCollapsed));
    accountToggle.setAttribute("aria-label", mobileAccountsCollapsed ? `${panelName} 펼치기` : `${panelName} 접기`);
    accountToggle.title = mobileAccountsCollapsed ? `${panelName} 펼치기` : `${panelName} 접기`;
  }
}

// 종목별 직전 렌더 현재가 — 가격 변동 셀 펄스 판정용
const priceFlashMap = new Map();

// ── 히어로 요약 (총 평가액 + 오늘 손익) ──
// 값은 renderAccounts와 동일 기준(보유분 고정, 표 필터 무관)으로 현재 선택 계좌 합계.
function updateHeroSummary(byAccount, totalStats, accounts) {
  const valueEl = document.getElementById("heroValue");
  const labelEl = document.getElementById("heroLabel");
  const changeEl = document.getElementById("heroChange");
  if (!valueEl || !labelEl || !changeEl) return;
  let value = 0;
  let change = 0;
  let label = "총 평가액 · 전체 계좌";
  if (selectionMode === "all") {
    value = totalStats.value_krw;
    change = totalStats.change_krw;
  } else {
    const selected = accounts.filter(a => isAccountSelected(a.id));
    selected.forEach(a => {
      const stat = byAccount.get(a.id);
      if (!stat) return;
      value += stat.value_krw || 0;
      change += stat.change_krw || 0;
    });
    label = selected.length === 1
      ? `총 평가액 · ${selected[0].memberName} ${selected[0].name}`
      : `총 평가액 · ${selected.length}개 계좌`;
  }
  labelEl.textContent = label;
  valueEl.textContent = krw(value);
  const previous = value - change;
  const pct = previous > 0 ? (change / previous) * 100 : null;
  const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
  changeEl.className = `hero-change ${cls}`;
  changeEl.textContent = `${arrow} ${krw(Math.abs(change))}${
    pct == null ? "" : ` · ${pct > 0 ? "+" : pct < 0 ? "−" : ""}${fmt2.format(Math.abs(pct))}%`
  }`;
}

function renderAccounts() {
  // 계좌현황과 메인 포트폴리오 표는 실제 보유 수량이 있는 행만 집계한다.
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
    { key: "other", label: "기타" },
    { key: "henry_overseas", label: "Henry 해외주식" }
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
  updateHeroSummary(byAccount, totalStats, accounts);
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
  const currencyFilter = currencyFilterValue();
  let rows = flattenHoldings().filter(r => (r.qty || 0) > 0);
  const fxAdjusted = fxAdjustedEnabled();
  if (!options.ignoreAccount && selectionMode !== "all") rows = rows.filter(r => selectedAccounts.has(r.accountId));
  if (!options.ignoreCurrency && currencyFilter !== "all") rows = rows.filter(r => r.currency === currencyFilter);
  if (showIndexesEnabled() && !options.ignoreIndexes) {
    let indexes = indexRows();
    if (!options.ignoreCurrency && currencyFilter !== "all") indexes = indexes.filter(r => r.currency === currencyFilter);
    const indexTickers = new Set(indexes.map(r => String(r.ticker || "").toUpperCase()));
    rows = rows.filter(r => !indexTickers.has(String(r.ticker || "").toUpperCase())).concat(indexes);
  }
  const enrichRows = sourceRows => sourceRows.map(row => ({
      ...row,
      display_change_pct: holdingChangePct(row, fxAdjusted),
      change_krw: holdingChangeKrw(row, fxAdjusted),
      current_price_krw: holdingUnitKrw(row),
      next_earnings_date: row.next_earnings_date || null
    }));
  rows = enrichRows(rows);
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

function sortRows(rows, tab = activeDetailTab) {
  const state = sortState[tab] || sortState.detail;
  rows.sort((a, b) => {
    const av = a[state.key], bv = b[state.key];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av ?? "").localeCompare(String(bv ?? ""), "ko-KR", { numeric: true, sensitivity: "base" }) * state.dir;
    }
    const an = av != null && Number.isFinite(Number(av)) ? Number(av) : -Infinity;
    const bn = bv != null && Number.isFinite(Number(bv)) ? Number(bv) : -Infinity;
    return (an - bn) * state.dir;
  });
  return rows;
}

function syncFilterToggleControls() {
  [
    ["fxAdjustedToggle", "fxAdjustedControl"],
    ["showIndexesToggle", "showIndexesControl"],
    ["interestHeldToggle", "interestHeldControl"],
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
  const showingInterest = interestModeActive() && !showingChart;
  const showingFxInterest = showingInterest && interestGroupIsFx();
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", !showingChart && !showingInterest && btn.dataset.tab === activeDetailTab);
  });
  document.getElementById("tableTitle").classList.toggle("hidden", showingChart);
  document.getElementById("detailTableWrap").classList.toggle("hidden", showingChart || showingInterest || activeDetailTab !== "detail");
  document.getElementById("statsTableWrap").classList.toggle("hidden", showingChart || showingInterest || activeDetailTab !== "stats");
  document.getElementById("dividendTableWrap").classList.toggle("hidden", showingChart || showingInterest || activeDetailTab !== "dividend");
  document.getElementById("interestTableWrap").classList.toggle("hidden", showingChart || !showingInterest);
  document.getElementById("chartView").classList.toggle("hidden", !showingChart);
  document.getElementById("chartBack").classList.toggle("hidden", !showingChart);
  document.getElementById("chartIntervalControl")?.classList.toggle("hidden", !chartTicker || performanceChartOpen);
  document.getElementById("chartDisplayControls")?.classList.toggle("hidden", !chartTicker || performanceChartOpen);
  document.getElementById("performanceDetailControl")?.classList.toggle("hidden", !performanceChartOpen);
  document.querySelector(".detail-tabs").classList.toggle("hidden", showingChart || showingInterest);
  // 통계 지표 도움말 버튼은 통계 탭(차트 아닐 때)에서만 노출
  document.getElementById("statsHelpOpen")?.classList.toggle("hidden", showingChart || showingInterest || activeDetailTab !== "stats");
  document.getElementById("fxAdjustedControl")?.classList.toggle("hidden", showingChart || showingFxInterest);
  document.getElementById("currencyFilterControl")?.classList.toggle("hidden", showingChart || showingFxInterest);
  document.getElementById("rowCount")?.classList.toggle("hidden", showingChart);
  document.getElementById("showIndexesControl")?.classList.toggle("hidden", showingChart || showingInterest);
  // '보유종목만' 필터는 관심목록 페이지에서만 노출(환율 그룹 제외 — FX는 보유개념 없음)
  document.getElementById("interestHeldControl")?.classList.toggle("hidden", !showingInterest || showingFxInterest);
  // '기타'(자동 분류 가상 그룹)는 직접 추가 불가 → 추가 폼 숨김
  document.getElementById("interestMainItemForm")?.classList.toggle(
    "hidden",
    showingChart || !showingInterest || showingFxInterest || Boolean(activeInterestGroup()?.fixed)
  );
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

function syncTransactionPanel() {
  // 차트 화면에서는 하단 거래내역 패널을 숨긴다.
  const panel = document.querySelector(".transaction-panel");
  if (panel) panel.classList.toggle("hidden", Boolean(performanceChartOpen || chartTicker || interestModeActive()));
}

let frozenColumnsFrame = 0;

function schedulePcFrozenColumns() {
  cancelAnimationFrame(frozenColumnsFrame);
  frozenColumnsFrame = requestAnimationFrame(syncPcFrozenColumns);
}

function syncTickerNameColumnWidth(table, { min = 108, max = 180 } = {}) {
  if (!table) return min;
  if (window.matchMedia?.("(max-width: 980px)").matches) {
    min = Math.min(min, 96);
    max = Math.min(max, 132);
  }
  const texts = Array.from(table.querySelectorAll("tbody .ticker-link .asset-name, tbody .ticker-link .ticker-symbol"));
  const canvas = syncTickerNameColumnWidth.canvas ||= document.createElement("canvas");
  const context = canvas.getContext("2d");
  const contentWidth = texts.reduce((width, element) => {
    if (!context) return width;
    const style = getComputedStyle(element);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return Math.max(width, context.measureText(element.textContent || "").width);
  }, 0);
  const width = Math.ceil(Math.min(max, Math.max(min, contentWidth + 14)));
  table.style.setProperty("--ticker-name-width", `${width}px`);
  const column = table.querySelector("colgroup col:nth-child(2)");
  if (column) column.style.width = `${width}px`;
  return width;
}

function syncPcFrozenColumns() {
  const frozenCells = document.querySelectorAll(".pc-frozen-col, .pc-frozen-edge");
  frozenCells.forEach(cell => {
    cell.classList.remove("pc-frozen-col", "pc-frozen-edge");
    cell.style.removeProperty("--pc-frozen-left");
  });
  // PC·모바일 공통: 가로 스크롤 시 로고+종목명을 틀고정 (뷰포트 제한 없음)

  [
    ["#detailTableWrap table", 2],
    ["#statsTableWrap table", 2],
    ["#dividendTableWrap table", 3],
    ["#interestTableWrap table", 2]
  ].forEach(([selector, columnCount]) => {
    const table = document.querySelector(selector);
    if (!table || table.closest(".hidden")) return;
    // 컬럼 헤더 행 기준으로 폭 측정 — 통계탭은 그룹 헤더(colspan)가 첫 행이라
    // tr:first-child면 폭이 그룹 폭으로 잘못 잡힌다. 단일 헤더 표는 first==last.
    const headers = selector === "#interestTableWrap table"
      ? Array.from(table.querySelectorAll("thead th[data-interest-col]"))
        .sort((a, b) => Number(a.dataset.interestCol) - Number(b.dataset.interestCol))
      : Array.from(table.querySelectorAll("thead tr:last-child > th"));
    let left = 0;
    for (let index = 0; index < Math.min(columnCount, headers.length); index += 1) {
      const cells = [headers[index]];
      table.querySelectorAll("tbody > tr").forEach(row => {
        const cell = row.cells[index];
        if (cell && cell.colSpan === 1) cells.push(cell);
      });
      const isEdge = index === columnCount - 1;
      cells.forEach(cell => {
        cell.classList.add("pc-frozen-col");
        if (isEdge) cell.classList.add("pc-frozen-edge");
        cell.style.setProperty("--pc-frozen-left", `${left}px`);
      });
      left += headers[index].getBoundingClientRect().width;
    }
  });
}

function renderTable() {
  syncSortGlobals(activeDetailTab);
  syncTransactionPanel();
  syncFilterToggleControls();
  syncDetailTabs();
  if (interestModeActive() && !chartTicker && !performanceChartOpen) {
    renderInterestMainTable();
    return;
  }
  const rows = filteredRows();
  const hideExtendedColumn = Boolean(data?.us_market?.is_regular);
  const accounts = flattenAccounts();
  const selected = selectionMode === "all" ? accounts : accounts.filter(a => selectedAccounts.has(a.id));
  document.querySelector("#detailTableWrap thead .extended-change-col")
    ?.classList.toggle("hidden", hideExtendedColumn);
  updateSortHeaders();
  if (!chartTicker) {
    document.getElementById("tableTitle").textContent = selectionMode === "all" ? "전체 계좌" : selected.length === 1 ? `${selected[0].memberName} · ${selected[0].name}` : selected.length > 1 ? `${selected.length}개 계좌` : "선택 없음";
  }
  document.getElementById("rowCount").textContent = `${rows.length} rows`;
  document.getElementById("holdings").innerHTML = rows.map(r => {
    const noPosition = !hasPosition(r);
    // 직전 렌더 대비 현재가가 바뀐 종목만 가격 셀에 펄스 (정렬·필터 재렌더는 가격 동일→펄스 없음)
    const prevPrice = priceFlashMap.get(r.ticker);
    const priceNum = Number(r.current_price);
    let pulse = "";
    if (prevPrice != null && Number.isFinite(priceNum) && priceNum !== prevPrice) {
      pulse = priceNum > prevPrice ? " price-pulse-up" : " price-pulse-down";
    }
    return `
    <tr class="${tableRowClass(r)}">
      <td class="logo-cell">${logoMarkup(r)}</td>
      <td>
        <span class="ticker-text">
          <a class="ticker-link" href="${esc(chartHref(r.ticker))}" data-chart-ticker="${esc(r.ticker)}">
            <span class="asset-name">${r.name}</span>
            <span class="ticker-symbol">${r.ticker}</span>
          </a>
        </span>
      </td>
      <td>${changeMarkup(r)}</td>
      <td class="extended-change-col ${hideExtendedColumn ? "hidden" : ""}">${extendedChangeText(r) || "-"}</td>
      <td class="price-cell-td${pulse}">${currentPriceMarkup(r)}</td>
      <td>${noPosition ? "-" : changeKrwText(r.change_krw)}</td>
      <td>${noPosition ? "-" : fmt2.format(r.qty)}</td>
      <td>${noPosition ? "-" : valueMarkup(r)}</td>
      <td>${noPosition ? "-" : weightText(r.weight_pct)}</td>
      <td>${noPosition ? "-" : earningsText(r.next_earnings_date)}</td>
      <td>${r.is_watchlist ? "-" : `<button class="ghost-btn tx-pick" type="button" data-account="${esc(r.accountId)}" data-ticker="${esc(r.ticker)}">거래</button>`}</td>
    </tr>
  `;
  }).join("");
  // 다음 렌더의 펄스 판정용으로 현재가 스냅샷 갱신
  rows.forEach(r => {
    const priceNum = Number(r.current_price);
    if (Number.isFinite(priceNum)) priceFlashMap.set(r.ticker, priceNum);
  });
  document.querySelectorAll(".tx-pick").forEach(btn => {
    btn.addEventListener("click", () => {
      selectTradeTarget(btn.dataset.account, btn.dataset.ticker);
    });
  });
  bindChartLinks();
  syncTickerNameColumnWidth(document.querySelector("#detailTableWrap table"));
  if (activeDetailTab === "stats") renderStatsTable(rows);
  if (activeDetailTab === "dividend") renderDividendTable();
  schedulePcFrozenColumns();
}

function bindChartLinks() {
  document.querySelectorAll(".ticker-link").forEach(btn => {
    btn.addEventListener("click", () => {
      openChart(btn.dataset.chartTicker);
    });
  });
}

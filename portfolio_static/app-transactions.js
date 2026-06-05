function updateSortHeaders() {
  document.querySelectorAll("th[data-key], .name-head .sort-mini[data-key]").forEach(el => {
    el.classList.toggle("sort-desc", el.dataset.key === sortKey && sortDir < 0);
    el.classList.toggle("sort-asc", el.dataset.key === sortKey && sortDir > 0);
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

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

// 종목명을 티커 기준으로 자동 채움(읽기전용 입력). 로컬(보유/메타)에 없으면 lookup.
async function resolveTradeName() {
  const ticker = (document.getElementById("tradeTicker").value || "").trim().toUpperCase();
  const nameInput = document.getElementById("tradeName");
  if (!nameInput) return;
  if (!ticker) { nameInput.value = ""; return; }
  const holding = findTradeHolding();
  const meta = findTickerMeta(ticker);
  let name = holding?.name || meta?.name || "";
  if (!name) {
    try {
      const res = await apiLookupTicker(ticker);
      name = res?.ticker?.name || "";
      if (res?.ticker?.currency) document.getElementById("tradeCurrency").value = res.ticker.currency;
    } catch { /* lookup 실패 시 티커로 대체 */ }
  }
  // 입력 티커가 그새 바뀌지 않았을 때만 반영
  if ((document.getElementById("tradeTicker").value || "").trim().toUpperCase() === ticker) {
    nameInput.value = name || ticker;
  }
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

const TX_TRASH_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></svg>`;

function txEditRow(tx) {
  const account = `${tx.member || ""} · ${tx.account_name || tx.account_type || ""}`;
  return `
    <tr class="tx-editing" data-tx-row="${tx.id}">
      <td><input type="date" class="tx-edit-input" data-tx-field="trade_date" value="${esc(tx.trade_date)}"></td>
      <td>${esc(account)}</td>
      <td>${esc(tx.ticker)}</td>
      <td>${esc(tx.name || "")}</td>
      <td><select class="tx-edit-input" data-tx-field="side">
        <option value="BUY" ${tx.side === "BUY" ? "selected" : ""}>매수</option>
        <option value="SELL" ${tx.side === "SELL" ? "selected" : ""}>매도</option>
      </select></td>
      <td><input type="number" class="tx-edit-input" data-tx-field="qty" value="${tx.qty}" step="any" min="0"></td>
      <td><input type="number" class="tx-edit-input" data-tx-field="price" value="${tx.price}" step="any" min="0"></td>
      <td>-</td>
      <td>-</td>
      <td class="tx-actions">
        <button class="tx-action-btn tx-save" type="button" data-tx-save="${tx.id}" title="저장">저장</button>
        <button class="tx-action-btn" type="button" data-tx-cancel title="취소">취소</button>
      </td>
    </tr>
  `;
}

function txViewRow(tx) {
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
      <td class="tx-actions">
        <button class="tx-action-btn" type="button" data-tx-edit="${tx.id}" title="수정" aria-label="수정">✎</button>
        <button class="tx-action-btn tx-del" type="button" data-tx-delete="${tx.id}" title="삭제" aria-label="삭제">${TX_TRASH_SVG}</button>
      </td>
    </tr>
  `;
}

function bindTransactionRowActions(tbody) {
  tbody.querySelectorAll("[data-tx-edit]").forEach(btn => btn.addEventListener("click", () => {
    editingTxId = Number(btn.dataset.txEdit);
    renderTransactions(transactionRows, false);
  }));
  tbody.querySelectorAll("[data-tx-cancel]").forEach(btn => btn.addEventListener("click", () => {
    editingTxId = null;
    renderTransactions(transactionRows, false);
  }));
  tbody.querySelectorAll("[data-tx-save]").forEach(btn => btn.addEventListener("click", () => saveTransactionEdit(Number(btn.dataset.txSave))));
  tbody.querySelectorAll("[data-tx-delete]").forEach(btn => btn.addEventListener("click", () => deleteTransactionRow(Number(btn.dataset.txDelete))));
}

async function saveTransactionEdit(id) {
  const row = document.querySelector(`tr[data-tx-row="${id}"]`);
  if (!row) return;
  const payload = { id };
  row.querySelectorAll("[data-tx-field]").forEach(el => { payload[el.dataset.txField] = el.value; });
  try {
    showTradeStatus("수정 중...");
    await apiUpdateTransaction(payload);
    editingTxId = null;
    await loadTransactions();
    showTradeStatus("수정됨");
  } catch (err) {
    showTradeError(err);
  }
}

async function deleteTransactionRow(id) {
  const tx = transactionRows.find(item => Number(item.id) === id);
  const label = tx ? `${tx.trade_date} · ${tx.ticker} ${tx.side === "BUY" ? "매수" : "매도"} ${fmt2.format(tx.qty || 0)}` : "이 거래내역";
  if (!window.confirm(`${label} 을(를) 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
  try {
    showTradeStatus("삭제 중...");
    await apiDeleteTransaction(id);
    if (editingTxId === id) editingTxId = null;
    await loadTransactions();
    showTradeStatus("삭제됨");
  } catch (err) {
    showTradeError(err);
  }
}

function renderTransactions(rows, resetPage = true) {
  transactionRows = rows || [];
  if (resetPage) transactionPage = 1;
  const tbody = document.getElementById("transactions");
  if (transactionRows.length === 0) {
    editingTxId = null;
    tbody.innerHTML = `<tr><td colspan="10" class="flat">거래내역 없음</td></tr>`;
    renderTransactionPager(0);
    return;
  }
  const totalPages = Math.max(1, Math.ceil(transactionRows.length / transactionPageSize));
  transactionPage = Math.min(totalPages, Math.max(1, transactionPage));
  const pageRows = transactionRows.slice((transactionPage - 1) * transactionPageSize, transactionPage * transactionPageSize);
  tbody.innerHTML = pageRows.map(tx => (Number(tx.id) === editingTxId ? txEditRow(tx) : txViewRow(tx))).join("");
  bindTransactionRowActions(tbody);
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

function updateSortHeaders() {
  // 정렬 상태의 단일 진실은 sortState — 전역 sortKey/sortDir는 제거됨.
  const state = sortState[activeDetailTab] || sortState.detail;
  document.querySelectorAll("th[data-key], .name-head .sort-mini[data-key]").forEach(el => {
    el.classList.toggle("sort-desc", el.dataset.key === state.key && state.dir < 0);
    el.classList.toggle("sort-asc", el.dataset.key === state.key && state.dir > 0);
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
  document.getElementById("tradeCurrency").disabled = true;
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
  const currencyInput = document.getElementById("tradeCurrency");
  currencyInput.value = currency;
  currencyInput.disabled = true;
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
      if (res?.ticker?.currency) {
        const currencyInput = document.getElementById("tradeCurrency");
        currencyInput.value = res.ticker.currency;
        currencyInput.disabled = true;
      }
    } catch { /* lookup 실패 시 티커로 대체 */ }
  }
  // 입력 티커가 그새 바뀌지 않았을 때만 반영
  if ((document.getElementById("tradeTicker").value || "").trim().toUpperCase() === ticker) {
    nameInput.value = name || ticker;
  }
}

function tradeAccountLabel(accountId) {
  const account = flattenAccounts().find(item => String(item.id) === String(accountId));
  return account ? `${account.memberName} · ${account.name}` : String(accountId || "-");
}

function tradeSideLabel(side) {
  return side === "SELL" ? "매도" : "매수";
}

function tradeApplyLabel(enabled) {
  return enabled ? "반영" : "미반영";
}

function tradeConfirmRows(payload) {
  const amount = Number(payload.qty) * Number(payload.price);
  const rows = [
    ["거래일", payload.trade_date],
    ["계좌", tradeAccountLabel(payload.account_id)],
    ["티커", payload.ticker],
    ["종목명", payload.name || payload.ticker],
    ["유형", tradeSideLabel(payload.side)],
    ["수량", tradeQtyText(payload.qty, payload.ticker)],
    ["단가", unitMoney(Number(payload.price), payload.currency, payload.ticker), true],
    ["금액", Number.isFinite(amount) ? money(amount, payload.currency) : "-", true],
    ["통화", payload.currency],
    ["잔고", tradeApplyLabel(payload.apply_to_holdings)]
  ];
  return rows.map(([key, value, isHtml]) => `
    <div class="trade-confirm-key">${esc(key)}</div>
    <div class="trade-confirm-val">${isHtml ? value : esc(value)}</div>
  `).join("");
}

function confirmTradeSave(payload) {
  const modal = document.getElementById("tradeConfirmModal");
  const body = document.getElementById("tradeConfirmBody");
  const yes = document.getElementById("tradeConfirmYes");
  const no = document.getElementById("tradeConfirmNo");
  if (!modal || !body || !yes || !no || typeof modal.showModal !== "function") {
    const text = [
      `${payload.trade_date} · ${tradeAccountLabel(payload.account_id)}`,
      `${payload.ticker} ${payload.name || ""}`,
      `${tradeSideLabel(payload.side)} ${tradeQtyText(payload.qty, payload.ticker)}주 @ ${unitMoney(Number(payload.price), payload.currency, payload.ticker)}`,
      `잔고 ${tradeApplyLabel(payload.apply_to_holdings)}`
    ].join("\n");
    return Promise.resolve(window.confirm(`${text}\n\n저장할까요?`));
  }
  body.innerHTML = tradeConfirmRows(payload);
  return new Promise(resolve => {
    const cleanup = result => {
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      modal.removeEventListener("cancel", onCancel);
      modal.removeEventListener("click", onBackdrop);
      if (modal.open) modal.close();
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onCancel = event => {
      event.preventDefault();
      cleanup(false);
    };
    const onBackdrop = event => {
      if (event.target === modal) cleanup(false);
    };
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    modal.addEventListener("cancel", onCancel);
    modal.addEventListener("click", onBackdrop);
    modal.showModal();
  });
}

function updateTradeScope() {
  const accounts = visibleAccounts();
  const accountText = selectionMode === "all" ? "전체 계좌" : accounts.length === 1 ? `${accounts[0].memberName} · ${accounts[0].name}` : `${accounts.length}개 계좌`;
  document.getElementById("tradeScope").textContent = accountText;
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
      const total = Math.max(1, Math.ceil(visibleTransactionRows().length / transactionPageSize));
      transactionPage += btn.dataset.txPage === "next" ? 1 : -1;
      transactionPage = Math.min(total, Math.max(1, transactionPage));
      renderTransactions(transactionRows, false);
    });
  });
}

function transactionIsHidden(tx) {
  return Number(tx?.hidden) === 1;
}

function transactionNameFilterValue() {
  return String(document.getElementById("transactionNameFilter")?.value || "").trim();
}

function visibleTransactionRows() {
  const query = transactionNameFilterValue();
  return transactionRows.filter(tx => (showHiddenTransactions || !transactionIsHidden(tx))
    && matchesNameFilter(tx, query));
}

function syncHiddenTransactionsToggle() {
  const toggle = document.getElementById("transactionHiddenToggle");
  if (!toggle) return;
  toggle.classList.toggle("active", showHiddenTransactions);
  toggle.setAttribute("aria-pressed", String(showHiddenTransactions));
  toggle.title = showHiddenTransactions ? "숨긴 거래 숨기기" : "숨긴 거래도 표시";
}

function setShowHiddenTransactions(on) {
  showHiddenTransactions = Boolean(on);
  storageSet(transactionStorage.showHidden, showHiddenTransactions ? "1" : "0");
  syncHiddenTransactionsToggle();
  renderTransactions(transactionRows, true);
}

function txTickerMeta(tx) {
  const ticker = String(tx.ticker || "").toUpperCase();
  const meta = findTickerMeta(ticker) || flattenHoldings().find(h => String(h.ticker || "").toUpperCase() === ticker) || {};
  return {
    ...meta,
    ticker,
    name: tx.name || meta.name || ticker,
  };
}

function txTickerCell(tx) {
  const meta = txTickerMeta(tx);
  return `
    <span class="tx-ticker-cell">
      ${logoMarkup(meta)}
      <span>${esc(meta.ticker)}</span>
    </span>
  `;
}

function txApplyToHoldings(tx) {
  if (tx == null || tx.apply_to_holdings == null) return true;
  return Number(tx.apply_to_holdings) !== 0;
}

function currentHoldingQty(accountId, ticker) {
  const holding = flattenHoldings().find(h =>
    String(h.accountId) === String(accountId)
    && String(h.ticker || "").toUpperCase() === String(ticker || "").toUpperCase()
  );
  const n = Number(holding?.qty);
  return Number.isFinite(n) ? n : 0;
}

// 현재 보유 수량에서 최신 거래부터 되감아, 각 거래가 끝난 뒤의 잔고를 구한다.
function txEndingBalances(rows) {
  const byKey = new Map();
  for (const tx of rows || []) {
    const key = `${tx.account_id}\0${String(tx.ticker || "").toUpperCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tx);
  }
  const out = new Map();
  for (const [key, list] of byKey) {
    const sep = key.indexOf("\0");
    const accountId = key.slice(0, sep);
    const ticker = key.slice(sep + 1);
    list.sort((a, b) => {
      const d = String(b.trade_date || "").localeCompare(String(a.trade_date || ""));
      return d || Number(b.id) - Number(a.id);
    });
    let running = currentHoldingQty(accountId, ticker);
    for (const tx of list) {
      out.set(Number(tx.id), running);
      if (!txApplyToHoldings(tx)) continue;
      const qty = Number(tx.qty) || 0;
      running += String(tx.side || "").toUpperCase() === "SELL" ? qty : -qty;
    }
  }
  return out;
}

function txEditRow(tx, endingQty) {
  const account = `${tx.member || ""} · ${tx.account_name || tx.account_type || ""}`;
  const balanceText = endingQty == null ? "-" : tradeQtyText(endingQty, tx.ticker);
  return `
    <tr class="tx-editing${transactionIsHidden(tx) ? " tx-hidden-row" : ""}" data-tx-row="${tx.id}">
      <td><input type="date" class="tx-edit-input" data-tx-field="trade_date" value="${esc(tx.trade_date)}"></td>
      <td>${esc(account)}</td>
      <td>${txTickerCell(tx)}</td>
      <td class="tx-name-cell">${esc(tx.name || "")}</td>
      <td><select class="tx-edit-input" data-tx-field="side">
        <option value="BUY" ${tx.side === "BUY" ? "selected" : ""}>매수</option>
        <option value="SELL" ${tx.side === "SELL" ? "selected" : ""}>매도</option>
      </select></td>
      <td><input type="number" class="tx-edit-input" data-tx-field="price" value="${tx.price}" step="any" min="0"></td>
      <td><input type="number" class="tx-edit-input" data-tx-field="qty" value="${tx.qty}" step="any" min="0"></td>
      <td>${balanceText}</td>
      <td>-</td>
      <td>-</td>
      <td>-</td>
      <td>${entryRewardText(tx.entry_score)}</td>
      <td class="tx-actions">
        <button class="tx-action-btn tx-save" type="button" data-tx-save="${tx.id}" title="저장">저장</button>
        <button class="tx-action-btn" type="button" data-tx-cancel title="취소">취소</button>
      </td>
    </tr>
  `;
}

function txViewRow(tx, endingQty) {
  const buy = tx.side === "BUY";
  const sideChip = `<span class="change-cell pct-chip ${buy ? "up" : "down"}">${buy ? "매수" : "매도"}</span>`;
  const amount = (tx.qty || 0) * (tx.price || 0);
  const account = `${tx.member || ""} · ${tx.account_name || tx.account_type || ""}`;
  const currentPrice = currentPriceForTicker(tx.ticker);
  const currentPriceText = currentPrice != null ? unitMoney(currentPrice, tx.currency, tx.ticker) : "-";
  const pct = currentPrice != null && tx.price ? (currentPrice - tx.price) / tx.price * 100 : null;
  const compareText = changePercentText(pct, true);
  const hidden = transactionIsHidden(tx);
  const hideLabel = hidden ? "보임" : "숨김";
  const balanceText = endingQty == null ? "-" : tradeQtyText(endingQty, tx.ticker);
  return `
    <tr class="${hidden ? "tx-hidden-row" : ""}">
      <td>${esc(tx.trade_date)}</td>
      <td>${esc(account)}</td>
      <td>${txTickerCell(tx)}</td>
      <td class="tx-name-cell">${esc(tx.name || "")}</td>
      <td>${sideChip}</td>
      <td>${unitMoney(tx.price, tx.currency, tx.ticker)}</td>
      <td>${tradeQtyText(tx.qty || 0, tx.ticker)}</td>
      <td>${balanceText}</td>
      <td>${money(amount, tx.currency)}</td>
      <td>${currentPriceText}</td>
      <td>${compareText}</td>
      <td>${entryRewardText(tx.entry_score)}</td>
      <td class="tx-actions">
        <button class="tx-action-btn" type="button" data-tx-edit="${tx.id}" title="편집">편집</button>
        <button class="tx-action-btn" type="button" data-tx-hide="${tx.id}" data-tx-hidden="${hidden ? "0" : "1"}" title="${hideLabel}">${hideLabel}</button>
        <button class="tx-action-btn tx-del" type="button" data-tx-delete="${tx.id}" title="삭제">삭제</button>
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
  tbody.querySelectorAll("[data-tx-hide]").forEach(btn => btn.addEventListener("click", () => {
    setTransactionHidden(Number(btn.dataset.txHide), btn.dataset.txHidden === "1");
  }));
  tbody.querySelectorAll("[data-tx-delete]").forEach(btn => btn.addEventListener("click", () => deleteTransactionRow(Number(btn.dataset.txDelete))));
}

async function setTransactionHidden(id, hidden) {
  try {
    showTradeStatus(hidden ? "숨기는 중..." : "표시하는 중...");
    await apiUpdateTransaction({ id, hidden: hidden ? 1 : 0 });
    if (editingTxId === id) editingTxId = null;
    await loadTransactions();
    showTradeStatus(hidden ? "숨김" : "표시됨");
  } catch (err) {
    showTradeError(err);
  }
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
  const label = tx ? `${tx.trade_date} · ${tx.ticker} ${tx.side === "BUY" ? "매수" : "매도"} ${tradeQtyText(tx.qty || 0, tx.ticker)}` : "이 거래내역";
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
  if (Array.isArray(rows)) transactionRows = rows;
  if (resetPage) transactionPage = 1;
  const tbody = document.getElementById("transactions");
  const visible = visibleTransactionRows();
  if (visible.length === 0) {
    editingTxId = null;
    const emptyText = transactionNameFilterValue() ? "검색 조건에 맞는 거래내역이 없습니다"
      : transactionRows.some(transactionIsHidden) ? "숨긴 거래만 있습니다" : "거래내역 없음";
    tbody.innerHTML = `<tr><td colspan="13" class="flat">${emptyText}</td></tr>`;
    renderTransactionPager(0);
    return;
  }
  const totalPages = Math.max(1, Math.ceil(visible.length / transactionPageSize));
  transactionPage = Math.min(totalPages, Math.max(1, transactionPage));
  const pageRows = visible.slice((transactionPage - 1) * transactionPageSize, transactionPage * transactionPageSize);
  const balances = txEndingBalances(transactionRows);
  tbody.innerHTML = pageRows.map(tx => {
    const endingQty = balances.get(Number(tx.id));
    return Number(tx.id) === editingTxId ? txEditRow(tx, endingQty) : txViewRow(tx, endingQty);
  }).join("");
  bindTransactionRowActions(tbody);
  renderTransactionPager(visible.length);
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
  updateTradeScope();
  if (accountIds.length === 0) {
    renderTransactions([]);
    return;
  }
  const payload = await apiFetchTransactions(accountIds, selectionMode === "all");
  renderTransactions(payload.transactions);
}

function openTradeModal() {
  const modal = document.getElementById("tradeModal");
  if (modal?.open) {
    document.getElementById("tradeQty")?.focus();
    return;
  }
  if (modal && typeof modal.showModal === "function") {
    modal.showModal();
    requestAnimationFrame(() => document.getElementById("tradeQty")?.focus());
  }
}

function closeTradeModal() {
  const modal = document.getElementById("tradeModal");
  if (modal?.open) modal.close();
}

function selectTradeTarget(accountId, ticker) {
  selectedTrade = { accountId: String(accountId || ""), ticker: String(ticker || "").toUpperCase() };
  document.getElementById("tradeAccount").value = selectedTrade.accountId;
  document.getElementById("tradeTicker").value = selectedTrade.ticker;
  document.getElementById("tradeName").value = "";
  document.getElementById("tradePrice").value = "";
  renderTradeControls();
  openTradeModal();
}

function showTradeStatus(message, isError = false) {
  const el = document.getElementById("tradeStatus");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function showTradeError(err) {
  showTradeStatus(err.message || String(err), true);
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-transactions");

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

function applyTradeHoldingDefaults(overwriteName = false, overwritePrice = false) {
  const holding = findTradeHolding();
  const ticker = (document.getElementById("tradeTicker").value || selectedTrade.ticker || "").trim().toUpperCase();
  const meta = findTickerMeta(ticker);
  if (overwritePrice) document.getElementById("tradePrice").value = "";
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

async function updateTradeTickerDefaults() {
  selectedTrade.ticker = document.getElementById("tradeTicker").value.trim().toUpperCase();
  document.getElementById("tradeTicker").value = selectedTrade.ticker;
  applyTradeHoldingDefaults(true, true);
  resolveTradeName();
  const ticker = selectedTrade.ticker;
  const priceInput = document.getElementById("tradePrice");
  if (!ticker || priceInput.value) return;
  // A ticker outside the current compact payload may still have a collected price.
  try {
    const payload = await apiFetchPortfolio(usExtendedEnabled(), {compact:true, tickers:[ticker]});
    if (document.getElementById("tradeTicker").value.trim().toUpperCase() !== ticker || priceInput.value) return;
    const meta = payload.tickers?.find(t => t.ticker === ticker);
    if (meta?.current_price != null && Number.isFinite(Number(meta.current_price))) {
      priceInput.value = Number(meta.current_price).toFixed(["KRW", "JPY"].includes(meta.currency) ? 0 : 2);
      document.getElementById("tradeCurrency").value = meta.currency;
    }
  } catch { /* No current quote: leave blank for manual entry, never retain the old ticker's price. */ }
}

function previewTradeTickerDefaults() {
  const ticker = document.getElementById("tradeTicker").value.trim().toUpperCase();
  if (ticker === selectedTrade.ticker) return;
  selectedTrade.ticker = ticker;
  document.getElementById("tradeName").value = "";
  applyTradeHoldingDefaults(true, true);
  // Local preview only; remote lookup waits until the ticker edit is committed.
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
      if (res?.ticker?.currency && document.getElementById("tradeTicker").value.trim().toUpperCase() === ticker) {
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
    ["잔고", tradeApplyLabel(payload.apply_to_holdings)],
    ...(payload.memo ? [["메모", payload.memo]] : [])
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

// ── 종목 차트 '내역' 팝업(2026-10-26 사용자 지시) ─────────────────────────────
// 그 종목의 전 계좌 거래를 모아 본다. 아래 거래내역 패널(선택 계좌 기준)과 별개.
// 숨긴 거래는 흐리게 보여 주되 요약 합계에서는 뺀다(패널의 숨김 의미와 같게).
function tickerTransactionSummary(rows) {
  const visible = (rows || []).filter(tx => !transactionIsHidden(tx));
  const side = kind => {
    const list = visible.filter(tx => String(tx.side).toUpperCase() === kind);
    const qty = list.reduce((sum, tx) => sum + Number(tx.qty || 0), 0);
    const amount = list.reduce((sum, tx) => sum + Number(tx.qty || 0) * Number(tx.price || 0), 0);
    return { count: list.length, qty, avg: qty > 0 ? amount / qty : null };
  };
  const dates = visible.map(tx => tx.trade_date).filter(Boolean).sort();
  return {
    buy: side("BUY"), sell: side("SELL"),
    hidden: (rows || []).length - visible.length,
    first: dates[0] || null, last: dates[dates.length - 1] || null,
    currency: visible[0]?.currency || rows?.[0]?.currency || "",
  };
}

function tickerTransactionsSummaryMarkup(rows, ticker) {
  const s = tickerTransactionSummary(rows);
  if (!s.buy.count && !s.sell.count) return s.hidden ? `<span class="flat">숨긴 거래 ${s.hidden}건만 있음</span>` : "";
  const part = (label, cls, item) => item.count
    ? `<span class="ticker-tx-stat"><span class="change-cell pct-chip ${cls}">${label}</span> ${item.count}건 · ${tradeQtyText(item.qty, ticker)}주 · 평균 ${unitMoney(item.avg, s.currency, ticker)}</span>`
    : "";
  const period = s.first === s.last ? s.first : `${s.first} ~ ${s.last}`;
  return [part("매수", "up", s.buy), part("매도", "down", s.sell),
    `<span class="ticker-tx-stat flat">${esc(period)}${s.hidden ? ` · 숨김 ${s.hidden}건 제외` : ""}</span>`].join("");
}

function tickerTransactionsMarkup(rows, ticker) {
  if (!rows?.length) return `<div class="ticker-tx-empty flat">이 종목의 거래내역이 없습니다.</div>`;
  const body = rows.map(tx => {
    const buy = String(tx.side).toUpperCase() === "BUY";
    const hidden = transactionIsHidden(tx);
    const memo = String(tx.memo || "").trim();
    return `<tr class="${hidden ? "tx-hidden-row" : ""}">
      <td>${esc(tx.trade_date)}</td>
      <td class="ticker-tx-account">${esc(`${tx.member || ""} · ${tx.account_name || tx.account_type || ""}`)}</td>
      <td><span class="change-cell pct-chip ${buy ? "up" : "down"}">${buy ? "매수" : "매도"}</span>${hidden ? ` <span class="flat ticker-tx-hidden">숨김</span>` : ""}</td>
      <td>${unitMoney(tx.price, tx.currency, ticker)}</td>
      <td>${tradeQtyText(tx.qty || 0, ticker)}</td>
      <td>${money((tx.qty || 0) * (tx.price || 0), tx.currency)}</td>
      <td class="ticker-tx-memo"${memo ? ` title="${esc(memo)}"` : ""}>${memo ? esc(memo) : ""}</td>
    </tr>`;
  }).join("");
  return `<div class="dividend-history-table-wrap ticker-tx-table-wrap"><table class="dividend-history-table ticker-tx-table">
    <thead><tr><th>거래일</th><th>계좌</th><th>유형</th><th>단가</th><th>수량</th><th>금액</th><th>메모</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

async function openTickerTransactions(ticker, name) {
  const modal = document.getElementById("tickerTxModal");
  if (!modal || !ticker) return;
  document.getElementById("tickerTxTitle").textContent = `${name || ticker} 거래내역`;
  document.getElementById("tickerTxTicker").textContent = ticker;
  const summary = document.getElementById("tickerTxSummary");
  const body = document.getElementById("tickerTxBody");
  summary.innerHTML = "";
  body.innerHTML = `<div class="ticker-tx-empty flat">불러오는 중…</div>`;
  if (!modal.open) modal.showModal();
  try {
    const rows = (await apiFetchTickerTransactions(ticker)).transactions || [];
    summary.innerHTML = tickerTransactionsSummaryMarkup(rows, ticker);
    body.innerHTML = tickerTransactionsMarkup(rows, ticker);
  } catch (err) {
    body.innerHTML = `<div class="ticker-tx-empty error">${esc(err.message || String(err))}</div>`;
  }
}

function initTickerTransactionsModal() {
  const modal = document.getElementById("tickerTxModal");
  if (!modal) return;
  document.getElementById("tickerTxClose")?.addEventListener("click", () => modal.close());
  modal.addEventListener("click", event => { if (event.target === modal) modal.close(); });
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

// 메모가 있는 거래만 종목명 옆에 아이콘 — 누르면 메모만 고치는 팝업(2026-10-16 사용자 지시).
// 메모가 없는 거래는 관리 칸의 '메모' 버튼으로 새로 단다(모든 행 같은 자리, 메모 있으면 강조).
// 행 편집(txEditRow)은 메모를 다루지 않는다.
function txMemoButton(tx) {
  const memo = String(tx?.memo || "").trim();
  if (!memo) return "";
  return `<button class="tx-memo-btn" type="button" data-tx-memo="${tx.id}" title="${esc(memo)}" aria-label="메모 보기·편집">`
    + `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.5 7.5h5M5.5 10h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
    + `</button>`;
}

let txMemoEditingId = null;
let txMemoSaving = false;

function openTxMemoEditor(id) {
  const tx = transactionRows.find(item => Number(item.id) === Number(id));
  const modal = document.getElementById("txMemoModal");
  const input = document.getElementById("txMemoInput");
  if (!tx || !modal || !input) return;
  txMemoEditingId = Number(tx.id);
  document.getElementById("txMemoTarget").textContent =
    `${tx.trade_date} · ${tx.name || tx.ticker} ${tradeSideLabel(String(tx.side).toUpperCase())} ${tradeQtyText(tx.qty || 0, tx.ticker)}주`;
  document.getElementById("txMemoStatus").textContent = "";
  input.value = tx.memo || "";
  modal.showModal();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function saveTxMemo(event) {
  event.preventDefault();
  if (txMemoSaving || txMemoEditingId == null) return;
  const status = document.getElementById("txMemoStatus");
  txMemoSaving = true;
  status.textContent = "저장 중...";
  try {
    const result = await apiUpdateTransactionMemo(txMemoEditingId, document.getElementById("txMemoInput").value);
    const tx = transactionRows.find(item => Number(item.id) === Number(result.id));
    if (tx) tx.memo = result.memo;
    document.getElementById("txMemoModal").close();
    renderTransactions(transactionRows, false);
    showTradeStatus(result.memo ? "메모 저장됨" : "메모 지움");
  } catch (err) {
    status.textContent = err.message || String(err);
  } finally {
    txMemoSaving = false;
  }
}

function initTxMemoEditor() {
  const modal = document.getElementById("txMemoModal");
  document.getElementById("txMemoForm")?.addEventListener("submit", saveTxMemo);
  document.getElementById("txMemoCancel")?.addEventListener("click", () => modal?.close());
  modal?.addEventListener("click", event => { if (event.target === modal) modal.close(); });
  modal?.addEventListener("close", () => { txMemoEditingId = null; });
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
      <td class="tx-name-cell">${esc(tx.name || "")}${txMemoButton(tx)}</td>
      <td>${sideChip}</td>
      <td>${unitMoney(tx.price, tx.currency, tx.ticker)}</td>
      <td>${tradeQtyText(tx.qty || 0, tx.ticker)}</td>
      <td>${balanceText}</td>
      <td>${money(amount, tx.currency)}</td>
      <td>${currentPriceText}</td>
      <td>${compareText}</td>
      <td>${entryRewardText(tx.entry_score)}</td>
      <td class="tx-actions">
        <button class="tx-action-btn${String(tx.memo || "").trim() ? " has-memo" : ""}" type="button" data-tx-memo="${tx.id}" title="${String(tx.memo || "").trim() ? "메모 편집" : "메모 추가"}">메모</button>
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
  tbody.querySelectorAll("[data-tx-memo]").forEach(btn => btn.addEventListener("click", () => openTxMemoEditor(Number(btn.dataset.txMemo))));
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

// 잔고에 반영됐던 거래의 유형·수량·단가가 바뀌는가 — 이때만 잔고 반영 여부를 묻는다.
// 거래일·메모만 바뀌거나, 원래 잔고에 반영되지 않았던 거래(과거 이력 보강분)는 묻지 않는다.
function transactionEditTouchesHoldings(original, payload) {
  if (!original || Number(original.apply_to_holdings) !== 1) return false;
  const side = String(payload.side ?? original.side).toUpperCase();
  const qty = Number(payload.qty ?? original.qty);
  const price = Number(payload.price ?? original.price);
  return side !== String(original.side).toUpperCase()
    || Math.abs(qty - Number(original.qty)) > 1e-9
    || Math.abs(price - Number(original.price)) > 1e-9;
}

function transactionEditSummary(original, payload) {
  const line = tx => `${tradeSideLabel(String(tx.side).toUpperCase())} ${tradeQtyText(Number(tx.qty), original.ticker)}주 @ ${unitMoney(Number(tx.price), original.currency, original.ticker)}`;
  const after = { side: payload.side ?? original.side, qty: payload.qty ?? original.qty, price: payload.price ?? original.price };
  // 새 거래 저장 확인창(tradeConfirmRows)과 같은 2열 칸을 쓴다. 단가는 unitMoney가 만든 마크업이라 이스케이프하지 않는다.
  return [
    ["종목", `${esc(original.name || original.ticker)} · ${esc(original.ticker)}`],
    ["계좌", esc(tradeAccountLabel(original.account_id))],
    ["수정 전", line(original)],
    ["수정 후", line(after)],
  ].map(([key, value]) => `
    <div class="trade-confirm-key">${esc(key)}</div>
    <div class="trade-confirm-val">${value}</div>
  `).join("");
}

// 'apply' | 'ledger' | 'cancel'. 대화상자를 못 쓰는 환경은 확인창 두 번으로 대신한다.
function askTransactionEditHoldings(original, payload) {
  const modal = document.getElementById("txEditHoldingsModal");
  const body = document.getElementById("txEditHoldingsBody");
  const buttons = {
    apply: document.getElementById("txEditHoldingsApply"),
    ledger: document.getElementById("txEditHoldingsLedger"),
    cancel: document.getElementById("txEditHoldingsCancel"),
  };
  if (!modal || !body || Object.values(buttons).some(b => !b) || typeof modal.showModal !== "function") {
    if (window.confirm("이 거래 수정을 잔고에도 반영할까요?\n(취소를 누르면 거래내역만 수정할지 다시 묻습니다)")) return Promise.resolve("apply");
    return Promise.resolve(window.confirm("거래내역만 수정할까요?") ? "ledger" : "cancel");
  }
  body.innerHTML = transactionEditSummary(original, payload);
  return new Promise(resolve => {
    const handlers = {};
    const cleanup = result => {
      Object.entries(buttons).forEach(([key, btn]) => btn.removeEventListener("click", handlers[key]));
      modal.removeEventListener("cancel", onCancel);
      if (modal.open) modal.close();
      resolve(result);
    };
    const onCancel = event => { event.preventDefault(); cleanup("cancel"); };
    Object.entries(buttons).forEach(([key, btn]) => {
      handlers[key] = () => cleanup(key);
      btn.addEventListener("click", handlers[key]);
    });
    modal.addEventListener("cancel", onCancel);
    modal.showModal();
  });
}

async function saveTransactionEdit(id) {
  const row = document.querySelector(`tr[data-tx-row="${id}"]`);
  if (!row) return;
  const payload = { id };
  row.querySelectorAll("[data-tx-field]").forEach(el => { payload[el.dataset.txField] = el.value; });
  // 잔고에 반영됐던 거래의 유형·수량·단가를 바꾸면 한 번 묻는다(2026-10-03 사용자 지시 —
  // 예전엔 원장만 고쳐져 TSM 매수→매도 수정 뒤 잔고가 150주로 남았다).
  const original = transactionRows.find(item => Number(item.id) === Number(id));
  if (transactionEditTouchesHoldings(original, payload)) {
    const choice = await askTransactionEditHoldings(original, payload);
    if (choice === "cancel") {
      showTradeStatus("수정 취소");
      return;
    }
    payload.apply_to_holdings = choice === "apply";
  }
  try {
    showTradeStatus("수정 중...");
    const result = await apiUpdateTransaction(payload);
    editingTxId = null;
    if (result?.portfolio) {
      data = result.portfolio;
      render();
    }
    await loadTransactions();
    showTradeStatus(result?.holdings_applied ? "수정됨 · 잔고 반영" : "수정됨");
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

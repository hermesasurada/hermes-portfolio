// Read-only ledger matrix. Keep original entries in each cell for future editing.
function buildCashFlowsMatrix(accounts, flows) {
  const columns = new Map(accounts.map(a => [String(a.id), { ...a }]));
  const dates = new Map();
  const totals = new Map();
  for (const flow of flows) {
    const id = String(flow.account_id);
    if (!columns.has(id)) columns.set(id, {
      id: flow.account_id, memberName: flow.member || "",
      name: flow.account_name || `계좌 ${id}`,
    });
    if (!dates.has(flow.flow_date)) dates.set(flow.flow_date, new Map());
    const row = dates.get(flow.flow_date);
    if (!row.has(id)) row.set(id, []);
    row.get(id).push(flow);
    if (!totals.has(id)) totals.set(id, []);
    totals.get(id).push(flow);
  }
  return {
    accounts: [...columns.values()], totals,
    rows: [...dates].sort(([a], [b]) => b.localeCompare(a))
      .map(([date, cells]) => ({ date, cells })),
    count: flows.length,
  };
}

function filterCashFlowsMatrix(matrix, selectedIds, year = null) {
  if (selectedIds === null && year === null) return matrix;
  const accounts = matrix.accounts.filter(a => selectedIds === null || selectedIds.has(String(a.id)));
  const rows = matrix.rows.filter(row => (year === null || row.date.startsWith(`${year}-`))
    && accounts.some(a => row.cells.has(String(a.id))));
  const totals = new Map();
  let count = 0;
  for (const row of rows) for (const account of accounts) {
    const id = String(account.id);
    const entries = row.cells.get(id);
    if (!entries) continue;
    if (!totals.has(id)) totals.set(id, []);
    totals.get(id).push(...entries);
    count += entries.length;
  }
  return { accounts, rows, count, totals, year };
}

function cashFlowsAmountMarkup(entries) {
  if (!entries?.length) return '<span class="cash-flows-empty">—</span>';
  // Never add different currencies or apply today's FX to historical cash flows.
  const sums = new Map();
  for (const entry of entries) {
    const currency = entry.currency || "KRW";
    sums.set(currency, (sums.get(currency) || 0) + Number(entry.amount));
  }
  return [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => {
    const digits = currency === "KRW" || currency === "JPY" ? 0 : ["BTC", "ETH"].includes(currency) ? 8 : 2;
    const text = new Intl.NumberFormat("ko-KR", {
      maximumFractionDigits: digits,
    }).format(Math.abs(currency === "KRW" ? amount / 10000 : amount));
    const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
    const cls = amount > 0 ? "up" : amount < 0 ? "down" : "flat";
    return `<span class="cash-flows-amount ${cls}">${sign}${text}${currency === "KRW" ? "" : `<small>${esc(currency)}</small>`}</span>`;
  }).join("");
}

function cashFlowsTableMarkup(matrix) {
  const { accounts, rows, totals } = matrix;
  const cells = (values, date = "") => accounts.map(a => {
    const entries = values.get(String(a.id));
    // Routine import notes and total counts add noise; retain explanations only
    // for estimated/corrective funding and exceptional non-cash settlements.
    const title = date ? (entries || [])
      .filter(e => /보정|추정|증여|현물|상장폐지|정산|매수일 기준/.test(e.note || ""))
      .map(e => `${Number(e.amount).toLocaleString("ko-KR", { maximumFractionDigits: 8 })} ${e.currency || "KRW"} · ${e.note}`)
      .join("\n") : "";
    return `<td data-account-id="${esc(a.id)}" data-flow-date="${esc(date)}"${title ? ` title="${esc(title)}"` : ""}>${cashFlowsAmountMarkup(entries)}</td>`;
  }).join("");
  return `<table class="cash-flows-table" style="min-width:${86 + accounts.length * 96}px">
    <caption class="sr-only">계좌별 일자별 순입출금, 최신 날짜순</caption>
    <thead><tr><th scope="col">일자</th>${accounts.map(a => `<th scope="col"><span>${esc(a.memberName || "")}</span><strong>${esc(a.name)}</strong></th>`).join("")}</tr></thead>
    <tbody><tr class="cash-flows-total"><th scope="row">${matrix.year == null ? "순입금 합계" : "연간 순입금"}</th>${cells(totals)}</tr>
    ${rows.map(row => `<tr><th scope="row"><time datetime="${esc(row.date)}">${esc(row.date.slice(5))}</time></th>${cells(row.cells, row.date)}</tr>`).join("")}</tbody>
  </table>`;
}

function initCashFlowsModal() {
  const modal = document.getElementById("cashFlowsModal");
  const status = document.getElementById("cashFlowsStatus");
  const wrap = document.getElementById("cashFlowsTableWrap");
  const switches = document.getElementById("cashFlowsAccounts");
  const yearLabel = document.getElementById("cashFlowsYear");
  const prevYear = document.getElementById("cashFlowsPrevYear");
  const nextYear = document.getElementById("cashFlowsNextYear");
  const currentYear = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()));
  let selectedYear = currentYear;
  let minYear = currentYear;
  let maxYear = currentYear;
  let fullMatrix = null;
  let selectedIds = null; // null = all, Set = explicit selection (including none)
  let requestId = 0;
  function render() {
    if (!fullMatrix) return;
    const matrix = filterCashFlowsMatrix(fullMatrix, selectedIds, selectedYear);
    yearLabel.textContent = `${selectedYear}년`;
    prevYear.disabled = selectedYear <= minYear;
    nextYear.disabled = selectedYear >= maxYear;
    modal.style.setProperty("--cash-flows-width", `${Math.max(440, 86 + matrix.accounts.length * 96 + 32)}px`);
    wrap.innerHTML = matrix.accounts.length ? cashFlowsTableMarkup(matrix) : "";
    wrap.scrollTop = 0;
    wrap.scrollLeft = 0;
    status.textContent = !matrix.accounts.length ? "표시할 계좌를 선택하세요."
      : `${selectedYear}년 · ${matrix.accounts.length}개 계좌 · ${matrix.rows.length}일 · ${matrix.count}건 · 최신순${matrix.count ? "" : " · 등록된 내역 없음"}`;
    switches.querySelectorAll("[data-cash-account]").forEach(btn => {
      btn.setAttribute("aria-pressed", String(selectedIds === null || selectedIds.has(btn.dataset.cashAccount)));
    });
  }
  async function load() {
    const token = ++requestId;
    status.textContent = "입출금 내역을 불러오는 중…";
    wrap.innerHTML = "";
    fullMatrix = null;
    switches.innerHTML = "";
    yearLabel.textContent = `${selectedYear}년`;
    prevYear.disabled = true;
    nextYear.disabled = true;
    wrap.setAttribute("aria-busy", "true");
    try {
      const [payload, portfolio] = await Promise.all([
        apiFetchCashFlows(),
        data?.members ? Promise.resolve(data) : apiFetchPortfolio(false, { compact: true }),
      ]);
      if (token !== requestId || !modal.open) return;
      const accounts = portfolio.members.flatMap(m => m.accounts.map(a => ({ ...a, memberName: m.name })));
      const groupOrder = ["overseas", "kr_individual", "pension", "other", "bitcoin"];
      const rank = a => { const i = groupOrder.indexOf(accountGroupKey(a)); return i < 0 ? 3 : i; };
      accounts.sort((a, b) => rank(a) - rank(b));
      fullMatrix = buildCashFlowsMatrix(accounts, payload.cash_flows);
      const years = fullMatrix.rows.map(row => Number(row.date.slice(0, 4))).filter(Number.isFinite);
      minYear = Math.min(currentYear, ...years);
      maxYear = Math.max(currentYear, ...years);
      selectedYear = Math.max(minYear, Math.min(maxYear, selectedYear));
      switches.innerHTML = fullMatrix.accounts.map(a => `<button type="button" class="cash-flows-switch" data-cash-account="${esc(a.id)}" aria-pressed="false"><span aria-hidden="true" class="cash-flows-dot"></span>${esc(a.memberName || "")} · ${esc(a.name)}</button>`).join("");
      render();
    } catch (err) {
      if (token === requestId && modal.open) status.textContent = `불러오기 실패: ${err.message || err} · 팝업을 닫고 다시 열어주세요.`;
    } finally {
      if (token === requestId) {
        wrap.setAttribute("aria-busy", "false");
      }
    }
  }
  document.getElementById("cashFlowsOpen").addEventListener("click", () => {
    if (!modal.open) modal.showModal();
    load();
  });
  document.getElementById("cashFlowsClose").addEventListener("click", () => modal.close());
  prevYear.addEventListener("click", () => {
    if (!fullMatrix || selectedYear <= minYear) return;
    selectedYear -= 1;
    render();
  });
  nextYear.addEventListener("click", () => {
    if (!fullMatrix || selectedYear >= maxYear) return;
    selectedYear += 1;
    render();
  });
  switches.addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn || !fullMatrix) return;
    if (btn.dataset.cashAccount) {
      if (selectedIds === null) selectedIds = new Set(fullMatrix.accounts.map(a => String(a.id)));
      const id = btn.dataset.cashAccount;
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
    }
    render();
  });
  modal.addEventListener("close", () => { requestId += 1; });
  modal.addEventListener("click", e => {
    if (e.target !== modal) return;
    const r = modal.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) modal.close();
  });
}

(window.__loaded = window.__loaded || new Set()).add("app-cash-flows");

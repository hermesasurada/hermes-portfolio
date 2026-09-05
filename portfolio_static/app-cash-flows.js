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
    const text = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(Math.abs(amount));
    const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
    const cls = amount > 0 ? "up" : amount < 0 ? "down" : "flat";
    return `<span class="cash-flows-amount ${cls}">${sign}${text}<small>${esc(currency === "KRW" ? "원" : currency)}</small></span>`;
  }).join("");
}

function cashFlowsTableMarkup(matrix) {
  const { accounts, rows, totals } = matrix;
  const cells = (values, date = "") => accounts.map(a => {
    const entries = values.get(String(a.id));
    const title = date ? (entries || []).map(e => `${Number(e.amount).toLocaleString("ko-KR", { maximumFractionDigits: 8 })} ${e.currency || "KRW"}${e.note ? ` · ${e.note}` : ""}`).join("\n") : `${entries?.length || 0}건의 순입출금 합계`;
    return `<td data-account-id="${esc(a.id)}" data-flow-date="${esc(date)}" title="${esc(title)}">${cashFlowsAmountMarkup(entries)}</td>`;
  }).join("");
  return `<table class="cash-flows-table">
    <caption class="sr-only">계좌별 일자별 순입출금, 최신 날짜순</caption>
    <thead><tr><th scope="col">일자</th>${accounts.map(a => `<th scope="col"><span>${esc(a.memberName || "")}</span><strong>${esc(a.name)}</strong></th>`).join("")}</tr></thead>
    <tbody><tr class="cash-flows-total"><th scope="row">순입금 합계</th>${cells(totals)}</tr>
    ${rows.map(row => `<tr><th scope="row"><time datetime="${esc(row.date)}">${esc(row.date)}</time></th>${cells(row.cells, row.date)}</tr>`).join("")}</tbody>
  </table>`;
}

function initCashFlowsModal() {
  const modal = document.getElementById("cashFlowsModal");
  const status = document.getElementById("cashFlowsStatus");
  const wrap = document.getElementById("cashFlowsTableWrap");
  const refresh = document.getElementById("cashFlowsRefresh");
  let requestId = 0;
  async function load() {
    const token = ++requestId;
    status.textContent = "입출금 내역을 불러오는 중…";
    wrap.innerHTML = "";
    wrap.setAttribute("aria-busy", "true");
    refresh.disabled = true;
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
      const matrix = buildCashFlowsMatrix(accounts, payload.cash_flows);
      wrap.innerHTML = cashFlowsTableMarkup(matrix);
      status.textContent = matrix.count
        ? `${matrix.accounts.length}개 계좌 · ${matrix.rows.length}일 · ${matrix.count}건 · 최신순`
        : "등록된 입출금 내역이 없습니다.";
    } catch (err) {
      if (token === requestId && modal.open) status.textContent = `불러오기 실패: ${err.message || err} · 새로고침으로 다시 시도하세요.`;
    } finally {
      if (token === requestId) {
        refresh.disabled = false;
        wrap.setAttribute("aria-busy", "false");
      }
    }
  }
  document.getElementById("cashFlowsOpen").addEventListener("click", () => {
    if (!modal.open) modal.showModal();
    load();
  });
  document.getElementById("cashFlowsClose").addEventListener("click", () => modal.close());
  refresh.addEventListener("click", load);
  modal.addEventListener("close", () => { requestId += 1; });
  modal.addEventListener("click", e => {
    if (e.target !== modal) return;
    const r = modal.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) modal.close();
  });
}

(window.__loaded = window.__loaded || new Set()).add("app-cash-flows");

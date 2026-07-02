let interestWatchlists = [];
let interestWatchlistsLoaded = false;
let interestWatchlistsInFlight = null;
let activeSidebarTab = "accounts";
let activeInterestGroupId = null;
let editingInterestGroupId = null;
let interestGroupOrderSaving = false;
const interestSortState = { key: "display_change_pct", dir: -1 };

function interestModeActive() {
  return activeSidebarTab === "interest" && activeInterestGroupId != null;
}

function activeInterestGroup() {
  return interestWatchlists.find(group => group.id === activeInterestGroupId) || null;
}

function otherInterestGroup() {
  return interestWatchlists.find(group => group.fixed || group.name === "기타") || null;
}

function interestGroupIsFx(group = activeInterestGroup()) {
  return Boolean(group?.items?.length)
    && group.items.every(item => item.category === "fx");
}

function setInterestStatus(message = "", error = false, main = false) {
  const el = document.getElementById(main ? "interestMainStatus" : "interestStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", error);
}

function syncSidebarTabs() {
  document.querySelectorAll("[data-sidebar-tab]").forEach(btn => {
    const active = btn.dataset.sidebarTab === activeSidebarTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  document.getElementById("accountSidebarPane")?.classList.toggle("hidden", activeSidebarTab !== "accounts");
  document.getElementById("interestSidebarPane")?.classList.toggle("hidden", activeSidebarTab !== "interest");
}

function trackedTickerOptions() {
  return (data?.tickers || [])
    .filter(item => item.ticker)
    .slice()
    .sort((a, b) => String(a.name || a.ticker).localeCompare(String(b.name || b.ticker), "ko-KR"));
}

function renderInterestTickerOptions() {
  const options = document.getElementById("interestTickerOptions");
  if (!options) return;
  options.innerHTML = trackedTickerOptions()
    .map(item => {
      const aliases = Array.isArray(item.aliases) && item.aliases.length ? ` · ${item.aliases.join(", ")}` : "";
      return `<option value="${esc(item.ticker)}">${esc(item.name || item.ticker)}${esc(aliases)}</option>`;
    })
    .join("");
}

function resolveInterestTicker(value) {
  const ticker = resolveTickerFromDirectory(value, trackedTickerOptions(), false);
  return ticker ? ticker : null;
}

function interestGroupIcon(name, fixed = false) {
  if (fixed) return "…";
  const text = String(name || "");
  if (text.includes("지수")) return "📈";
  if (text.includes("환율")) return "₩";
  if (text.includes("디지털")) return "₿";
  if (text.includes("한국")) return "🇰🇷";
  if (text.includes("미국")) return "🇺🇸";
  if (text.includes("일본")) return "🇯🇵";
  if (text.includes("유럽")) return "🇪🇺";
  if (text.includes("투자종료")) return "✓";
  return "•";
}

function isProtectedInterestGroup(group) {
  const name = String(group?.name || "");
  return name === "주요 지수" || name === "환율";
}

function isProtectedInterestItem(row, group = activeInterestGroup()) {
  const category = String(row?.category || "").toLowerCase();
  return isProtectedInterestGroup(group) || category === "index" || category === "fx";
}

function interestGroupMarkup(group, index) {
  const active = group.id === activeInterestGroupId;
  const icon = interestGroupIcon(group.name, group.fixed);
  const protectedGroup = isProtectedInterestGroup(group);
  // 가상 "기타" 그룹 — 선택만 가능, 이름변경·삭제·이동 컨트롤 없음.
  if (group.fixed) {
    return `
    <section class="interest-group fixed ${active ? "active" : ""}" data-interest-group="${group.id}">
      <button class="interest-group-select" type="button" data-interest-select="${group.id}" aria-pressed="${active}">
        <span class="interest-group-icon" aria-hidden="true">${esc(icon)}</span>
        <span class="interest-group-name">${esc(group.name)}</span>
        <span class="interest-count">${group.items.length}</span>
      </button>
    </section>
  `;
  }
  if (editingInterestGroupId === group.id) {
    return `
      <form class="interest-group-rename" data-interest-rename-form="${group.id}">
        <input type="text" maxlength="40" value="${esc(group.name)}" aria-label="그룹명">
        <button class="interest-icon-btn" type="submit" aria-label="이름 저장" title="이름 저장">✓</button>
        <button class="interest-icon-btn" type="button" data-interest-rename-cancel aria-label="취소" title="취소">×</button>
      </form>
    `;
  }
  return `
    <section class="interest-group ${active ? "active" : ""}" data-interest-group="${group.id}">
      <button class="interest-group-select" type="button" data-interest-select="${group.id}" aria-pressed="${active}">
        <span class="interest-group-icon" aria-hidden="true">${esc(icon)}</span>
        <span class="interest-group-name">${esc(group.name)}</span>
        <span class="interest-count">${group.items.length}</span>
      </button>
      <span class="interest-order-controls" aria-label="${esc(group.name)} 순서 변경">
        <button type="button" data-interest-move="${group.id}" data-direction="-1" aria-label="${esc(group.name)} 위로 이동" title="위로 이동" ${index === 0 ? "disabled" : ""}>▲</button>
        <button type="button" data-interest-move="${group.id}" data-direction="1" aria-label="${esc(group.name)} 아래로 이동" title="아래로 이동" ${index === interestWatchlists.length - 1 || interestWatchlists[index + 1]?.fixed ? "disabled" : ""}>▼</button>
      </span>
      <button class="interest-icon-btn" type="button" data-interest-rename="${group.id}" aria-label="${esc(group.name)} 이름 변경" title="이름 변경">✎</button>
      ${protectedGroup
        ? '<span class="interest-icon-placeholder" aria-hidden="true"></span>'
        : `<button class="interest-icon-btn danger" type="button" data-interest-group-delete="${group.id}" aria-label="${esc(group.name)} 삭제" title="그룹 삭제">×</button>`}
    </section>
  `;
}

function renderInterestWatchlists() {
  renderInterestTickerOptions();
  const container = document.getElementById("interestGroups");
  if (!container) return;
  if (!interestWatchlistsLoaded) {
    container.innerHTML = '<div class="interest-empty">관심목록을 불러오는 중...</div>';
    return;
  }
  if (!interestWatchlists.length) {
    container.innerHTML = '<div class="interest-empty">그룹을 추가해 관심종목을 구성하세요.</div>';
    return;
  }
  container.innerHTML = interestWatchlists.map(interestGroupMarkup).join("");
}

function normalizeActiveInterestGroup() {
  if (activeInterestGroupId != null && interestWatchlists.some(group => group.id === activeInterestGroupId)) return;
  // storageGet 미설정 시 Number(null)=0이 가상 "기타"(id=0)와 오인 매칭되지 않도록 가드.
  const rawSaved = storageGet(sidebarStorage.interestGroupId);
  const saved = rawSaved != null && rawSaved !== "" ? Number(rawSaved) : NaN;
  const savedGroup = Number.isNaN(saved) ? null : interestWatchlists.find(group => group.id === saved);
  activeInterestGroupId = savedGroup?.id
    ?? interestWatchlists.find(group => !group.fixed)?.id
    ?? interestWatchlists[0]?.id
    ?? null;
  if (activeInterestGroupId != null) storageSet(sidebarStorage.interestGroupId, String(activeInterestGroupId));
}

function applyInterestWatchlistPayload(payload) {
  interestWatchlists = payload.groups || [];
  interestWatchlistsLoaded = true;
  normalizeActiveInterestGroup();
  renderInterestWatchlists();
  if (data) render();
}

async function loadInterestWatchlists() {
  if (interestWatchlistsInFlight) return interestWatchlistsInFlight;
  interestWatchlistsInFlight = apiFetchInterestWatchlists()
    .then(payload => {
      applyInterestWatchlistPayload(payload);
      setInterestStatus("");
      return payload;
    })
    .catch(err => {
      interestWatchlistsLoaded = true;
      renderInterestWatchlists();
      setInterestStatus(err.message || String(err), true);
      throw err;
    })
    .finally(() => {
      interestWatchlistsInFlight = null;
    });
  return interestWatchlistsInFlight;
}

async function mutateInterestWatchlist(action, progressText, main = false) {
  setInterestStatus(progressText, false, main);
  try {
    applyInterestWatchlistPayload(await action());
    setInterestStatus("", false, main);
  } catch (err) {
    setInterestStatus(err.message || String(err), true, main);
  }
}

async function moveInterestGroup(groupId, direction) {
  if (interestGroupOrderSaving) return;
  // 실제 그룹만 재정렬 — 가상 "기타"는 항상 최하위 고정(reorder 페이로드에서 제외).
  const realGroups = interestWatchlists.filter(group => !group.fixed && group.id > 0);
  const index = realGroups.findIndex(group => group.id === groupId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= realGroups.length) return;
  const reordered = realGroups.slice();
  [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
  interestGroupOrderSaving = true;
  setInterestStatus("순서 저장 중...");
  try {
    applyInterestWatchlistPayload(
      await apiReorderInterestGroups(reordered.map(group => group.id))
    );
    setInterestStatus("");
  } catch (err) {
    setInterestStatus(err.message || String(err), true);
  } finally {
    interestGroupOrderSaving = false;
  }
}

function interestBulkCandidates() {
  const group = activeInterestGroup();
  const other = otherInterestGroup();
  if (!group || group.fixed || !other) return [];
  const existing = new Set((group.items || []).map(item => String(item.ticker).toUpperCase()));
  return (other.items || [])
    .filter(item => item.ticker && !existing.has(String(item.ticker).toUpperCase()))
    .slice()
    .sort((a, b) => String(a.name || a.ticker).localeCompare(String(b.name || b.ticker), "ko-KR", {
      numeric: true,
      sensitivity: "base",
    }));
}

function syncInterestBulkCount() {
  const checked = document.querySelectorAll("#interestBulkList input[type='checkbox']:checked").length;
  const count = document.getElementById("interestBulkCount");
  const apply = document.getElementById("interestBulkApply");
  if (count) count.textContent = `${checked}개 선택`;
  if (apply) apply.disabled = checked === 0;
  const boxes = Array.from(document.querySelectorAll("#interestBulkList input[type='checkbox']"));
  const selectAll = document.getElementById("interestBulkSelectAll");
  if (selectAll) {
    selectAll.checked = boxes.length > 0 && checked === boxes.length;
    selectAll.indeterminate = checked > 0 && checked < boxes.length;
    selectAll.disabled = boxes.length === 0;
  }
}

function renderInterestBulkModal() {
  const list = document.getElementById("interestBulkList");
  const status = document.getElementById("interestBulkStatus");
  if (!list) return;
  if (status) {
    status.textContent = "";
    status.classList.remove("error");
  }
  const group = activeInterestGroup();
  const other = otherInterestGroup();
  if (!other) {
    list.innerHTML = '<div class="interest-bulk-empty">기타 관심목록을 찾을 수 없습니다.</div>';
    syncInterestBulkCount();
    return;
  }
  if (!group || group.fixed) {
    list.innerHTML = '<div class="interest-bulk-empty">종목을 추가할 관심그룹을 먼저 선택하세요.</div>';
    syncInterestBulkCount();
    return;
  }
  const candidates = interestBulkCandidates();
  list.innerHTML = candidates.length ? candidates.map(item => `
    <label class="interest-bulk-item">
      <input type="checkbox" value="${esc(item.ticker)}">
      <span>
        <span class="interest-bulk-name">${esc(item.name || item.ticker)}</span>
        <span class="interest-bulk-ticker">${esc(item.ticker)}</span>
      </span>
    </label>
  `).join("") : '<div class="interest-bulk-empty">기타에서 추가할 수 있는 남은 종목이 없습니다.</div>';
  syncInterestBulkCount();
}

function openInterestBulkModal() {
  renderInterestBulkModal();
  const modal = document.getElementById("interestBulkModal");
  if (!modal) return;
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
}

async function applyInterestBulkSelection() {
  const group = activeInterestGroup();
  if (!group || group.fixed) return;
  const tickers = Array.from(document.querySelectorAll("#interestBulkList input[type='checkbox']:checked"))
    .map(input => input.value)
    .filter(Boolean);
  if (!tickers.length) return;
  const apply = document.getElementById("interestBulkApply");
  const status = document.getElementById("interestBulkStatus");
  if (apply) apply.disabled = true;
  let payload = null;
  try {
    for (let index = 0; index < tickers.length; index += 1) {
      if (status) status.textContent = `${index + 1}/${tickers.length} 추가 중...`;
      payload = await apiAddInterestItem(group.id, tickers[index]);
    }
    if (payload) applyInterestWatchlistPayload(payload);
    document.getElementById("interestBulkModal")?.close();
    setInterestStatus(`${tickers.length}개 추가됨`, false, true);
  } catch (err) {
    if (status) status.textContent = err.message || String(err);
    status?.classList.add("error");
    loadInterestWatchlists().catch(() => {});
  } finally {
    if (apply) apply.disabled = false;
    syncInterestBulkCount();
  }
}

function interestBaseRows() {
  const group = activeInterestGroup();
  if (!group) return [];
  const isFxGroup = interestGroupIsFx(group);
  const currencyFilter = isFxGroup ? "all" : currencyFilterValue();
  const fxAdjusted = isFxGroup ? false : fxAdjustedEnabled();
  const held = interestHeldOnlyEnabled() ? heldTickerSet() : null;   // '보유종목만' 필터
  return group.items
    .filter(item => !held || held.has(String(item.ticker).toUpperCase()))
    .map(item => {
      const meta = findTickerMeta(item.ticker) || item;
      const row = watchlistRowForAccount({
        ...item,
        ...meta,
        ticker: item.ticker,
        name: item.name || meta.name || item.ticker,
      }, null);
      return {
        ...row,
        display_change_pct: holdingChangePct(row, fxAdjusted),
        current_price_krw: holdingUnitKrw(row),
      };
    })
    .filter(row => currencyFilter === "all" || row.currency === currencyFilter);
}

function sortInterestRows(rows) {
  const { key, dir } = interestSortState;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av ?? "").localeCompare(String(bv ?? ""), "ko-KR", { numeric: true, sensitivity: "base" }) * dir;
    }
    const an = av != null && Number.isFinite(Number(av)) ? Number(av) : -Infinity;
    const bn = bv != null && Number.isFinite(Number(bv)) ? Number(bv) : -Infinity;
    return (an - bn) * dir;
  });
}

const interestColumnWidths = {
  display_change_pct: 86,
  extended_change_pct: 78,
  current_price: 112,
  next_earnings_date: 82,
  market_cap_usd: 112,
  dividend_yield: 70,
  drawdown_52w: 72,
  beta: 52,
  beta_adj: 52,
  rsi_day: 48,
  rsi_week: 48,
  rsi_month: 48,
  bb_day: 48,
  bb_week: 48,
  bb_month: 48,
  trailing_pe: 62,
  forward_pe: 62,
  price_to_book: 56,
  perf_1m: 64,
  perf_3m: 64,
  perf_6m: 64,
  perf_ytd: 64,
  perf_1y: 64,
  perf_3y: 64,
  perf_5y: 64,
};

const interestAlwaysVisibleFields = new Set(["display_change_pct", "current_price"]);
const INTEREST_TABLE_COLUMN_COUNT = 28;

function interestEmptyRow(message) {
  return `<tr class="interest-empty-row">${Array.from({ length: INTEREST_TABLE_COLUMN_COUNT }, (_, index) => {
    if (index === 1) return `<td class="interest-empty-cell">${esc(message)}</td>`;
    return "<td></td>";
  }).join("")}</tr>`;
}

function hasInterestColumnValue(row, field) {
  if (field === "next_earnings_date") return Boolean(row[field]);
  if (field === "dividend_yield") return Number(row[field]) > 0;
  return row[field] != null && Number.isFinite(Number(row[field]));
}

function syncInterestVisibleColumns(rows) {
  const table = document.querySelector("#interestTableWrap .interest-detail-list");
  if (!table) return;
  const headers = Array.from(table.querySelectorAll("thead th[data-interest-col]"))
    .sort((a, b) => Number(a.dataset.interestCol) - Number(b.dataset.interestCol));
  const cols = Array.from(table.querySelectorAll("colgroup col"));
  const tickerNameWidth = syncTickerNameColumnWidth(table);
  const groupCounts = {};
  let tableWidth = 40 + tickerNameWidth + 40;
  headers.forEach((header, index) => {
    const field = header.dataset.interestSortKey || "";
    const hide = Boolean(field)
      && !interestAlwaysVisibleFields.has(field)
      && !rows.some(row => hasInterestColumnValue(row, field));
    header.classList.toggle("hidden", hide);
    cols[index]?.classList.toggle("hidden", hide);
    table.querySelectorAll("tbody > tr").forEach(row => {
      row.cells[index]?.classList.toggle("hidden", hide);
    });
    const group = header.dataset.interestGroup || "";
    if (group && !hide) groupCounts[group] = (groupCounts[group] || 0) + 1;
    if (field && !hide) tableWidth += interestColumnWidths[field] || 64;
  });
  table.querySelectorAll("[data-interest-group-head]").forEach(header => {
    const group = header.dataset.interestGroupHead;
    const count = groupCounts[group] || 0;
    header.classList.toggle("hidden", count === 0);
    if (count > 0) header.colSpan = count;
  });
  table.style.width = `${tableWidth}px`;
  table.style.minWidth = "100%";
}

function renderInterestMainTable() {
  const group = activeInterestGroup();
  const body = document.getElementById("interestRows");
  if (!body) return;
  if (!group) {
    body.innerHTML = interestEmptyRow("선택할 관심그룹이 없습니다.");
    return;
  }
  const rows = statsRows(interestBaseRows());
  sortInterestRows(rows);
  const missingStats = rows.some(row => !statsData[row.ticker]
    || (!statsFetchedTickers.has(row.ticker) && hasMissingTechnicalStats(statsData[row.ticker])));
  if (missingStats) loadStatsForRows(rows);
  document.getElementById("tableTitle").textContent = group.name;
  document.getElementById("rowCount").textContent = `${rows.length} rows`;
  body.innerHTML = rows.length ? rows.map(r => `
    <tr class="${tableRowClass(r)}">
      <td class="logo-cell">${logoMarkup(r)}</td>
      <td>
        <span class="ticker-text">
          <a class="ticker-link" href="${esc(chartHref(r.ticker))}" data-chart-ticker="${esc(r.ticker)}">
            <span class="asset-name">${esc(r.name)}</span>
            <span class="ticker-symbol">${esc(r.ticker)}</span>
          </a>
        </span>
      </td>
      <td class="group-start">${changeMarkup(r)}</td>
      <td>${extendedChangeText(r) || "-"}</td>
      <td>${currentPriceMarkup(r)}</td>
      <td class="group-start">${earningsText(r.next_earnings_date)}</td>
      <td class="group-start">${marketCapMarkup(r)}</td>
      <td>${Number(r.dividend_yield) > 0
        ? `<button class="stat-yield-link" type="button" data-dividend-history="${esc(r.ticker)}">${dividendYieldText(r.dividend_yield)}</button>`
        : dividendYieldText(r.dividend_yield)}</td>
      <td>${signedPercentText(r.drawdown_52w, 1)}</td>
      <td>${betaText(r.beta)}</td>
      <td>${betaText(r.beta_adj)}</td>
      <td class="group-start">${indicatorText(r.rsi_day, "rsi")}</td>
      <td>${indicatorText(r.rsi_week, "rsi")}</td>
      <td>${indicatorText(r.rsi_month, "rsi")}</td>
      <td>${indicatorText(r.bb_day, "bb")}</td>
      <td>${indicatorText(r.bb_week, "bb")}</td>
      <td>${indicatorText(r.bb_month, "bb")}</td>
      <td class="group-start">${peText(r.trailing_pe)}</td>
      <td>${peText(r.forward_pe)}</td>
      <td>${peText(r.price_to_book)}</td>
      <td class="group-start">${signedPercentText(r.perf_1m, 1)}</td>
      <td>${signedPercentText(r.perf_3m, 0)}</td>
      <td>${signedPercentText(r.perf_6m, 0)}</td>
      <td>${signedPercentText(r.perf_ytd, 0)}</td>
      <td>${signedPercentText(r.perf_1y, 0)}</td>
      <td>${signedPercentText(r.perf_3y, 0)}</td>
      <td>${signedPercentText(r.perf_5y, 0)}</td>
      <td class="group-start">${group.fixed || isProtectedInterestItem(r, group)
        ? ""
        : `<button class="interest-row-delete" type="button" data-interest-main-remove="${esc(r.ticker)}" aria-label="${esc(r.name)} 삭제" title="관심목록에서 삭제">×</button>`}</td>
    </tr>
  `).join("") : interestEmptyRow(group.fixed ? "모든 수집 종목이 관심그룹에 분류되어 있습니다." : "이 그룹에 등록된 종목이 없습니다.");
  syncInterestVisibleColumns(rows);
  // 티커 링크·배당이력 버튼 클릭은 app.js의 문서 위임이 처리 (개별 바인딩 금지)
  schedulePcFrozenColumns();
}

function initInterestWatchlists() {
  const savedTab = storageGet(sidebarStorage.activeTab);
  activeSidebarTab = savedTab === "interest" ? "interest" : "accounts";
  syncSidebarTabs();

  document.querySelectorAll("[data-sidebar-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      activeSidebarTab = btn.dataset.sidebarTab === "interest" ? "interest" : "accounts";
      storageSet(sidebarStorage.activeTab, activeSidebarTab);
      syncSidebarTabs();
      if (window.matchMedia("(max-width: 980px)").matches && mobileAccountsCollapsed) {
        mobileAccountsCollapsed = false;
        syncMobileCollapsePanels();
      }
      if (activeSidebarTab === "interest") {
        if (chartTicker || performanceChartOpen) closeChart(false);
        loadInterestWatchlists().catch(() => {});
      } else if (data) {
        render();
      }
    });
  });

  document.getElementById("interestGroupForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const input = document.getElementById("interestGroupName");
    const name = input.value.trim();
    if (!name) {
      setInterestStatus("그룹명을 입력하세요.", true);
      return;
    }
    mutateInterestWatchlist(() => apiCreateInterestGroup(name), "그룹 추가 중...");
    input.value = "";
  });

  document.getElementById("interestGroups")?.addEventListener("click", event => {
    const move = event.target.closest("[data-interest-move]");
    if (move) {
      moveInterestGroup(Number(move.dataset.interestMove), Number(move.dataset.direction));
      return;
    }
    const select = event.target.closest("[data-interest-select]");
    if (select) {
      activeInterestGroupId = Number(select.dataset.interestSelect);
      storageSet(sidebarStorage.interestGroupId, String(activeInterestGroupId));
      if (chartTicker || performanceChartOpen) closeChart(false);
      if (window.matchMedia("(max-width: 980px)").matches) {
        mobileAccountsCollapsed = true;
        syncMobileCollapsePanels();
      }
      render();
      return;
    }
    const rename = event.target.closest("[data-interest-rename]");
    if (rename) {
      editingInterestGroupId = Number(rename.dataset.interestRename);
      renderInterestWatchlists();
      document.querySelector(`[data-interest-rename-form="${editingInterestGroupId}"] input`)?.select();
      return;
    }
    if (event.target.closest("[data-interest-rename-cancel]")) {
      editingInterestGroupId = null;
      renderInterestWatchlists();
      return;
    }
    const deleteGroup = event.target.closest("[data-interest-group-delete]");
    if (deleteGroup) {
      const id = Number(deleteGroup.dataset.interestGroupDelete);
      const group = interestWatchlists.find(item => item.id === id);
      if (!group || !window.confirm(`'${group.name}' 그룹과 포함 종목을 삭제할까요?`)) return;
      if (activeInterestGroupId === id) activeInterestGroupId = null;
      mutateInterestWatchlist(() => apiDeleteInterestGroup(id), "그룹 삭제 중...");
    }
  });

  document.getElementById("interestGroups")?.addEventListener("submit", event => {
    const form = event.target.closest("[data-interest-rename-form]");
    if (!form) return;
    event.preventDefault();
    const groupId = Number(form.dataset.interestRenameForm);
    const name = form.querySelector("input").value.trim();
    if (!name) {
      setInterestStatus("그룹명을 입력하세요.", true);
      return;
    }
    editingInterestGroupId = null;
    mutateInterestWatchlist(() => apiRenameInterestGroup(groupId, name), "이름 변경 중...");
  });

  document.getElementById("interestMainItemForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const input = document.getElementById("interestMainTicker");
    const ticker = resolveInterestTicker(input.value);
    const group = activeInterestGroup();
    if (group?.fixed) {
      setInterestStatus("'기타'는 자동 분류 그룹이라 직접 추가할 수 없습니다.", true, true);
      return;
    }
    if (!group || !ticker) {
      setInterestStatus("가격수집 대상에서 종목을 정확히 선택하세요.", true, true);
      return;
    }
    mutateInterestWatchlist(() => apiAddInterestItem(group.id, ticker), "종목 추가 중...", true);
    input.value = "";
  });

  document.getElementById("interestBulkOpen")?.addEventListener("click", openInterestBulkModal);
  document.getElementById("interestBulkClose")?.addEventListener("click", () => {
    document.getElementById("interestBulkModal")?.close();
  });
  document.getElementById("interestBulkSelectAll")?.addEventListener("change", event => {
    document.querySelectorAll("#interestBulkList input[type='checkbox']").forEach(input => {
      input.checked = event.target.checked;
    });
    syncInterestBulkCount();
  });
  document.getElementById("interestBulkList")?.addEventListener("change", syncInterestBulkCount);
  document.getElementById("interestBulkApply")?.addEventListener("click", applyInterestBulkSelection);

  document.getElementById("interestRows")?.addEventListener("click", event => {
    const remove = event.target.closest("[data-interest-main-remove]");
    if (!remove) return;
    const group = activeInterestGroup();
    const item = group?.items.find(row => row.ticker === remove.dataset.interestMainRemove);
    if (!group || !item || !window.confirm(`'${item.name || item.ticker}' 종목을 관심목록에서 삭제할까요?`)) return;
    mutateInterestWatchlist(
      () => apiDeleteInterestItem(group.id, item.ticker),
      "종목 삭제 중...",
      true
    );
  });

  document.querySelectorAll("[data-interest-sort-key]").forEach(header => {
    header.addEventListener("click", () => {
      const key = header.dataset.interestSortKey;
      if (interestSortState.key === key) interestSortState.dir *= -1;
      else {
        interestSortState.key = key;
        // 통계탭(setCurrentSort)과 동일하게 기본 내림차순 — 탭 간 정렬방향 일관
        interestSortState.dir = defaultSortDir[key] || -1;
      }
      renderInterestMainTable();
    });
  });

  loadInterestWatchlists().catch(() => {});
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-interest-watchlists");

let interestWatchlists = [];
let interestWatchlistsLoaded = false;
let interestWatchlistsInFlight = null;
let activeSidebarTab = "accounts";
let activeInterestGroupId = null;
let editingInterestGroupId = null;
let interestGroupOrderSaving = false;
let draggedInterestGroupId = null;
let interestDropTargetId = null;
let interestDropAfter = false;
const interestSortState = { key: "display_change_pct", dir: -1, manual: false };
let interestAssetType = "all";
const interestAssetTypes = ["all", "etf", "stock"];
const interestAssetTypeLabels = { all: "전체", etf: "ETF", stock: "개별주" };

function interestAssetFilterAvailable() {
  const items = activeInterestGroup()?.items || [];
  return !items.length || items.some(item => !["index", "fx", "crypto"].includes(item.category));
}

function matchesInterestAssetType(row) {
  if (!interestAssetFilterAvailable() || interestAssetType === "all") return true;
  if (["index", "fx", "crypto"].includes(row.category)) return false;
  return (row.assetClass || row.asset_class) === interestAssetType;
}

function syncInterestAssetTypeControl() {
  const button = document.getElementById("interestAssetTypeToggle");
  if (!button) return;
  button.textContent = interestAssetTypeLabels[interestAssetType];
  button.setAttribute("aria-label", `종목 유형: ${button.textContent}. 클릭하면 다음 유형`);
  button.classList.toggle("active", interestAssetType !== "all");
}

function cycleInterestAssetType() {
  interestAssetType = interestAssetTypes[(interestAssetTypes.indexOf(interestAssetType) + 1) % interestAssetTypes.length];
  storageSet(detailStorage.interestAssetType, interestAssetType);
  syncInterestAssetTypeControl();
  render();
}

function initInterestAssetTypeControl() {
  const saved = storageGet(detailStorage.interestAssetType);
  interestAssetType = interestAssetTypes.includes(saved) ? saved : "all";
  syncInterestAssetTypeControl();
  document.getElementById("interestAssetTypeToggle")?.addEventListener("click", cycleInterestAssetType);
}

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

function interestGroupIsIndex(group = activeInterestGroup()) {
  return Boolean(group?.items?.length)
    && group.items.every(item => item.category === "index");
}

function interestGroupUsesManualDefault(group = activeInterestGroup()) {
  return interestGroupIsFx(group) || interestGroupIsIndex(group);
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

function interestGroupMarkup(group) {
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
      <span class="interest-drag-handle" draggable="true" tabindex="0" role="button"
            data-interest-drag="${group.id}" aria-label="${esc(group.name)} 순서 변경"
            title="드래그하여 순서 변경">
        <span aria-hidden="true">⠿</span>
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
  syncInterestDefaultSortForGroup();
}

function applyInterestWatchlistPayload(payload) {
  interestWatchlists = payload.groups || [];
  const aliases = payload.group_aliases || {};
  const selected = activeInterestGroupId ?? storageGet(sidebarStorage.interestGroupId);
  if (selected != null && aliases[selected] != null) {
    activeInterestGroupId = Number(aliases[selected]);
    storageSet(sidebarStorage.interestGroupId, String(activeInterestGroupId));
  }
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

function reorderedInterestGroups(draggedId, targetId, insertAfter) {
  // 실제 그룹만 재정렬 — 가상 "기타"는 항상 최하위 고정(reorder 페이로드에서 제외).
  const realGroups = interestWatchlists.filter(group => !group.fixed && group.id > 0);
  const sourceIndex = realGroups.findIndex(group => group.id === draggedId);
  if (sourceIndex < 0 || draggedId === targetId) return null;
  const originalIds = realGroups.map(group => group.id);
  const reordered = realGroups.slice();
  const [dragged] = reordered.splice(sourceIndex, 1);
  const targetIndex = reordered.findIndex(group => group.id === targetId);
  if (targetIndex < 0) return null;
  reordered.splice(targetIndex + (insertAfter ? 1 : 0), 0, dragged);
  return reordered.every((group, index) => group.id === originalIds[index]) ? null : reordered;
}

async function saveInterestGroupOrder(reordered) {
  if (interestGroupOrderSaving || !reordered?.length) return;
  const previous = interestWatchlists;
  const fixedGroups = interestWatchlists.filter(group => group.fixed || group.id <= 0);
  interestGroupOrderSaving = true;
  setInterestStatus("순서 저장 중...");
  interestWatchlists = [...reordered, ...fixedGroups];
  renderInterestWatchlists();
  try {
    applyInterestWatchlistPayload(
      await apiReorderInterestGroups(reordered.map(group => group.id))
    );
    setInterestStatus("");
  } catch (err) {
    interestWatchlists = previous;
    renderInterestWatchlists();
    setInterestStatus(err.message || String(err), true);
  } finally {
    interestGroupOrderSaving = false;
  }
}

function moveInterestGroup(groupId, direction) {
  if (interestGroupOrderSaving) return;
  const realGroups = interestWatchlists.filter(group => !group.fixed && group.id > 0);
  const index = realGroups.findIndex(group => group.id === groupId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= realGroups.length) return;
  const targetId = realGroups[targetIndex].id;
  saveInterestGroupOrder(reorderedInterestGroups(groupId, targetId, direction > 0));
}

function clearInterestGroupDragState() {
  const container = document.getElementById("interestGroups");
  container?.querySelectorAll(".dragging, .drag-over-before, .drag-over-after").forEach(element => {
    element.classList.remove("dragging", "drag-over-before", "drag-over-after");
  });
  draggedInterestGroupId = null;
  interestDropTargetId = null;
  interestDropAfter = false;
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

function interestBaseRows(options = {}) {
  const group = activeInterestGroup();
  if (!group) return [];
  const isFxGroup = interestGroupIsFx(group);
  // ignoreCurrency: 통화 선택지를 만들 때는 필터 자신을 빼야 목록이
  // 선택한 통화 하나로 쪼그라들지 않는다.
  const currencyFilter = (isFxGroup || options.ignoreCurrency) ? "all" : currencyFilterValue();
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
        assetClass: item.asset_class || row.assetClass,
        display_change_pct: holdingChangePct(row),
        current_price_krw: holdingUnitKrw(row),
      };
    })
    .filter(row => matchesInterestAssetType(row))
    .filter(row => currencyFilter === "all" || row.currency === currencyFilter);
}

function upcomingInterestEarningsDate(dateText, todayText = todayLocal()) {
  const date = localDateFromIso(dateText);
  const today = localDateFromIso(todayText);
  if (!date || !today || date < today) return null;
  return String(dateText).slice(0, 10);
}

function sortInterestRows(rows, group = activeInterestGroup()) {
  if (interestSortState.manual && interestGroupUsesManualDefault(group)) {
    const order = new Map((group?.items || []).map((item, index) => [String(item.ticker || "").toUpperCase(), index]));
    rows.sort((a, b) => (order.get(String(a.ticker || "").toUpperCase()) ?? 9999) - (order.get(String(b.ticker || "").toUpperCase()) ?? 9999));
    return;
  }
  const { key, dir } = interestSortState;
  // 계좌표와 같은 비교 함수(app-holdings.js compareListRows) — 규칙을 따로 두지 않는다.
  rows.sort((a, b) => compareListRows(a, b, key, dir));
}

function syncInterestDefaultSortForGroup(group = activeInterestGroup()) {
  if (interestGroupUsesManualDefault(group)) {
    interestSortState.manual = true;
    interestSortState.key = "";
    interestSortState.dir = 1;
    return;
  }
  interestSortState.manual = false;
  interestSortState.key = "display_change_pct";
  interestSortState.dir = -1;
}


// 섹터 다중 선택 상태 — 빈 Set = 전체 표시
const interestSectorSelection = new Set();
let interestSectorOptions = [];

function interestSectorButtonLabel() {
  if (!interestSectorSelection.size) return "전체";
  const picked = interestSectorOptions.filter(s => interestSectorSelection.has(s)).map(sectorLabel);
  if (!picked.length) return "전체";
  return picked.length === 1 ? picked[0] : `${picked[0]} 외 ${picked.length - 1}`;
}

function renderInterestSectorPanel() {
  const panel = document.getElementById("interestSectorPanel");
  if (!panel) return;
  const allActive = interestSectorSelection.size === 0;
  panel.innerHTML = `
    <button class="sector-filter-item${allActive ? " checked" : ""}" type="button" data-sector-all>
      <span class="sector-filter-check" aria-hidden="true">${allActive ? "✓" : ""}</span>전체
    </button>
    ${interestSectorOptions.map(s => {
      const checked = interestSectorSelection.has(s);
      return `<button class="sector-filter-item${checked ? " checked" : ""}" type="button" data-sector-value="${esc(s)}">
        <span class="sector-filter-check" aria-hidden="true">${checked ? "✓" : ""}</span>${esc(sectorLabel(s))}
      </button>`;
    }).join("")}`;
}

// 섹터 필터 UI: 현재 그룹 행에 섹터가 있으면 노출. 옵션 재구성 시 존재하지
// 않게 된 섹터는 선택에서 제거하고, 버튼 라벨·패널 체크를 동기화한다.
function syncInterestSectorFilter(rows) {
  const control = document.getElementById("interestSectorControl");
  const button = document.getElementById("interestSectorButton");
  if (!control || !button) return;
  const showing = interestModeActive() && !chartTicker && !performanceChartOpen;
  interestSectorOptions = [...new Set(rows.map(row => String(row.sector || "").trim()).filter(Boolean))]
    .sort((a, b) => sectorLabel(a).localeCompare(sectorLabel(b), "ko-KR"));
  [...interestSectorSelection].forEach(s => {
    if (!interestSectorOptions.includes(s)) interestSectorSelection.delete(s);
  });
  if (!showing || !interestSectorOptions.length) {
    control.classList.add("hidden");
    closeInterestSectorPanel();
    syncMobileFilterIndicator();
    return;
  }
  button.textContent = interestSectorButtonLabel();
  button.classList.toggle("filtering", interestSectorSelection.size > 0);
  if (!document.getElementById("interestSectorPanel")?.classList.contains("hidden")) renderInterestSectorPanel();
  control.classList.remove("hidden");
  syncMobileFilterIndicator();
}

function closeInterestSectorPanel() {
  document.getElementById("interestSectorPanel")?.classList.add("hidden");
  document.getElementById("interestSectorButton")?.setAttribute("aria-expanded", "false");
}

let interestRenderFrame = 0;

function scheduleInterestMainTable() {
  if (interestRenderFrame) return;
  interestRenderFrame = requestAnimationFrame(() => {
    interestRenderFrame = 0;
    if (interestModeActive()) renderInterestMainTable();
  });
}

// 큰 그룹은 보이는 행(+앞뒤 여유분)만 DOM에 그리고 나머지 높이는 빈 행(spacer)으로 채운다.
// 미국 개별주 258행 × 61열 = 셀 15,738개를 전부 만들면 그룹 전환 한 번에 ~370ms 멈췄다
// (셀 HTML 105 · 파싱 32 · 이름열 측정 53 · 레이아웃 92ms, 2026-09-26 실측). 화면엔 12행뿐이다.
// 작은 그룹(INTEREST_VIRTUAL_MIN_ROWS 이하)은 예전처럼 전부 그린다.
const INTEREST_VIRTUAL_MIN_ROWS = 60;
const INTEREST_VIRTUAL_OVERSCAN = 12;   // 보이는 범위 앞뒤로 더 그려 두는 행 수
const INTEREST_VIRTUAL_MARGIN = 4;      // 그려 둔 가장자리까지 이만큼 남으면 다시 그린다
let interestVirtual = null;             // {rows, columns, group, suppress, rowHeight, start, end}

function interestRowHtml(row, view) {
  return `<tr class="${view.suppress ? "" : tableRowClass(row)}">${interestRowCells(row, view.group, view.columns)}</tr>`;
}

function interestSpacerRow(height, colspan) {
  return height > 0
    ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${height}px"></td></tr>`
    : "";
}

// 스크롤 위치에 맞춰 그릴 구간만 다시 그린다. force가 아니면 보이는 범위가 그려 둔 구간 안쪽에
// 여유 있게 들어 있을 때는 아무것도 하지 않는다(스크롤 이벤트마다 부르므로 싸야 한다).
function renderInterestRowsWindow(force = false) {
  const view = interestVirtual;
  const body = document.getElementById("interestRows");
  const wrap = document.getElementById("interestTableWrap");
  if (!view || !body || !wrap) return;
  const total = view.rows.length;
  let start = 0, end = total;
  if (total > INTEREST_VIRTUAL_MIN_ROWS) {
    const rowHeight = view.rowHeight;
    const headHeight = wrap.querySelector("thead")?.offsetHeight || 0;
    const viewTop = Math.max(0, wrap.scrollTop - headHeight);
    // 표가 막 다시 보인 직후엔 높이(--list-rows-max-height)가 아직 안 잡혀 clientHeight가 작다 —
    // 사용자가 지정한 행 수만큼은 늘 그린다.
    const viewHeight = Math.max(wrap.clientHeight, rowHeight * selectedListVisibleRows);
    // 스크롤 위치가 목록 끝보다 아래일 수 있다(필터로 목록이 줄었는데 브라우저가 아직 스크롤을
    // 되돌리기 전). 보이는 첫 행을 '마지막 한 화면의 첫 행' 이하로 묶어 구간이 뒤집히지 않게 한다 —
    // 안 그러면 시작 188 / 끝 80처럼 행 없이 빈 영역만 그렸다(Astra 리뷰 2026-09-26).
    const visibleRows = Math.ceil(viewHeight / rowHeight);
    const first = Math.min(Math.floor(viewTop / rowHeight), Math.max(0, total - visibleRows));
    const last = Math.min(total, first + visibleRows);
    const covered = body.childElementCount > 0
      && view.start <= Math.max(0, first - INTEREST_VIRTUAL_MARGIN)
      && view.end >= Math.min(total, last + INTEREST_VIRTUAL_MARGIN);
    if (!force && covered) return;
    start = Math.max(0, first - INTEREST_VIRTUAL_OVERSCAN);
    end = Math.min(total, last + INTEREST_VIRTUAL_OVERSCAN);
  } else if (!force && body.childElementCount > 0 && view.start === 0 && view.end === total) {
    return;
  }
  view.start = start;
  view.end = end;
  const colspan = view.columns.length;
  body.innerHTML = interestSpacerRow(start * view.rowHeight, colspan)
    + view.rows.slice(start, end).map(row => interestRowHtml(row, view)).join("")
    + interestSpacerRow((total - end) * view.rowHeight, colspan);
  // 행 높이는 CSS 변수(최소값)가 아니라 실제로 그려진 행들의 평균으로 잰다 — 표 테두리가 겹치는
  // 방식(border-collapse) 탓에 빈 행 바로 다음 행 하나만 재면 0.5px씩 어긋나고, 그 오차가 행 수만큼
  // 쌓여 스크롤 위치와 보이는 행이 밀린다. 어긋나 있었으면 빈 행 높이를 바로잡아 한 번 더 그린다.
  if (total > INTEREST_VIRTUAL_MIN_ROWS && end - start > 1) {
    const drawn = body.querySelectorAll("tr:not(.virtual-spacer)");
    const span = drawn.length > 1
      ? drawn[drawn.length - 1].getBoundingClientRect().bottom - drawn[0].getBoundingClientRect().top
      : 0;
    const measured = drawn.length > 1 ? span / drawn.length : 0;
    if (measured > 0 && Math.abs(measured - view.rowHeight) > 0.25) {
      view.rowHeight = measured;
      renderInterestRowsWindow(true);
    }
  }
}

// 목록 구성(그룹 + 종목 집합)이 바뀌면 — 그룹 전환·명칭 검색·섹터/통화/보유 필터 — 스크롤을 맨 위로.
// 같은 목록의 재정렬·시세 갱신은 구성이 같으니 스크롤을 지킨다. 바뀌었으면 true.
let interestListKey = "";
function resetInterestScrollIfListChanged(group, rows) {
  const key = `${group?.id ?? ""}|${rows.map(row => row.ticker).sort().join(",")}`;
  if (key === interestListKey) return false;
  interestListKey = key;
  const wrap = document.getElementById("interestTableWrap");
  if (wrap) wrap.scrollTop = 0;
  return true;
}

function initialInterestRowHeight() {
  const table = document.querySelector("#interestTableWrap table");
  const value = table ? parseFloat(getComputedStyle(table).getPropertyValue("--list-row-height")) : NaN;
  return interestVirtual?.rowHeight || (Number.isFinite(value) && value > 0 ? value : 45);
}

function renderInterestMainTable() {
  cancelAnimationFrame(interestRenderFrame);
  interestRenderFrame = 0;
  const group = activeInterestGroup();
  const body = document.getElementById("interestRows");
  if (!body) return;
  if (!group) {
    renderInterestFrame(body.closest("table"), visibleInterestColumns([]));
    interestVirtual = null;
    body.innerHTML = interestEmptyRow("선택할 관심그룹이 없습니다.");
    return;
  }
  const baseRows = statsRows(interestBaseRows())
    .map(row => ({
      ...row,
      next_earnings_date: upcomingInterestEarningsDate(row.next_earnings_date),
    }))
    .map(attachConsensus);
  syncInterestSectorFilter(baseRows);
  const sectorRows = interestSectorSelection.size === 0
    ? baseRows
    : baseRows.filter(row => interestSectorSelection.has(String(row.sector || "").trim()));
  const rows = sectorRows.filter(row => matchesNameFilter(row));
  sortInterestRows(rows, group);
  // lazy-load는 섹터 필터와 무관하게 그룹 전체(baseRows) 기준 — 필터 전환 시 재요청 방지
  const missingStats = baseRows.some(row => !statsData[row.ticker]
    || (!statsFetchedTickers.has(row.ticker) && hasMissingTechnicalStats(statsData[row.ticker])));
  if (missingStats) loadStatsForRows(baseRows);
  // 애널리스트 컨센서스는 개별주·ETF만 대상(환율·지수·가상자산 제외). 도착하면
  // 관심목록을 다시 그려 컨센서스 5컬럼을 채운다.
  loadQuotesForRows(baseRows.filter(consensusCandidate).map(row => row.ticker), scheduleInterestMainTable);
  document.getElementById("tableTitle").textContent = group.name;
  document.getElementById("rowCount").textContent = `${rows.length} rows`;
  const suppressIndexHighlight = interestGroupIsIndex(group);
  const table = body.closest("table");
  const columns = visibleInterestColumns(rows, suppressIndexHighlight);
  renderInterestFrame(table, columns);
  resetInterestScrollIfListChanged(group, rows);
  if (rows.length) {
    interestVirtual = {
      rows, columns, group, suppress: suppressIndexHighlight,
      rowHeight: initialInterestRowHeight(), start: 0, end: 0,
    };
    renderInterestRowsWindow(true);
  } else {
    interestVirtual = null;
    body.innerHTML = interestEmptyRow(nameFilterValue()
      ? "명칭 검색 결과가 없습니다."
      : interestAssetType !== "all" && interestAssetFilterAvailable() ? "선택한 유형에 해당하는 종목이 없습니다."
      : group.fixed ? "모든 수집 종목이 관심그룹에 분류되어 있습니다." : "이 그룹에 등록된 종목이 없습니다.");
  }
  // 이름 열 폭은 DOM이 아니라 행 데이터 전체로 잰다 — 창 렌더링이라 DOM엔 일부 행만 있다.
  const nameWidth = syncTickerNameColumnWidth(table, { rows });
  // 표 전체 폭도 colgroup과 같은 --col-scale을 타야 한다. 여기만 원래 합을 쓰면
  // fixed 레이아웃이 남는 폭을 열마다 비례 배분해 축소가 통째로 무효가 된다.
  // 종목명 열은 내용 폭으로 측정된 값이라 배율에서 제외한다.
  const scaled = columns.reduce((width, column) => width + (column.key === "name" ? 0 : column.width), 0);
  table.style.width = `calc(${scaled}px * var(--col-scale, 1) + ${nameWidth}px)`;
  table.style.minWidth = "100%";
  // 관심목록은 pc-frozen(JS)을 쓰지 않아 그쪽 후처리를 타지 않는다 — 10행 뷰포트
  // 높이는 여기서 직접 잡아 준다(그리기 전에 재면 행 높이가 0이라 rAF 뒤에).
  if (typeof scheduleTableViewportRows === "function") scheduleTableViewportRows();
  // 티커 링크·배당이력 버튼 클릭은 app.js의 문서 위임이 처리 (개별 바인딩 금지).
  // 로고·종목명 틀고정은 CSS sticky가 담당 — pc-frozen(JS) 대상 아님.
}

function initInterestSectorFilter() {
  const button = document.getElementById("interestSectorButton");
  const panel = document.getElementById("interestSectorPanel");
  if (!button || !panel) return;
  button.addEventListener("click", () => {
    const opening = panel.classList.contains("hidden");
    if (opening) {
      renderInterestSectorPanel();
      panel.classList.remove("hidden");
      button.setAttribute("aria-expanded", "true");
    } else {
      closeInterestSectorPanel();
    }
  });
  panel.addEventListener("click", event => {
    const item = event.target.closest("button");
    if (!item) return;
    if (item.hasAttribute("data-sector-all")) {
      interestSectorSelection.clear();
    } else {
      const value = item.dataset.sectorValue || "";
      if (interestSectorSelection.has(value)) interestSectorSelection.delete(value);
      else interestSectorSelection.add(value);
    }
    renderInterestSectorPanel();   // 패널 유지한 채 체크만 갱신
    renderInterestMainTable();
  });
  document.addEventListener("click", event => {
    // 패널 항목 클릭 → 재렌더로 노드가 DOM에서 분리되면 closest가 실패해
    // 외부 클릭으로 오인·패널이 닫혀버린다 — 분리된 노드는 내부 클릭으로 간주.
    if (!event.target.isConnected) return;
    if (!event.target.closest?.("#interestSectorControl")) closeInterestSectorPanel();
  });
}

function setMobileFiltersExpanded(expanded) {
  document.getElementById("mobileFiltersToggle")?.setAttribute("aria-expanded", String(expanded));
  document.querySelector(".title-tools")?.classList.toggle("filters-expanded", expanded);
  if (!expanded) closeInterestSectorPanel();
}

function initInterestWatchlists() {
  initInterestSectorFilter();
  // 창 렌더링: 스크롤할 때 그려 둔 구간을 벗어나면 그 자리 행을 다시 그린다. 한 번만 바인딩.
  // rAF에 미루지 않는다 — 판정이 싸고, rAF가 멈추는 환경(미리보기 패널)에서도 동작해야 한다.
  document.getElementById("interestTableWrap")?.addEventListener("scroll", () => {
    if (interestVirtual && interestModeActive()) renderInterestRowsWindow();
  }, { passive: true });
  document.getElementById("mobileFiltersToggle")?.addEventListener("click", () => {
    const button = document.getElementById("mobileFiltersToggle");
    setMobileFiltersExpanded(button.getAttribute("aria-expanded") !== "true");
  });
  const savedTab = storageGet(sidebarStorage.activeTab);
  activeSidebarTab = savedTab === "interest" ? "interest" : "accounts";
  syncSidebarTabs();

  document.querySelectorAll("[data-sidebar-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const nextTab = btn.dataset.sidebarTab === "interest" ? "interest" : "accounts";
      const mobile = window.matchMedia("(max-width: 980px)").matches;
      // 모바일에서 현재 선택된 탭을 다시 누르면 화살표와 동일하게 접는다.
      if (mobile && nextTab === activeSidebarTab && !mobileAccountsCollapsed) {
        mobileAccountsCollapsed = true;
        syncMobileCollapsePanels();
        return;
      }
      activeSidebarTab = nextTab;
      storageSet(sidebarStorage.activeTab, activeSidebarTab);
      syncSidebarTabs();
      if (mobile) {
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

  const interestGroupsElement = document.getElementById("interestGroups");
  interestGroupsElement?.addEventListener("dragstart", event => {
    const handle = event.target.closest("[data-interest-drag]");
    if (!handle || interestGroupOrderSaving) {
      event.preventDefault();
      return;
    }
    draggedInterestGroupId = Number(handle.dataset.interestDrag);
    handle.closest(".interest-group")?.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(draggedInterestGroupId));
  });

  interestGroupsElement?.addEventListener("dragover", event => {
    if (draggedInterestGroupId == null) return;
    const target = event.target.closest(".interest-group:not(.fixed)");
    interestGroupsElement.querySelectorAll(".drag-over-before, .drag-over-after").forEach(element => {
      element.classList.remove("drag-over-before", "drag-over-after");
    });
    const targetId = Number(target?.dataset.interestGroup);
    if (!targetId || targetId === draggedInterestGroupId) {
      interestDropTargetId = null;
      interestDropAfter = false;
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = target.getBoundingClientRect();
    interestDropAfter = event.clientY >= rect.top + rect.height / 2;
    interestDropTargetId = targetId;
    target.classList.add(interestDropAfter ? "drag-over-after" : "drag-over-before");
  });

  interestGroupsElement?.addEventListener("drop", event => {
    const targetId = Number(event.target.closest(".interest-group:not(.fixed)")?.dataset.interestGroup);
    if (draggedInterestGroupId == null || interestDropTargetId == null || targetId !== interestDropTargetId) {
      clearInterestGroupDragState();
      return;
    }
    event.preventDefault();
    const reordered = reorderedInterestGroups(
      draggedInterestGroupId,
      interestDropTargetId,
      interestDropAfter,
    );
    clearInterestGroupDragState();
    saveInterestGroupOrder(reordered);
  });

  interestGroupsElement?.addEventListener("dragend", clearInterestGroupDragState);

  interestGroupsElement?.addEventListener("keydown", event => {
    const handle = event.target.closest("[data-interest-drag]");
    if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    moveInterestGroup(Number(handle.dataset.interestDrag), event.key === "ArrowUp" ? -1 : 1);
  });

  interestGroupsElement?.addEventListener("click", event => {
    const select = event.target.closest("[data-interest-select]");
    if (select) {
      const nextGroupId = Number(select.dataset.interestSelect);
      // 같은 그룹 재클릭이면 사용자가 고른 정렬을 유지 — 그룹이 실제로
      // 바뀔 때만 그룹 특성(지수/환율=수동, 일반=등락) 기본정렬 적용.
      const groupChanged = nextGroupId !== activeInterestGroupId;
      activeInterestGroupId = nextGroupId;
      storageSet(sidebarStorage.interestGroupId, String(activeInterestGroupId));
      if (groupChanged) syncInterestDefaultSortForGroup();
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
    const unregister = event.target.closest("[data-interest-unregister]");
    if (unregister) {
      const group = activeInterestGroup();
      const ticker = unregister.dataset.interestUnregister;
      const item = group?.items.find(row => row.ticker === ticker);
      if (!group?.fixed || !item) return;
      if (!window.confirm(`'${item.name || item.ticker}' 종목을 수집 대상에서 제외할까요?\n시세·배당 이력이 삭제됩니다.`)) return;
      mutateInterestWatchlist(async () => {
        const payload = await apiUnregisterCollectedTicker(item.ticker);
        if (data?.tickers) data.tickers = data.tickers.filter(row => row.ticker !== item.ticker);
        if (typeof statsData === "object" && statsData) delete statsData[item.ticker];
        return payload;
      }, "수집 대상에서 제외하는 중...", true);
      return;
    }
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

  // 헤더는 표시 열이 바뀔 때 재생성된다. 상위 요소에서 한 번만 위임한다.
  document.getElementById("interestTableWrap").addEventListener("click", event => {
    const header = event.target.closest("[data-interest-sort-key]");
    if (!header) return;
    const key = header.dataset.interestSortKey;
    if (!interestSortState.manual && interestSortState.key === key) interestSortState.dir *= -1;
    else {
      interestSortState.manual = false;
      interestSortState.key = key;
      // 통계탭(setCurrentSort)과 동일하게 기본 내림차순 — 탭 간 정렬방향 일관
      interestSortState.dir = defaultSortDir[key] || -1;
    }
    renderInterestMainTable();
  });

  loadInterestWatchlists().catch(() => {});
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-interest-watchlists");

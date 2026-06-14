let interestWatchlists = [];
let interestWatchlistsLoaded = false;
let interestWatchlistsInFlight = null;
let activeSidebarTab = "accounts";
let activeInterestGroupId = null;
let editingInterestGroupId = null;
const interestSortState = { key: "name", dir: 1 };

function interestModeActive() {
  return activeSidebarTab === "interest" && activeInterestGroupId != null;
}

function activeInterestGroup() {
  return interestWatchlists.find(group => group.id === activeInterestGroupId) || null;
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
    .map(item => `<option value="${esc(item.ticker)}">${esc(item.name || item.ticker)}</option>`)
    .join("");
}

function resolveInterestTicker(value) {
  const query = String(value || "").trim();
  if (!query) return null;
  const upper = query.toUpperCase();
  const compact = query.replace(/\s+/g, "").toUpperCase();
  const options = trackedTickerOptions();
  const exact = options.find(item => String(item.ticker).toUpperCase() === upper)
    || options.find(item => String(item.name || "").replace(/\s+/g, "").toUpperCase() === compact);
  if (exact) return exact.ticker;
  const matches = options.filter(item =>
    String(item.ticker).toUpperCase().includes(upper)
    || String(item.name || "").replace(/\s+/g, "").toUpperCase().includes(compact)
  );
  return matches.length === 1 ? matches[0].ticker : null;
}

function interestGroupMarkup(group) {
  const active = group.id === activeInterestGroupId;
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
        <span class="interest-group-name">${esc(group.name)}</span>
        <span class="interest-count">${group.items.length}</span>
      </button>
      <button class="interest-icon-btn" type="button" data-interest-rename="${group.id}" aria-label="${esc(group.name)} 이름 변경" title="이름 변경">✎</button>
      <button class="interest-icon-btn danger" type="button" data-interest-group-delete="${group.id}" aria-label="${esc(group.name)} 삭제" title="그룹 삭제">×</button>
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
  const saved = Number(storageGet(sidebarStorage.interestGroupId));
  const savedGroup = interestWatchlists.find(group => group.id === saved);
  activeInterestGroupId = savedGroup?.id ?? interestWatchlists[0]?.id ?? null;
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

function interestBaseRows() {
  const group = activeInterestGroup();
  if (!group) return [];
  const currencyFilter = currencyFilterValue();
  const fxAdjusted = fxAdjustedEnabled();
  return group.items
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

function renderInterestMainTable() {
  const group = activeInterestGroup();
  const body = document.getElementById("interestRows");
  if (!body) return;
  if (!group) {
    body.innerHTML = '<tr><td colspan="28">선택할 관심그룹이 없습니다.</td></tr>';
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
      <td>${changeMarkup(r)}</td>
      <td>${extendedChangeText(r) || "-"}</td>
      <td>${currentPriceMarkup(r)}</td>
      <td>${earningsText(r.next_earnings_date)}</td>
      <td>${marketCapMarkup(r)}</td>
      <td>${Number(r.dividend_yield) > 0
        ? `<button class="stat-yield-link" type="button" data-dividend-history="${esc(r.ticker)}">${dividendYieldText(r.dividend_yield)}</button>`
        : dividendYieldText(r.dividend_yield)}</td>
      <td>${signedPercentText(r.drawdown_52w, 1)}</td>
      <td>${betaText(r.beta)}</td>
      <td>${betaText(r.beta_adj)}</td>
      <td>${indicatorText(r.rsi_day, "rsi")}</td>
      <td>${indicatorText(r.rsi_week, "rsi")}</td>
      <td>${indicatorText(r.rsi_month, "rsi")}</td>
      <td>${indicatorText(r.bb_day, "bb")}</td>
      <td>${indicatorText(r.bb_week, "bb")}</td>
      <td>${indicatorText(r.bb_month, "bb")}</td>
      <td>${peText(r.trailing_pe)}</td>
      <td>${peText(r.forward_pe)}</td>
      <td>${peText(r.price_to_book)}</td>
      <td>${signedPercentText(r.perf_1m, 1)}</td>
      <td>${signedPercentText(r.perf_3m, 0)}</td>
      <td>${signedPercentText(r.perf_6m, 0)}</td>
      <td>${signedPercentText(r.perf_ytd, 0)}</td>
      <td>${signedPercentText(r.perf_1y, 0)}</td>
      <td>${signedPercentText(r.perf_3y, 0)}</td>
      <td>${signedPercentText(r.perf_5y, 0)}</td>
      <td><button class="interest-row-delete" type="button" data-interest-main-remove="${esc(r.ticker)}" aria-label="${esc(r.name)} 삭제" title="관심목록에서 삭제">×</button></td>
    </tr>
  `).join("") : '<tr><td colspan="28">이 그룹에 등록된 종목이 없습니다.</td></tr>';
  bindChartLinks();
  body.querySelectorAll("[data-dividend-history]").forEach(btn => {
    btn.addEventListener("click", () => openDividendHistory(btn.dataset.dividendHistory));
  });
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
    const select = event.target.closest("[data-interest-select]");
    if (select) {
      activeInterestGroupId = Number(select.dataset.interestSelect);
      storageSet(sidebarStorage.interestGroupId, String(activeInterestGroupId));
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
    if (!group || !ticker) {
      setInterestStatus("가격수집 대상에서 종목을 정확히 선택하세요.", true, true);
      return;
    }
    mutateInterestWatchlist(() => apiAddInterestItem(group.id, ticker), "종목 추가 중...", true);
    input.value = "";
  });

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
        interestSortState.dir = defaultSortDir[key] || 1;
      }
      renderInterestMainTable();
    });
  });

  loadInterestWatchlists().catch(() => {});
}

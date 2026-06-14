let interestWatchlists = [];
let interestWatchlistsLoaded = false;
let interestWatchlistsInFlight = null;
let activeSidebarTab = "accounts";
const interestExpandedGroups = new Set();
let interestExpansionInitialized = false;

function setInterestStatus(message = "", error = false) {
  const el = document.getElementById("interestStatus");
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

function interestItemMarkup(groupId, item) {
  const meta = findTickerMeta(item.ticker) || item;
  const row = {
    ...item,
    ...meta,
    ticker: item.ticker,
    name: item.name || meta.name || item.ticker,
  };
  const changePct = meta.change_pct == null ? null : Number(meta.change_pct);
  return `
    <div class="interest-item">
      <button class="interest-item-main" type="button" data-interest-chart="${esc(item.ticker)}" title="${esc(row.name)} 상세보기">
        ${logoMarkup(row)}
        <span class="interest-item-name">
          <strong>${esc(row.name)}</strong>
          <span>${esc(item.ticker)}</span>
        </span>
      </button>
      <span class="interest-item-quote">
        <strong>${unitMoney(meta.current_price, meta.currency || item.currency, item.ticker)}</strong>
        ${changePercentText(changePct)}
      </span>
      <button class="interest-icon-btn danger" type="button" data-interest-remove="${esc(item.ticker)}" data-group-id="${groupId}" aria-label="${esc(row.name)} 삭제" title="관심목록에서 삭제">×</button>
    </div>
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
  if (!interestExpansionInitialized) {
    interestExpandedGroups.add(interestWatchlists[0].id);
    interestExpansionInitialized = true;
  }
  container.innerHTML = interestWatchlists.map(group => {
    const expanded = interestExpandedGroups.has(group.id);
    return `
      <section class="interest-group ${expanded ? "expanded" : ""}" data-interest-group="${group.id}">
        <div class="interest-group-head">
          <button class="interest-group-toggle" type="button" data-interest-toggle="${group.id}" aria-expanded="${expanded}">
            <span class="interest-caret" aria-hidden="true"></span>
            <span class="interest-group-name">${esc(group.name)}</span>
            <span class="interest-count">${group.items.length}</span>
          </button>
          <button class="interest-icon-btn" type="button" data-interest-add-toggle="${group.id}" aria-label="${esc(group.name)}에 종목 추가" title="종목 추가">+</button>
          <button class="interest-icon-btn danger" type="button" data-interest-group-delete="${group.id}" aria-label="${esc(group.name)} 삭제" title="그룹 삭제">×</button>
        </div>
        <div class="interest-group-body ${expanded ? "" : "hidden"}">
          <form class="interest-item-form hidden" data-interest-item-form="${group.id}">
            <input type="search" list="interestTickerOptions" placeholder="티커 또는 종목명" autocomplete="off">
            <button type="submit">추가</button>
          </form>
          <div class="interest-items">
            ${group.items.length
              ? group.items.map(item => interestItemMarkup(group.id, item)).join("")
              : '<div class="interest-empty compact">등록된 종목이 없습니다.</div>'}
          </div>
        </div>
      </section>
    `;
  }).join("");
}

function applyInterestWatchlistPayload(payload) {
  interestWatchlists = payload.groups || [];
  interestWatchlistsLoaded = true;
  renderInterestWatchlists();
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

async function mutateInterestWatchlist(action, progressText) {
  setInterestStatus(progressText);
  try {
    applyInterestWatchlistPayload(await action());
    setInterestStatus("");
  } catch (err) {
    setInterestStatus(err.message || String(err), true);
  }
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
      if (activeSidebarTab === "interest") loadInterestWatchlists().catch(() => {});
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
    const toggle = event.target.closest("[data-interest-toggle]");
    if (toggle) {
      const id = Number(toggle.dataset.interestToggle);
      if (interestExpandedGroups.has(id)) interestExpandedGroups.delete(id);
      else interestExpandedGroups.add(id);
      renderInterestWatchlists();
      return;
    }
    const addToggle = event.target.closest("[data-interest-add-toggle]");
    if (addToggle) {
      const id = Number(addToggle.dataset.interestAddToggle);
      interestExpandedGroups.add(id);
      renderInterestWatchlists();
      const form = document.querySelector(`[data-interest-item-form="${id}"]`);
      form?.classList.remove("hidden");
      form?.querySelector("input")?.focus();
      return;
    }
    const deleteGroup = event.target.closest("[data-interest-group-delete]");
    if (deleteGroup) {
      const id = Number(deleteGroup.dataset.interestGroupDelete);
      const group = interestWatchlists.find(item => item.id === id);
      if (!group || !window.confirm(`'${group.name}' 그룹과 포함 종목을 삭제할까요?`)) return;
      interestExpandedGroups.delete(id);
      mutateInterestWatchlist(() => apiDeleteInterestGroup(id), "그룹 삭제 중...");
      return;
    }
    const remove = event.target.closest("[data-interest-remove]");
    if (remove) {
      const groupId = Number(remove.dataset.groupId);
      const group = interestWatchlists.find(item => item.id === groupId);
      const item = group?.items.find(row => row.ticker === remove.dataset.interestRemove);
      if (!window.confirm(`'${item?.name || remove.dataset.interestRemove}' 종목을 관심목록에서 삭제할까요?`)) return;
      mutateInterestWatchlist(
        () => apiDeleteInterestItem(groupId, remove.dataset.interestRemove),
        "종목 삭제 중..."
      );
      return;
    }
    const chart = event.target.closest("[data-interest-chart]");
    if (chart) {
      const ticker = chart.dataset.interestChart;
      history.pushState(null, "", chartHref(ticker));
      openChart(ticker);
    }
  });

  document.getElementById("interestGroups")?.addEventListener("submit", event => {
    const form = event.target.closest("[data-interest-item-form]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    const ticker = resolveInterestTicker(input.value);
    if (!ticker) {
      setInterestStatus("가격수집 대상에서 종목을 정확히 선택하세요.", true);
      return;
    }
    const groupId = Number(form.dataset.interestItemForm);
    interestExpandedGroups.add(groupId);
    mutateInterestWatchlist(() => apiAddInterestItem(groupId, ticker), "종목 추가 중...");
    input.value = "";
  });

  loadInterestWatchlists().catch(() => {});
}

// 종목 태그 — 종목마다 자유 태그(#반도체 #CPU #파운드리)를 붙이고 세부내역·배당·관심목록에서 거른다(2026-10-12).
// 태그는 서버(ticker_tags 표)에 저장해 기기와 무관하게 같고, 필터 선택만 이 브라우저에 저장한다.
// 목록에는 태그를 보이지 않는다(2026-10-15 사용자 지시) — 차트 헤더에서만 보고 고친다.
// 필터는 선택한 태그 중 하나라도 가진 종목(OR) — 섹터 필터와 같은 규칙.
let tickerTags = {};          // { TICKER: ["반도체", "CPU"] }
let tagCounts = [];           // [{ tag, count }] 많이 쓴 순
const tagFilterSelection = new Set();
let tagSaveInFlight = false;

function tagsFor(ticker) {
  return tickerTags[String(ticker || "").toUpperCase()] || [];
}

function matchesTagFilter(row) {
  if (!tagFilterSelection.size) return true;
  return tagsFor(row?.ticker).some(tag => tagFilterSelection.has(tag));
}

function applyTagFilter(rows) {
  return tagFilterSelection.size ? rows.filter(matchesTagFilter) : rows;
}

// 세부내역 표가 태그 필터 때문에 비었을 때의 안내 행(42열 표)
function detailTagEmptyRow() {
  return tagFilterSelection.size ? `<tr><td colspan="42" class="flat">선택한 태그의 보유 종목이 없습니다.</td></tr>` : "";
}

function parseTagInput(text) {
  const seen = new Set();
  return String(text || "").split(/[\s,]+/)
    .map(part => part.replace(/^#+/, "").trim())
    .filter(tag => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}

function setTagData(payload) {
  tickerTags = payload?.tags || {};
  tagCounts = payload?.all || [];
  const known = new Set(tagCounts.map(item => item.tag));
  [...tagFilterSelection].forEach(tag => { if (!known.has(tag)) tagFilterSelection.delete(tag); });
  saveTagFilterSelection();
}

async function loadTickerTags() {
  try {
    setTagData(await apiFetchTags());
  } catch (_err) {
    return;   // 태그가 안 와도 목록은 그대로 보인다
  }
  syncTagFilterControl();
  renderChartTags();
  if (data) render();   // 태그가 포트폴리오보다 먼저 오면 그리지 않는다 — 포트폴리오 로드가 곧 그린다
}

// ── 필터 컨트롤(섹터 필터와 같은 패널 모양) ─────────────────────────────────
function saveTagFilterSelection() {
  storageSet(detailStorage.tagFilter, JSON.stringify([...tagFilterSelection]));
}

function restoreTagFilterSelection() {
  try {
    const saved = JSON.parse(storageGet(detailStorage.tagFilter) || "[]");
    (Array.isArray(saved) ? saved : []).forEach(tag => tag && tagFilterSelection.add(String(tag)));
  } catch (_err) {
    tagFilterSelection.clear();
  }
}

function tagFilterButtonLabel() {
  const picked = tagCounts.map(item => item.tag).filter(tag => tagFilterSelection.has(tag));
  if (!picked.length) return "전체";
  return picked.length === 1 ? `#${picked[0]}` : `#${picked[0]} 외 ${picked.length - 1}`;
}

function renderTagFilterPanel() {
  const panel = document.getElementById("tagFilterPanel");
  if (!panel) return;
  const allActive = tagFilterSelection.size === 0;
  panel.innerHTML = `
    <button class="sector-filter-item${allActive ? " checked" : ""}" type="button" data-tag-all>
      <span class="sector-filter-check" aria-hidden="true">${allActive ? "✓" : ""}</span>전체
    </button>
    ${tagCounts.map(({ tag, count }) => {
      const checked = tagFilterSelection.has(tag);
      return `<button class="sector-filter-item${checked ? " checked" : ""}" type="button" data-tag-value="${esc(tag)}">
        <span class="sector-filter-check" aria-hidden="true">${checked ? "✓" : ""}</span>#${esc(tag)}<span class="tag-filter-count">${count}</span>
      </button>`;
    }).join("")}`;
}

function closeTagFilterPanel() {
  document.getElementById("tagFilterPanel")?.classList.add("hidden");
  document.getElementById("tagFilterButton")?.setAttribute("aria-expanded", "false");
}

// 목록 화면(세부내역·배당·관심목록)에서 태그가 하나라도 있으면 보인다. 차트에선 숨긴다.
function syncTagFilterControl() {
  const control = document.getElementById("tagFilterControl");
  const button = document.getElementById("tagFilterButton");
  if (!control || !button) return;
  const showing = !chartTicker && !performanceChartOpen && tagCounts.length > 0
    && !(interestModeActive() && interestGroupIsFx());
  control.classList.toggle("hidden", !showing);
  if (!showing) closeTagFilterPanel();
  button.textContent = tagFilterButtonLabel();
  button.classList.toggle("filtering", tagFilterSelection.size > 0);
  if (!document.getElementById("tagFilterPanel")?.classList.contains("hidden")) renderTagFilterPanel();
}

function initTagFilter() {
  restoreTagFilterSelection();
  const button = document.getElementById("tagFilterButton");
  const panel = document.getElementById("tagFilterPanel");
  if (!button || !panel) return;
  button.addEventListener("click", () => {
    if (panel.classList.contains("hidden")) {
      renderTagFilterPanel();
      panel.classList.remove("hidden");
      button.setAttribute("aria-expanded", "true");
    } else {
      closeTagFilterPanel();
    }
  });
  panel.addEventListener("click", event => {
    const item = event.target.closest("button");
    if (!item) return;
    if (item.hasAttribute("data-tag-all")) {
      tagFilterSelection.clear();
    } else {
      const value = item.dataset.tagValue || "";
      if (tagFilterSelection.has(value)) tagFilterSelection.delete(value);
      else tagFilterSelection.add(value);
    }
    saveTagFilterSelection();
    renderTagFilterPanel();   // 패널은 연 채로 체크만 갱신
    render();
  });
  document.addEventListener("click", event => {
    if (!event.target.isConnected) return;   // 재렌더로 떨어져 나간 패널 항목은 내부 클릭
    if (!event.target.closest?.("#tagFilterControl")) closeTagFilterPanel();
  });
}

// ── 차트 헤더: 태그 보기·편집 ──────────────────────────────────────────────────
function renderChartTags() {
  const host = document.getElementById("chartTags");
  if (!host) return;
  const ticker = String(chartTicker || "").toUpperCase();
  const editing = !document.getElementById("chartTagForm")?.classList.contains("hidden");
  host.classList.toggle("hidden", !ticker || performanceChartOpen || editing);
  if (!ticker || performanceChartOpen) {
    closeChartTagEditor();
    return;
  }
  const tags = tagsFor(ticker);
  host.innerHTML = `${tags.map(tag => `<button class="tag-chip chart-tag" type="button" data-tag-filter="${esc(tag)}" title="#${esc(tag)} 태그로 목록 거르기">#${esc(tag)}</button>`).join("")}`
    + `<button class="chart-tag-edit" id="chartTagEdit" type="button" title="태그 편집">${tags.length ? "✎" : "＃ 태그"}</button>`;
}

function renderChartTagSuggestions() {
  const host = document.getElementById("chartTagSuggestions");
  const input = document.getElementById("chartTagInput");
  if (!host || !input) return;
  const current = new Set(parseTagInput(input.value).map(tag => tag.toLowerCase()));
  const options = tagCounts.map(item => item.tag).filter(tag => !current.has(tag.toLowerCase())).slice(0, 20);
  host.innerHTML = options.map(tag => `<button class="tag-chip suggestion" type="button" data-tag-add="${esc(tag)}">#${esc(tag)}</button>`).join("");
}

function openChartTagEditor() {
  const ticker = String(chartTicker || "").toUpperCase();
  const input = document.getElementById("chartTagInput");
  if (!ticker || !input || tagSaveInFlight) return;
  input.value = tagsFor(ticker).map(tag => `#${tag}`).join(" ");
  input.dataset.ticker = ticker;
  document.getElementById("chartTagStatus").textContent = "";
  document.getElementById("chartTagForm")?.classList.remove("hidden");
  document.getElementById("chartTags")?.classList.add("hidden");
  renderChartTagSuggestions();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function closeChartTagEditor() {
  document.getElementById("chartTagForm")?.classList.add("hidden");
  const input = document.getElementById("chartTagInput");
  if (input) input.dataset.ticker = "";
  const host = document.getElementById("chartTags");
  if (host && chartTicker && !performanceChartOpen) host.classList.remove("hidden");
}

async function saveChartTags(event) {
  event.preventDefault();
  if (tagSaveInFlight) return;
  const input = document.getElementById("chartTagInput");
  const status = document.getElementById("chartTagStatus");
  const ticker = String(input?.dataset.ticker || chartTicker || "").toUpperCase();
  if (!ticker) return;
  tagSaveInFlight = true;
  if (status) status.textContent = "저장 중...";
  try {
    const result = await apiSaveTickerTags(ticker, parseTagInput(input.value));
    const next = { ...tickerTags };
    if (result.tags.length) next[result.ticker] = result.tags;
    else delete next[result.ticker];
    setTagData({ tags: next, all: result.all });
    closeChartTagEditor();
    renderChartTags();
    syncTagFilterControl();
  } catch (err) {
    if (status) status.textContent = err.message || String(err);
  } finally {
    tagSaveInFlight = false;
  }
}

function initChartTagEditor() {
  const host = document.getElementById("chartTags");
  host?.addEventListener("click", event => {
    if (event.target.closest("#chartTagEdit")) {
      openChartTagEditor();
      return;
    }
    // 태그 칩을 누르면 그 태그로 목록을 거른 채 목록으로 돌아간다
    const chip = event.target.closest("[data-tag-filter]");
    if (!chip) return;
    tagFilterSelection.clear();
    tagFilterSelection.add(chip.dataset.tagFilter);
    saveTagFilterSelection();
    closeChart();
  });
  document.getElementById("chartTagForm")?.addEventListener("submit", saveChartTags);
  document.getElementById("chartTagCancel")?.addEventListener("click", closeChartTagEditor);
  const input = document.getElementById("chartTagInput");
  input?.addEventListener("input", renderChartTagSuggestions);
  input?.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeChartTagEditor();
    }
  });
  document.getElementById("chartTagSuggestions")?.addEventListener("click", event => {
    const chip = event.target.closest("[data-tag-add]");
    if (!chip || !input) return;
    input.value = `${input.value.trim()} #${chip.dataset.tagAdd}`.trim();
    renderChartTagSuggestions();
    input.focus();
  });
}

function initTickerTags() {
  initTagFilter();
  initChartTagEditor();
  loadTickerTags();
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-ticker-tags");

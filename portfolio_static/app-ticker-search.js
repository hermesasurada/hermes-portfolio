let tickerSearchDirectory = null;
let tickerSearchMatches = [];
let tickerSearchActiveIndex = -1;

function normalizeTickerSearch(value) {
  return String(value || "")
    .trim()
    .toLocaleUpperCase()
    .replace(/[\s._-]+/g, "");
}

function tickerSearchTexts(item) {
  return [
    item?.name,
    ...(Array.isArray(item?.aliases) ? item.aliases : []),
  ].filter(Boolean).map(value => String(value).toLocaleUpperCase());
}

function rankTickerSearchItem(item, query) {
  const rawQuery = String(query || "").trim().toLocaleUpperCase();
  const compactQuery = normalizeTickerSearch(query);
  const ticker = String(item.ticker || "").toLocaleUpperCase();
  const compactTicker = normalizeTickerSearch(ticker);
  const names = tickerSearchTexts(item).map(text => ({
    raw: text,
    compact: normalizeTickerSearch(text),
  }));

  if (ticker === rawQuery || compactTicker === compactQuery) return 0;
  if (names.some(name => name.raw === rawQuery || name.compact === compactQuery)) return 1;
  if (ticker.startsWith(rawQuery) || compactTicker.startsWith(compactQuery)) return 2;
  if (names.some(name => name.raw.startsWith(rawQuery) || name.compact.startsWith(compactQuery))) return 3;
  if (ticker.includes(rawQuery) || compactTicker.includes(compactQuery)) return 4;
  if (names.some(name => name.raw.includes(rawQuery) || name.compact.includes(compactQuery))) return 5;
  return Number.POSITIVE_INFINITY;
}

function resolveTickerFromDirectory(value, directory, allowRaw = true) {
  const query = String(value || "").trim();
  if (!query) return "";
  const matches = (directory || [])
    .map(item => ({ item, rank: rankTickerSearchItem(item, query) }))
    .filter(result => Number.isFinite(result.rank))
    .sort((a, b) => a.rank - b.rank
      || String(a.item.ticker).localeCompare(String(b.item.ticker)));
  return matches.length ? String(matches[0].item.ticker || "").toUpperCase() : (allowRaw ? query.toUpperCase() : "");
}

function renderTickerSearchResults(query) {
  const results = document.getElementById("tickerSearchResults");
  if (!results) return;
  const cleanQuery = String(query || "").trim();
  tickerSearchActiveIndex = -1;

  if (!cleanQuery) {
    tickerSearchMatches = [];
    results.innerHTML = `<div class="ticker-search-empty">티커 또는 종목명을 입력하세요.</div>`;
    return;
  }
  if (!tickerSearchDirectory) {
    tickerSearchMatches = [];
    results.innerHTML = `<div class="ticker-search-empty">종목 목록을 불러오는 중...</div>`;
    return;
  }

  tickerSearchMatches = tickerSearchDirectory
    .map(item => ({ item, rank: rankTickerSearchItem(item, cleanQuery) }))
    .filter(result => Number.isFinite(result.rank))
    .sort((a, b) => a.rank - b.rank
      || String(a.item.ticker).localeCompare(String(b.item.ticker)))
    .slice(0, 12)
    .map(result => result.item);

  if (!tickerSearchMatches.length) {
    results.innerHTML = `<div class="ticker-search-empty">검색 결과가 없습니다.</div>`;
    return;
  }

  results.innerHTML = tickerSearchMatches.map((item, index) => `
    <button class="ticker-search-result" type="button" role="option"
      data-ticker-search-index="${index}" aria-selected="false">
      <strong>${esc(item.ticker)}</strong>
      <span>${esc(item.name || item.ticker)}</span>
    </button>
  `).join("");
}

function setTickerSearchActive(index) {
  if (!tickerSearchMatches.length) return;
  tickerSearchActiveIndex = Math.max(0, Math.min(index, tickerSearchMatches.length - 1));
  document.querySelectorAll("[data-ticker-search-index]").forEach((button, buttonIndex) => {
    const active = buttonIndex === tickerSearchActiveIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

function openTickerSearchResult(index) {
  const item = tickerSearchMatches[index];
  if (!item?.ticker) return;
  document.getElementById("tickerSearchModal")?.close();
  history.pushState(null, "", chartHref(item.ticker));
  openChart(item.ticker);
}

async function loadTickerSearchDirectory() {
  if (tickerSearchDirectory) return;
  const input = document.getElementById("tickerSearchInput");
  try {
    const payload = await apiFetchTickerDirectory();
    tickerSearchDirectory = payload.tickers || [];
    renderTickerSearchResults(input?.value);
  } catch (err) {
    document.getElementById("tickerSearchResults").innerHTML =
      `<div class="ticker-search-empty error">${esc(err.message || String(err))}</div>`;
  }
}

function initTickerSearch() {
  const modal = document.getElementById("tickerSearchModal");
  const input = document.getElementById("tickerSearchInput");
  const results = document.getElementById("tickerSearchResults");
  if (!modal || !input || !results) return;

  document.getElementById("tickerSearchOpen").addEventListener("click", () => {
    input.value = "";
    renderTickerSearchResults("");
    modal.showModal();
    input.focus();
    loadTickerSearchDirectory();
  });
  document.getElementById("tickerSearchClose").addEventListener("click", () => modal.close());
  modal.addEventListener("click", event => {
    if (event.target === modal) modal.close();
  });
  input.addEventListener("input", () => renderTickerSearchResults(input.value));
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setTickerSearchActive(tickerSearchActiveIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setTickerSearchActive(tickerSearchActiveIndex < 0
        ? tickerSearchMatches.length - 1
        : tickerSearchActiveIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      openTickerSearchResult(tickerSearchActiveIndex >= 0 ? tickerSearchActiveIndex : 0);
    }
  });
  results.addEventListener("click", event => {
    const button = event.target.closest?.("[data-ticker-search-index]");
    if (!button) return;
    openTickerSearchResult(Number(button.dataset.tickerSearchIndex));
  });
  results.addEventListener("mousemove", event => {
    const button = event.target.closest?.("[data-ticker-search-index]");
    if (!button) return;
    setTickerSearchActive(Number(button.dataset.tickerSearchIndex));
  });
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-ticker-search");

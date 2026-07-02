function renderWatchPending() {
  const list = document.getElementById("watchPending");
  const apply = document.getElementById("watchApply");
  list.innerHTML = watchPending.map(item => `
    <li>
      <span><strong>${esc(item.ticker)}</strong> · ${esc(item.name)} · ${esc(item.currency)}</span>
      <button class="ghost-btn" type="button" data-watch-remove="${esc(item.ticker)}">삭제</button>
    </li>
  `).join("");
  apply.disabled = watchPending.length === 0;
  apply.title = watchPending.length === 0 ? "검색 결과를 추가한 뒤 적용할 수 있습니다." : `${watchPending.length}개 종목 적용`;
  list.querySelectorAll("[data-watch-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      watchPending = watchPending.filter(item => item.ticker !== btn.dataset.watchRemove);
      renderWatchPending();
    });
  });
  updateWatchHint();
}

function setWatchStatus(message, error = false) {
  const el = document.getElementById("watchStatus");
  el.textContent = message || "";
  el.classList.toggle("error", error);
}

function updateWatchHint() {
  const hint = document.getElementById("watchHint");
  if (!hint) return;
  if (watchPending.length > 0) {
    hint.textContent = `${watchPending.length}개 종목이 적용 대기 중입니다.`;
    return;
  }
  if (watchLookupResult) {
    hint.textContent = "검색 결과를 먼저 추가한 뒤 적용하세요.";
    return;
  }
  hint.textContent = "검색 후 추가하면 적용할 수 있습니다.";
}

function renderWatchLookup(item = null) {
  watchLookupResult = item;
  const result = document.getElementById("watchResult");
  const add = document.getElementById("watchAdd");
  if (!item) {
    result.textContent = "-";
    add.disabled = true;
    add.textContent = "추가";
    add.classList.remove("watch-add-ready");
    updateWatchHint();
    return;
  }
  const alreadyPending = watchPending.some(row => row.ticker === item.ticker);
  const alreadyRegistered = Boolean(item.registered);
  const blocked = alreadyPending || alreadyRegistered;
  result.textContent = `${item.ticker} · ${item.name} · ${item.currency} · ${item.category}${alreadyRegistered ? " · 이미 등록됨" : ""}`;
  add.disabled = blocked;
  add.textContent = alreadyPending ? "추가됨" : alreadyRegistered ? "등록됨" : "추가하기";
  add.classList.toggle("watch-add-ready", !blocked);
  updateWatchHint();
}

function initWatchlistControls() {
  const modal = document.getElementById("watchModal");
  const input = document.getElementById("watchTickerInput");
  document.getElementById("watchlistOpen").addEventListener("click", () => {
    setWatchStatus("");
    renderWatchLookup(null);
    modal.showModal();
    input.focus();
  });
  document.getElementById("watchClose").addEventListener("click", () => modal.close());
  document.getElementById("watchLookup").addEventListener("click", async () => {
    const query = input.value.trim();
    if (!query) return;
    setWatchStatus("검색 중...");
    try {
      const payload = await apiLookupTicker(query);
      renderWatchLookup(payload.ticker);
      setWatchStatus(payload.ticker?.registered ? "이미 관리종목에 등록된 종목입니다." : "");
    } catch (err) {
      renderWatchLookup(null);
      setWatchStatus(err.message || String(err), true);
    }
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      document.getElementById("watchLookup").click();
    }
  });
  document.getElementById("watchAdd").addEventListener("click", () => {
    if (!watchLookupResult) return;
    if (!watchPending.some(item => item.ticker === watchLookupResult.ticker)) {
      watchPending = [...watchPending, watchLookupResult];
      renderWatchPending();
    }
    input.value = "";
    renderWatchLookup(null);
  });
  document.getElementById("watchApply").addEventListener("click", async () => {
    if (!watchPending.length) return;
    setWatchStatus("등록 중...");
    document.getElementById("watchApply").disabled = true;
    try {
      const result = await apiAddWatchlist(watchPending);
      watchPending = [];
      renderWatchPending();
      statsData = {};
      statsLoadKey = "";
      statsFetchedTickers = new Set();
      await load();
      setWatchStatus(result.message || "등록되었습니다. 동기화는 백그라운드에서 진행됩니다.");
    } catch (err) {
      setWatchStatus(err.message || String(err), true);
      renderWatchPending();
    } finally {
      document.getElementById("watchApply").disabled = false;
    }
  });
  renderWatchPending();
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-watchlist");

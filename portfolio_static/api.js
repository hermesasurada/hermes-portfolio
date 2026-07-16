async function fetchJson(url, options = {}) {
  const res = await fetch(url, { cache: "no-store", ...options });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "요청 실패");
  return payload;
}

function apiFetchPortfolio(usExtended) {
  const query = new URLSearchParams({ us_extended: usExtended ? "1" : "0" });
  return fetchJson(`/api/portfolio?${query.toString()}`);
}

function apiFetchStats(tickers) {
  const key = Array.from(new Set(tickers || [])).filter(Boolean).sort().join(",");
  return fetchJson(`/api/stats?tickers=${encodeURIComponent(key)}`);
}

function apiFetchQuotes(tickers) {
  // 애널리스트 컨센서스(목표가·업사이드·매수강도). 서버가 8767에서 프록시.
  const key = Array.from(new Set(tickers || [])).filter(Boolean).sort().join(",");
  return fetchJson(`/api/quote?ticker=${encodeURIComponent(key)}`);
}

function apiFetchDividends(accountIds, allAccounts) {
  const query = allAccounts ? "" : `?account_ids=${encodeURIComponent((accountIds || []).join(","))}`;
  return fetchJson(`/api/dividends${query}`);
}

function apiFetchDividendHistory(ticker) {
  return fetchJson(`/api/dividend-history?ticker=${encodeURIComponent(ticker || "")}`);
}

function apiFetchSchedule() {
  return fetchJson("/api/schedule");
}

function apiFetchChart(ticker) {
  return fetchJson(`/api/chart?ticker=${encodeURIComponent(ticker || "")}`);
}

function apiFetchAccountPerformance(accountIds, allAccounts, options = {}) {
  const query = new URLSearchParams();
  if (!allAccounts) query.set("account_ids", (accountIds || []).join(","));
  if (options.detail) query.set("detail", "1");
  if (options.range) query.set("range", options.range);
  if (options.start) query.set("start", options.start);
  if (options.end) query.set("end", options.end);
  return fetchJson(`/api/account-performance?${query.toString()}`);
}

function apiFetchTransactions(accountIds, allAccounts) {
  const query = allAccounts ? "" : `?account_ids=${encodeURIComponent((accountIds || []).join(","))}`;
  return fetchJson(`/api/transactions${query}`);
}

function apiSaveTransaction(payload) {
  return fetchJson("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function apiUpdateTransaction(payload) {
  return fetchJson("/api/transactions/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function apiDeleteTransaction(id) {
  return fetchJson("/api/transactions/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

function apiLookupTicker(query) {
  return fetchJson(`/api/watchlist/lookup?q=${encodeURIComponent(query || "")}`);
}

function apiFetchTickerDirectory() {
  return fetchJson("/api/tickers");
}

function apiFetchDiagnostics() {
  return fetchJson("/api/diagnostics");
}

function apiAddWatchlist(tickers) {
  return fetchJson("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tickers }),
  });
}

function apiFetchInterestWatchlists() {
  return fetchJson("/api/interest-watchlists");
}

function apiCreateInterestGroup(name) {
  return fetchJson("/api/interest-watchlists/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

function apiDeleteInterestGroup(groupId) {
  return fetchJson("/api/interest-watchlists/groups/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: groupId }),
  });
}

function apiRenameInterestGroup(groupId, name) {
  return fetchJson("/api/interest-watchlists/groups/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: groupId, name }),
  });
}

function apiReorderInterestGroups(groupIds) {
  return fetchJson("/api/interest-watchlists/groups/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_ids: groupIds }),
  });
}

function apiAddInterestItem(groupId, ticker) {
  return fetchJson("/api/interest-watchlists/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: groupId, ticker }),
  });
}

function apiDeleteInterestItem(groupId, ticker) {
  return fetchJson("/api/interest-watchlists/items/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: groupId, ticker }),
  });
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("api");

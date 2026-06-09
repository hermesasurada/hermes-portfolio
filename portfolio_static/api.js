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

function apiFetchDividends(accountIds, allAccounts) {
  const query = allAccounts ? "" : `?account_ids=${encodeURIComponent((accountIds || []).join(","))}`;
  return fetchJson(`/api/dividends${query}`);
}

function apiFetchDividendHistory(ticker) {
  return fetchJson(`/api/dividend-history?ticker=${encodeURIComponent(ticker || "")}`);
}

function apiFetchChart(ticker) {
  return fetchJson(`/api/chart?ticker=${encodeURIComponent(ticker || "")}`);
}

function apiFetchAccountPerformance(accountIds, allAccounts) {
  const query = allAccounts ? "" : `?account_ids=${encodeURIComponent((accountIds || []).join(","))}`;
  return fetchJson(`/api/account-performance${query}`);
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

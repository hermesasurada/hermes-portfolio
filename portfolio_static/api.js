async function fetchJson(url, options = {}) {
  const res = await fetch(url, { cache: "no-store", ...options });
  // 서버가 죽었거나 프록시가 HTML 오류 페이지를 주면 본문이 JSON이 아니다 — 파싱 오류 문구 대신 상태 코드를 알린다.
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || `요청 실패 (${res.status})`);
  if (payload == null) throw new Error("서버 응답을 읽지 못했습니다.");
  return payload;
}

function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiFetchPortfolio(usExtended, options = {}) {
  const query = new URLSearchParams({ us_extended: usExtended ? "1" : "0" });
  if (options.compact) query.set("compact", "1");
  const tickers = Array.from(new Set(options.tickers || [])).filter(Boolean).sort();
  if (tickers.length) query.set("tickers", tickers.join(","));
  return fetchJson(`/api/portfolio?${query.toString()}`);
}

function apiFetchStats(tickers, usExtended = usExtendedEnabled()) {
  const key = Array.from(new Set(tickers || [])).filter(Boolean).sort().join(",");
  const query = new URLSearchParams({
    tickers: key,
    us_extended: usExtended ? "1" : "0",
  });
  return fetchJson(`/api/stats?${query.toString()}`);
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

function apiFetchCashFlows() {
  return fetchJson("/api/cash-flows");
}

function apiSaveCashFlow(payload) {
  return postJson("/api/cash-flows", payload);
}

function apiFetchChart(ticker, usExtended = usExtendedEnabled(), options = {}) {
  const query = new URLSearchParams({
    ticker: ticker || "",
    us_extended: usExtended ? "1" : "0",
  });
  if (options.range) query.set("range", options.range);
  if (options.start) query.set("start", options.start);
  if (options.end) query.set("end", options.end);
  return fetchJson(`/api/chart?${query.toString()}`);
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

function apiFetchEtfHoldings(ticker) {
  return fetchJson(`/api/etf-holdings?ticker=${encodeURIComponent(ticker || "")}`);
}

// 이 종목을 편입한 ETF(구성종목 역방향, 2026-11-09)
function apiFetchEtfExposure(ticker) {
  return fetchJson(`/api/etf-exposure?ticker=${encodeURIComponent(ticker || "")}`);
}

// 증류 리포트의 기업별 촉매·일정(2026-11-08)
function apiFetchCompanyEvents(ticker) {
  return fetchJson(`/api/company-events?ticker=${encodeURIComponent(ticker || "")}`);
}

// 한 종목의 전 계좌 거래(종목 차트 '내역' 팝업, 2026-10-26)
function apiFetchTickerTransactions(ticker) {
  return fetchJson(`/api/transactions?ticker=${encodeURIComponent(ticker || "")}`);
}

function apiSaveTransaction(payload) {
  return postJson("/api/transactions", payload);
}

function apiUpdateTransaction(payload) {
  return postJson("/api/transactions/update", payload);
}

function apiUpdateTransactionMemo(id, memo) {
  return postJson("/api/transactions/memo", { id, memo });
}

function apiDeleteTransaction(id, applyToHoldings = false) {
  return postJson("/api/transactions/delete", { id, apply_to_holdings: Boolean(applyToHoldings) });
}

function apiLookupTicker(query) {
  return fetchJson(`/api/watchlist/lookup?q=${encodeURIComponent(query || "")}`);
}

function apiFetchTickerDirectory() {
  return fetchJson("/api/tickers");
}

function apiUpdateTickerDisplayName(ticker, displayName) {
  return postJson("/api/tickers/display-name", { ticker, display_name: displayName });
}

function apiFetchTags() {
  return fetchJson("/api/tags");
}

function apiSaveTickerTags(ticker, tags) {
  return postJson("/api/tags", { ticker, tags });
}

function apiFetchDiagnostics() {
  return fetchJson("/api/diagnostics");
}

function apiAddWatchlist(tickers) {
  return postJson("/api/watchlist", { tickers });
}

// 지우지 않고 막힌 이유만 묻는다 — {blocked: 이유|null}
function apiCheckUnregisterCollectedTicker(ticker) {
  return postJson("/api/watchlist/delete", { ticker, check: true });
}

function apiUnregisterCollectedTicker(ticker) {
  return postJson("/api/watchlist/delete", { ticker });
}

function apiFetchInterestWatchlists() {
  return fetchJson("/api/interest-watchlists");
}

function apiCreateInterestGroup(name) {
  return postJson("/api/interest-watchlists/groups", { name });
}

function apiDeleteInterestGroup(groupId) {
  return postJson("/api/interest-watchlists/groups/delete", { group_id: groupId });
}

function apiRenameInterestGroup(groupId, name) {
  return postJson("/api/interest-watchlists/groups/rename", { group_id: groupId, name });
}

function apiReorderInterestGroups(groupIds) {
  return postJson("/api/interest-watchlists/groups/reorder", { group_ids: groupIds });
}

function apiSetFavorite(ticker, favorite) {
  return postJson("/api/interest-watchlists/favorite", { ticker, favorite });
}

function apiAddInterestItem(groupId, ticker) {
  return postJson("/api/interest-watchlists/items", { group_id: groupId, ticker });
}

function apiDeleteInterestItem(groupId, ticker) {
  return postJson("/api/interest-watchlists/items/delete", { group_id: groupId, ticker });
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("api");

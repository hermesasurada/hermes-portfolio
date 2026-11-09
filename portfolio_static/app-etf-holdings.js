// ETF 구성종목 팝업(2026-11-04 사용자 지시): 상단 툴바 버튼 → 수집 캐시 조회.
// 수집은 hermes 크론(etf-holdings-weekly)이 맡고, 버튼 표시는 차트 응답의 has_etf_holdings를 따른다.
let etfHoldingsRequest = 0;

function syncChartEtfButton(payload) {
  const button = document.getElementById("chartEtfHoldings");
  if (!button) return;
  const visible = Boolean(payload?.has_etf_holdings) && !performanceChartOpen && !chartComparePayloads.length;
  button.classList.toggle("hidden", !visible);
  button.dataset.ticker = visible ? payload.ticker : "";
  button.dataset.name = visible ? (payload.name || payload.ticker) : "";
}

function etfWeightText(row) {
  if (row.weight == null) return "-";
  return `${row.estimated ? "약 " : ""}${Number(row.weight).toFixed(Math.abs(row.weight) < 10 ? 2 : 1)}%`;
}

function etfHoldingsSummaryMarkup(data) {
  const top = data.items.slice(0, 10).reduce((sum, row) => sum + Number(row.weight || 0), 0);
  const count = data.items.length + (data.others || []).length;
  const safeUrl = /^https:\/\//i.test(data.url || "") ? data.url : "";
  const source = safeUrl
    ? `<a class="etf-holdings-source" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(data.source)}</a>`
    : esc(data.source || "출처 미상");
  const stats = [
    source,
    data.as_of ? `${esc(data.as_of)} 기준` : "",
    data.complete ? `전체 ${count}개` : `공개된 ${count}개`,
    data.items.length > 10 && top > 0 ? `상위 10개 ${top.toFixed(1)}%` : "",
  ];
  return stats.filter(Boolean).map(text => `<span class="ticker-tx-stat">${text}</span>`).join("");
}

// 당일 등락 칸(2026-11-09): 일봉 최신 종가 기준, 기준일은 title. 포트폴리오에 시세가 없으면 '-'.
function etfDayChangeCell(row) {
  const title = row.change_date ? ` title="${esc(row.change_date)} 종가 기준"` : "";
  return `<td class="etf-day-change"${title}>${signedPercentText(row.change_pct)}</td>`;
}

function etfHoldingsRowMarkup(row, rank, cumulative, rowClass = "") {
  return `<tr${rowClass ? ` class="${rowClass}"` : ""}>
    <td>${rank}</td>
    <td class="etf-holdings-name">${esc(row.name)}</td>
    <td class="etf-holdings-symbol">${esc(row.symbol || "-")}</td>
    ${etfDayChangeCell(row)}
    <td${row.estimated ? ` title="CU 수량과 현재가로 환산한 추정 비중"` : ""}>${etfWeightText(row)}</td>
    <td class="etf-holdings-cumulative">${etfWeightText(cumulative)}</td>
  </tr>`;
}

function etfHoldingsTableMarkup(data) {
  const others = data.others || [];
  // 누적은 표 순서대로 끝까지 더한다. 비중이 없는 행은 '-'이고 합계를 건드리지 않는다.
  let total = 0;
  let estimated = false;
  const rowMarkup = (row, rank, rowClass) => {
    if (row.weight == null) return etfHoldingsRowMarkup(row, rank, { weight: null }, rowClass);
    total += Number(row.weight);
    estimated = estimated || Boolean(row.estimated);
    return etfHoldingsRowMarkup(row, rank, { weight: total, estimated }, rowClass);
  };
  const rows = data.items.map((row, index) => rowMarkup(row, index + 1));
  if (others.length) {
    rows.push(`<tr class="etf-holdings-group"><td colspan="6">현금·채권·파생 등</td></tr>`);
    others.forEach(row => rows.push(rowMarkup(row, "", "etf-holdings-other")));
  }
  return `<div class="dividend-history-table-wrap ticker-tx-table-wrap"><table class="dividend-history-table etf-holdings-table">
    <thead><tr><th>#</th><th>종목</th><th>티커</th><th>등락</th><th>비중</th><th>누적</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table></div>`;
}

async function openEtfHoldings(ticker, name) {
  const modal = document.getElementById("etfHoldingsModal");
  if (!modal || !ticker) return;
  const request = ++etfHoldingsRequest;
  const summary = document.getElementById("etfHoldingsSummary");
  const body = document.getElementById("etfHoldingsBody");
  document.getElementById("etfHoldingsTitle").textContent = `${name || ticker} 구성종목`;
  document.getElementById("etfHoldingsTicker").textContent = ticker;
  summary.innerHTML = "";
  body.innerHTML = `<div class="ticker-tx-empty flat">불러오는 중…</div>`;
  if (!modal.open) modal.showModal();
  try {
    const data = await apiFetchEtfHoldings(ticker);
    if (request !== etfHoldingsRequest) return;
    if (!data.found) {
      body.innerHTML = `<div class="ticker-tx-empty flat">아직 수집된 구성종목이 없습니다.</div>`;
      return;
    }
    summary.innerHTML = etfHoldingsSummaryMarkup(data);
    body.innerHTML = etfHoldingsTableMarkup(data);
  } catch (err) {
    if (request === etfHoldingsRequest) body.innerHTML = `<div class="ticker-tx-empty error">${esc(err.message || String(err))}</div>`;
  }
}

document.getElementById("chartEtfHoldings")?.addEventListener("click", event => {
  const { ticker, name } = event.currentTarget.dataset;
  openEtfHoldings(ticker, name);
});
document.getElementById("etfHoldingsClose")?.addEventListener("click", () => document.getElementById("etfHoldingsModal")?.close());
// ── 편입 ETF(2026-11-09 사용자 지시): 구성종목의 역방향 — 이 종목을 담은 ETF와 비중.
// 수집된 구성종목 캐시만 근거로 한다. 버튼 표시는 차트 응답의 etf_exposure_count를 따른다.
let etfExposureRequest = 0;

function syncChartExposureButton(payload) {
  const button = document.getElementById("chartEtfExposure");
  if (!button) return;
  const count = Number(payload?.etf_exposure_count || 0);
  const visible = count > 0 && !performanceChartOpen && !chartComparePayloads.length;
  button.classList.toggle("hidden", !visible);
  button.dataset.ticker = visible ? payload.ticker : "";
  button.dataset.name = visible ? (payload.name || payload.ticker) : "";
  button.innerHTML = `편입 ETF${visible ? ` <span class="company-events-badge">${count}</span>` : ""}`;
  button.title = visible ? `이 종목을 편입한 ETF ${count}개(수집된 구성종목 기준)` : "이 종목을 편입한 ETF";
}

function etfExposureSummaryMarkup(data) {
  const held = data.items.filter(row => row.held).length;
  const stats = [
    `수집된 ETF ${Number(data.collected || 0)}개 중 ${data.items.length}개 편입`,
    held ? `보유 ETF ${held}개` : "",
    data.partial ? `상위 일부만 공개된 ETF ${Number(data.partial)}개는 그 밖 편입을 알 수 없음` : "",
  ];
  return stats.filter(Boolean).map(text => `<span class="ticker-tx-stat">${esc(text)}</span>`).join("");
}

// 기준일: 올해는 월-일만(좁은 화면에서 열이 잘리지 않게), 다른 해는 그대로
function etfAsOfText(asOf, year = new Date().getFullYear()) {
  const text = String(asOf || "");
  if (!text) return "-";
  return text.startsWith(`${year}-`) ? text.slice(5) : text;
}

function etfExposureTableMarkup(data) {
  const rows = data.items.map((row, index) => `<tr>
    <td>${index + 1}</td>
    <td class="etf-holdings-name"><a class="ticker-link etf-exposure-link" href="${esc(chartHref(row.etf))}" data-chart-ticker="${esc(row.etf)}">${esc(row.name)}</a>${row.held ? ' <span class="etf-exposure-held">보유</span>' : ""}</td>
    <td class="etf-holdings-symbol">${esc(row.etf)}</td>
    ${etfDayChangeCell(row)}
    <td${row.estimated ? ` title="CU 수량과 현재가로 환산한 추정 비중"` : ""}>${etfWeightText(row)}</td>
    <td class="etf-holdings-cumulative" title="${esc([row.as_of, row.complete ? "" : "상위 일부만 공개된 출처"].filter(Boolean).join(" · "))}">${esc(etfAsOfText(row.as_of))}${row.complete ? "" : " *"}</td>
  </tr>`);
  return `<div class="dividend-history-table-wrap ticker-tx-table-wrap"><table class="dividend-history-table etf-holdings-table etf-exposure-table">
    <thead><tr><th>#</th><th>ETF</th><th>티커</th><th>등락</th><th>비중</th><th>기준일</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table></div>`;
}

async function openEtfExposure(ticker, name) {
  const modal = document.getElementById("etfExposureModal");
  if (!modal || !ticker) return;
  const request = ++etfExposureRequest;
  const summary = document.getElementById("etfExposureSummary");
  const body = document.getElementById("etfExposureBody");
  document.getElementById("etfExposureTitle").textContent = `${name || ticker} 편입 ETF`;
  document.getElementById("etfExposureTicker").textContent = ticker;
  summary.innerHTML = "";
  body.innerHTML = `<div class="ticker-tx-empty flat">불러오는 중…</div>`;
  if (!modal.open) modal.showModal();
  try {
    const data = await apiFetchEtfExposure(ticker);
    if (request !== etfExposureRequest) return;
    summary.innerHTML = etfExposureSummaryMarkup(data);
    body.innerHTML = data.items.length
      ? etfExposureTableMarkup(data)
      : `<div class="ticker-tx-empty flat">수집된 ETF 중 이 종목을 편입한 곳이 없습니다.</div>`;
  } catch (err) {
    if (request === etfExposureRequest) body.innerHTML = `<div class="ticker-tx-empty error">${esc(err.message || String(err))}</div>`;
  }
}

document.getElementById("chartEtfExposure")?.addEventListener("click", event => {
  const { ticker, name } = event.currentTarget.dataset;
  openEtfExposure(ticker, name);
});
document.getElementById("etfExposureClose")?.addEventListener("click", () => document.getElementById("etfExposureModal")?.close());
// ETF 이름을 누르면 팝업을 닫는다 — 차트 이동은 app.js 문서 위임(.ticker-link)이 맡는다. 백드롭 클릭도 닫기.
document.getElementById("etfExposureModal")?.addEventListener("click", event => {
  if (event.target === event.currentTarget || event.target.closest?.(".ticker-link")) event.currentTarget.close();
});
(window.__loaded = window.__loaded || new Set()).add("app-etf-holdings");

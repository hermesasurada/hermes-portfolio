// 촉매·일정 팝업(2026-11-08, 지식증류 연동): 상단 툴바 버튼 → 증류 리포트의 기업별 촉매·일정.
// 데이터는 증류가 만드는 company-events.latest.json뿐이다. 버튼은 차트 응답의 company_events 요약을 따른다
// (실적 예정일 역주입분만 있는 종목은 세부페이지와 중복이라 버튼이 없다).
let companyEventsRequest = 0;

const COMPANY_EVENT_BUCKETS = [
  ["upcoming", "다가오는 일정"],
  ["overdue_unresolved", "기한 경과 · 판정 대기"],
  ["undated", "일정 미정"],
  ["stale", "재확인 필요 · 45일 넘게 판정 없음"],
  ["resolved", "판정 완료"],
];

function syncChartEventsButton(payload) {
  const button = document.getElementById("chartCompanyEvents");
  if (!button) return;
  const summary = payload?.company_events;
  const visible = Boolean(summary?.count) && !performanceChartOpen && !chartComparePayloads.length;
  button.classList.toggle("hidden", !visible);
  button.dataset.ticker = visible ? payload.ticker : "";
  button.dataset.name = visible ? (payload.name || payload.ticker) : "";
  const upcoming = visible ? Number(summary.upcoming || 0) : 0;
  button.innerHTML = `촉매·일정${upcoming ? ` <span class="company-events-badge">${upcoming}</span>` : ""}`;
  button.title = upcoming ? `증류 리포트의 촉매·일정 · 다가오는 일정 ${upcoming}건` : "증류 리포트의 촉매·일정";
}

// 볼트 위키링크 [[대상|표시]] → 표시, [[대상]] → 대상
function companyEventPlain(text) {
  return String(text || "").replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1").trim();
}

function companyEventDateText(event) {
  if (event.date && event.date_precision === "day") return event.date;
  return event.date_text || event.date || "미정";
}

function companyEventSortKey(event) {
  return event.date || event.date_text || "￿";
}

function sortCompanyEvents(events) {
  const order = new Map(COMPANY_EVENT_BUCKETS.map(([bucket], index) => [bucket, index]));
  return [...events].sort((a, b) =>
    (order.get(a.bucket) ?? 99) - (order.get(b.bucket) ?? 99)
    || (a.attribution === "portfolio_db") - (b.attribution === "portfolio_db")
    || companyEventSortKey(a).localeCompare(companyEventSortKey(b)));
}

function companyEventStatusMarkup(event) {
  const verdict = event.verdict?.value;
  if (verdict) return `<span class="company-event-status verdict" title="${esc(event.verdict.note || "")}">${esc(verdict)}</span>`;
  return `<span class="company-event-status">${esc(event.status || "-")}</span>`;
}

function companyEventEvidenceMarkup(evidence) {
  const links = (evidence || []).map(item => {
    const label = esc(item.ref || item.source || "근거");
    const title = esc([item.title, item.date, item.source].filter(Boolean).join(" · "));
    return /^https:\/\//i.test(item.url || "")
      ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" title="${title}">${label}</a>`
      : `<span title="${title}">${label}</span>`;
  });
  return links.length ? `근거 ${links.join(", ")}` : "";
}

function companyEventRowMarkup(event) {
  const earnings = event.attribution === "portfolio_db";
  const source = event.source || {};
  const sourceText = [source.cluster, source.catalyst_id].filter(Boolean).join(" ");
  const hypotheses = (event.linked_hypotheses || []).map(h => esc(`${h.id ? `${h.id} ` : ""}${h.title || ""}`)).join(" · ");
  const meta = [
    earnings ? "포트폴리오 실적 일정" : (sourceText ? `출처 ${esc(sourceText)}` : ""),
    hypotheses ? `가설 ${hypotheses}` : "",
    companyEventEvidenceMarkup(event.evidence),
  ].filter(Boolean).map(text => `<span>${text}</span>`).join("");
  const detail = companyEventPlain(event.detail);
  const condition = companyEventPlain(event.success_condition);
  const tags = [
    earnings ? `<span class="company-event-tag">실적</span>` : "",
    event.attribution === "text_match" ? `<span class="company-event-tag" title="제목·내용의 기업명 일치로 붙인 추정">추정</span>` : "",
  ].join("");
  return `<tr class="${earnings ? "company-event-earnings" : ""}">
    <td class="company-event-date">${esc(companyEventDateText(event))}</td>
    <td>${companyEventStatusMarkup(event)}</td>
    <td class="company-event-main">
      <div class="company-event-title">${tags}${esc(companyEventPlain(event.title))}</div>
      ${detail ? `<div class="company-event-detail">${esc(detail)}</div>` : ""}
      ${condition ? `<div class="company-event-condition">성공 조건 · ${esc(condition)}</div>` : ""}
      ${event.verdict?.note ? `<div class="company-event-condition">판정 · ${esc(event.verdict.note)}</div>` : ""}
      ${meta ? `<div class="company-event-meta">${meta}</div>` : ""}
    </td>
  </tr>`;
}

function companyEventsTableMarkup(company) {
  const rows = [];
  let bucket = null;
  for (const event of sortCompanyEvents(company.events || [])) {
    if (event.bucket !== bucket) {
      bucket = event.bucket;
      const label = COMPANY_EVENT_BUCKETS.find(([key]) => key === bucket)?.[1] || bucket;
      rows.push(`<tr class="etf-holdings-group"><td colspan="3">${esc(label)}</td></tr>`);
    }
    rows.push(companyEventRowMarkup(event));
  }
  return `<div class="dividend-history-table-wrap ticker-tx-table-wrap"><table class="dividend-history-table company-events-table">
    <thead><tr><th>날짜</th><th>상태</th><th>촉매·일정</th></tr></thead>
    <tbody>${rows.join("")}</tbody></table></div>`;
}

function companyEventsSummaryMarkup(company) {
  const counts = company.counts || {};
  return [
    counts.upcoming ? `다가오는 ${counts.upcoming}` : "",
    counts.overdue_unresolved ? `기한 경과 ${counts.overdue_unresolved}` : "",
    counts.undated ? `미정 ${counts.undated}` : "",
    counts.stale ? `재확인 ${counts.stale}` : "",
    counts.resolved ? `판정 ${counts.resolved}` : "",
    company.next_date ? `다음 ${company.next_date}` : "",
  ].filter(Boolean).map(text => `<span class="ticker-tx-stat">${esc(text)}</span>`).join("");
}

async function openCompanyEvents(ticker, name) {
  const modal = document.getElementById("companyEventsModal");
  if (!modal || !ticker) return;
  const request = ++companyEventsRequest;
  const summary = document.getElementById("companyEventsSummary");
  const body = document.getElementById("companyEventsBody");
  const foot = document.getElementById("companyEventsFoot");
  document.getElementById("companyEventsTitle").textContent = `${name || ticker} 촉매·일정`;
  document.getElementById("companyEventsTicker").textContent = ticker;
  summary.innerHTML = "";
  foot.textContent = "";
  body.innerHTML = `<div class="ticker-tx-empty flat">불러오는 중…</div>`;
  if (!modal.open) modal.showModal();
  try {
    const data = await apiFetchCompanyEvents(ticker);
    if (request !== companyEventsRequest) return;
    foot.textContent = `증류 리포트(기준일 ${data.as_of || "미상"}) · LLM 추출, 사실검증 아님`;
    if (!data.company?.events?.length) {
      body.innerHTML = `<div class="ticker-tx-empty flat">증류 리포트에 이 종목의 촉매·일정이 없습니다.</div>`;
      return;
    }
    summary.innerHTML = companyEventsSummaryMarkup(data.company);
    body.innerHTML = companyEventsTableMarkup(data.company);
  } catch (err) {
    if (request === companyEventsRequest) body.innerHTML = `<div class="ticker-tx-empty error">${esc(err.message || String(err))}</div>`;
  }
}

document.getElementById("chartCompanyEvents")?.addEventListener("click", event => {
  const { ticker, name } = event.currentTarget.dataset;
  openCompanyEvents(ticker, name);
});
document.getElementById("companyEventsClose")?.addEventListener("click", () => document.getElementById("companyEventsModal")?.close());
(window.__loaded = window.__loaded || new Set()).add("app-company-events");

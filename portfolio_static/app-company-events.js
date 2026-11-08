// 촉매·일정 팝업(2026-11-08, 지식증류 연동): 상단 툴바 버튼 → 증류 리포트의 기업별 촉매·일정.
// 데이터는 증류가 만드는 company-events.latest.json뿐이다. 버튼은 차트 응답의 company_events 요약을 따른다.
// 표시는 날짜·상태·제목·확인조건까지만(출처·근거·가설·추정 라벨은 넣지 않는다, 2026-11-08 사용자 지시).
let companyEventsRequest = 0;

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

// 정렬(2026-11-08 사용자 지시): 묶음 없이 다가오는 일정(가까운 순) → 날짜 미정 → 지난 일정(최근 것부터, 흐리게).
// '다가오는'은 서버가 오늘 기준으로 다시 나눈 bucket을 따른다(파일의 bucket은 게시 때 값이라 최대 1주 어긋남).
function companyEventPhase(event) {
  if (!event.date) return "undated";
  return event.bucket === "upcoming" ? "upcoming" : "past";
}

function sortCompanyEvents(events) {
  const rank = { upcoming: 0, undated: 1, past: 2 };
  return [...events].sort((a, b) => {
    const pa = companyEventPhase(a);
    const pb = companyEventPhase(b);
    if (pa !== pb) return rank[pa] - rank[pb];
    if (pa === "upcoming") return a.date.localeCompare(b.date);
    if (pa === "past") return b.date.localeCompare(a.date);
    return String(a.date_text || "").localeCompare(String(b.date_text || ""));
  });
}

function companyEventDateMarkup(event) {
  if (!event.date || event.date_precision !== "day") {
    return `<span class="company-event-day text">${esc(event.date_text || event.date || "미정")}</span>`;
  }
  const [year, month, day] = event.date.split("-");
  return `<span class="company-event-day">${esc(`${Number(month)}.${day}`)}</span><span class="company-event-year">${esc(year)}</span>`;
}

function companyEventChipMarkup(event) {
  if (event.attribution === "portfolio_db") return `<span class="company-event-chip earnings">실적</span>`;
  const label = event.verdict?.value || event.status || "예정";
  const tone = /무산|미충족/.test(label) ? "bad" : /충족/.test(label) ? "good" : /지연|보류/.test(label) ? "warn" : "";
  return `<span class="company-event-chip${tone ? ` ${tone}` : ""}">${esc(label)}</span>`;
}

function companyEventItemMarkup(event) {
  const condition = companyEventPlain(event.success_condition);
  return `<li class="company-event-item${companyEventPhase(event) === "past" ? " past" : ""}">
    <div class="company-event-date">${companyEventDateMarkup(event)}</div>
    <div class="company-event-body">
      <div class="company-event-head">${companyEventChipMarkup(event)}<strong class="company-event-title">${esc(companyEventPlain(event.title))}</strong></div>
      ${condition ? `<div class="company-event-condition">${esc(condition)}</div>` : ""}
    </div>
  </li>`;
}

function companyEventsListMarkup(company) {
  return `<div class="dividend-history-table-wrap company-events-wrap"><ol class="company-events-list">${
    sortCompanyEvents(company.events || []).map(companyEventItemMarkup).join("")
  }</ol></div>`;
}

function companyEventsSummaryMarkup(company) {
  const counts = { upcoming: 0, undated: 0, past: 0 };
  for (const event of company.events || []) counts[companyEventPhase(event)] += 1;
  return [
    counts.upcoming ? `다가오는 ${counts.upcoming}` : "",
    counts.undated ? `미정 ${counts.undated}` : "",
    counts.past ? `지난 ${counts.past}` : "",
  ].filter(Boolean).map(text => `<span class="ticker-tx-stat">${esc(text)}</span>`).join(" · ");
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
    body.innerHTML = companyEventsListMarkup(data.company);
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

// 일정 팝업(2026-11-08 사용자 지시로 개편): 격자 폐기, 월별 목록 하나.
// 유형 = 실적·배당기준·배당지급·촉매(제목만)를 각각 켜고 끈다. 종목 = 시장(미국·일본·한국·기타) × 종류(전체·개별·ETF) × 보유만.
// 촉매는 증류 리포트(company-events)의 일 단위 날짜 촉매를 서버가 /api/schedule에 실어 준다.
const scheduleStorage = {
  types: "portfolio.schedule.types",
  markets: "portfolio.schedule.markets",
  kind: "portfolio.schedule.kind",
  heldOnly: "portfolio.schedule.heldOnly",
};

const SCHEDULE_TYPES = [
  { key: "earnings", label: "실적" },
  { key: "dividend_base", label: "배당기준" },
  { key: "dividend_pay", label: "배당지급" },
  { key: "catalyst", label: "촉매" },
];
const SCHEDULE_MARKETS = ["us", "jp", "kr", "other"];

let schedulePayload = null;
let scheduleLoadInFlight = null;
let scheduleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function scheduleStoredSet(key, allowed) {
  try {
    const saved = JSON.parse(storageGet(key) || "null");
    if (Array.isArray(saved)) return new Set(saved.filter(value => allowed.includes(value)));
  } catch { /* 저장값이 깨졌으면 기본값 */ }
  return new Set(allowed);
}

const scheduleTypeVisible = scheduleStoredSet(scheduleStorage.types, SCHEDULE_TYPES.map(type => type.key));
const scheduleMarketVisible = scheduleStoredSet(scheduleStorage.markets, SCHEDULE_MARKETS);
let scheduleKind = ["all", "stock", "etf"].includes(storageGet(scheduleStorage.kind)) ? storageGet(scheduleStorage.kind) : "all";
let scheduleHeldOnly = storageGet(scheduleStorage.heldOnly) === "1";

function scheduleMonthIndex(value) {
  return value.getFullYear() * 12 + value.getMonth();
}

function scheduleMonthKey(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function scheduleMarket(ticker) {
  const symbol = String(ticker || "").toUpperCase();
  if (/\.(KS|KQ)$/.test(symbol)) return "kr";
  if (/\.T$/.test(symbol)) return "jp";
  return symbol.includes(".") ? "other" : "us";
}

function scheduleMarketCapUsd(row) {
  const marketCapUsd = toUsd(row.market_cap, row.market_cap_currency || row.currency);
  return marketCapUsd != null && Number.isFinite(Number(marketCapUsd)) ? Number(marketCapUsd) : null;
}

const SCHEDULE_TYPE_ORDER = Object.fromEntries(SCHEDULE_TYPES.map((type, index) => [type.key, index]));

function compareScheduleEvents(a, b) {
  return a.date.localeCompare(b.date)
    || SCHEDULE_TYPE_ORDER[a.type] - SCHEDULE_TYPE_ORDER[b.type]
    || (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1)
    || String(a.ticker || "").localeCompare(String(b.ticker || ""));
}

function normalizedScheduleEvents(payload = schedulePayload) {
  if (!payload) return [];
  const today = String(payload.today || todayLocal()).slice(0, 10);
  const base = row => ({
    ticker: row.ticker,
    name: row.name,
    kind: row.kind === "etf" ? "etf" : "stock",
    market: scheduleMarket(row.ticker),
    owned: Boolean(row.owned),
    logo: row.logo,
    marketCapUsd: scheduleMarketCapUsd(row),
  });
  const events = [];
  for (const row of payload.earnings || []) {
    events.push({ ...base(row), type: "earnings", date: String(row.earnings_date || "").slice(0, 10), estimated: false });
  }
  for (const row of payload.dividends || []) {
    const money = { amount: row.amount, currency: row.currency };
    if (row.base_date) {
      events.push({ ...base(row), ...money, type: "dividend_base", date: row.base_date, estimated: Boolean(row.base_estimated), baseKind: row.base_kind });
    }
    const pay = row.pay_date || row.date;
    if (pay) events.push({ ...base(row), ...money, type: "dividend_pay", date: String(pay).slice(0, 10), estimated: Boolean(row.estimated) });
  }
  for (const row of payload.catalysts || []) {
    events.push({ ...base(row), type: "catalyst", date: String(row.date || "").slice(0, 10), title: row.title || "", estimated: false });
  }
  return events
    .filter(event => /^\d{4}-\d{2}-\d{2}$/.test(event.date))
    .map(event => ({ ...event, past: event.date < today }))
    .sort(compareScheduleEvents);
}

function scheduleEventVisible(event) {
  return scheduleTypeVisible.has(event.type)
    && scheduleMarketVisible.has(event.market)
    && (scheduleKind === "all" || event.kind === scheduleKind)
    && (!scheduleHeldOnly || event.owned);
}

function visibleScheduleEvents() {
  const monthKey = scheduleMonthKey(scheduleMonth);
  return normalizedScheduleEvents().filter(event => event.date.startsWith(monthKey) && scheduleEventVisible(event));
}

function scheduleEventDetail(event) {
  if (event.type === "catalyst") return esc(event.title);
  if (event.type === "earnings") return event.past ? "발표" : "발표 예정";
  const amount = event.amount == null ? "금액 미정" : `주당 ${unitMoney(event.amount, event.currency, event.ticker)}`;
  if (event.type === "dividend_base") return `${event.baseKind === "ex" ? "배당락" : "기준일"} · ${amount}`;
  return `${event.past ? "지급" : "지급 예정"} · ${amount}`;
}

function scheduleRowMarkup(event) {
  const typeLabel = SCHEDULE_TYPES.find(type => type.key === event.type)?.label || "";
  const label = event.market === "kr" ? event.name : event.ticker;
  const title = `${typeLabel} · ${event.name} (${event.ticker})${event.estimated ? " · 예상일" : ""}`;
  return `<button class="schedule-row ${event.type.replace("_", "-")}${event.estimated ? " estimated" : ""}" type="button"
      data-chart-ticker="${esc(event.ticker)}" title="${esc(title)}">
    <span class="schedule-row-logo">${logoMarkup(event)}</span>
    <span class="schedule-row-name"><strong>${esc(event.name)}</strong>${label !== event.name ? `<small>${esc(label)}</small>` : ""}</span>
    <span class="schedule-row-type">${typeLabel}</span>
    <span class="schedule-row-detail">${scheduleEventDetail(event)}</span>
    ${event.owned ? '<span class="schedule-row-owned">보유</span>' : "<span></span>"}
  </button>`;
}

function renderScheduleList(events, today) {
  if (!events.length) return `<div class="schedule-empty">선택한 조건의 일정이 없습니다.</div>`;
  const grouped = new Map();
  for (const event of events) {
    if (!grouped.has(event.date)) grouped.set(event.date, []);
    grouped.get(event.date).push(event);
  }
  return `<div class="schedule-list">${[...grouped].map(([dateText, rows]) => {
    const date = localDateFromIso(dateText);
    const weekday = date?.getDay();
    const weekdayLabel = date?.toLocaleDateString("ko-KR", { weekday: "short" }) || "";
    const classes = ["schedule-day",
      dateText < today ? "past" : "",
      dateText === today ? "today" : "",
      weekday === 0 ? "sunday" : weekday === 6 ? "saturday" : ""].filter(Boolean).join(" ");
    return `<section class="${classes}" data-schedule-date="${dateText}">
      <div class="schedule-day-head"><strong>${Number(dateText.slice(8, 10))}</strong><span>${weekdayLabel}</span>${dateText === today ? "<em>오늘</em>" : ""}</div>
      <div class="schedule-day-rows">${rows.map(scheduleRowMarkup).join("")}</div>
    </section>`;
  }).join("")}</div>`;
}

function syncScheduleControls(events) {
  document.getElementById("scheduleMonthLabel").textContent = `${scheduleMonth.getFullYear()}년 ${scheduleMonth.getMonth() + 1}월`;
  document.getElementById("scheduleCount").textContent = `${events.length}건`;
  const press = (button, active) => {
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  };
  document.querySelectorAll("[data-schedule-type]").forEach(button => press(button, scheduleTypeVisible.has(button.dataset.scheduleType)));
  document.querySelectorAll("[data-schedule-market]").forEach(button => press(button, scheduleMarketVisible.has(button.dataset.scheduleMarket)));
  document.querySelectorAll("[data-schedule-kind]").forEach(button => press(button, button.dataset.scheduleKind === scheduleKind));
  document.querySelectorAll("[data-schedule-held]").forEach(button => press(button, scheduleHeldOnly));
  const minDate = localDateFromIso(schedulePayload?.start);
  const maxDate = localDateFromIso(schedulePayload?.end);
  const currentIndex = scheduleMonthIndex(scheduleMonth);
  document.getElementById("schedulePrev").disabled = Boolean(minDate && currentIndex <= scheduleMonthIndex(minDate));
  document.getElementById("scheduleNext").disabled = Boolean(maxDate && currentIndex >= scheduleMonthIndex(maxDate));
}

function renderSchedule({ scrollToToday = false } = {}) {
  const body = document.getElementById("scheduleBody");
  if (!body) return;
  if (!schedulePayload) {
    body.innerHTML = '<div class="schedule-loading"><span class="skeleton-bar"></span><span class="skeleton-bar"></span><span class="skeleton-bar"></span></div>';
    return;
  }
  const today = String(schedulePayload.today || todayLocal()).slice(0, 10);
  const events = visibleScheduleEvents();
  syncScheduleControls(events);
  body.innerHTML = renderScheduleList(events, today);
  body.scrollTop = 0;
  // 이번 달을 열면 오늘(없으면 다음 일정)로 스크롤 — 지난 날은 위로 올려 보면 된다
  if (scrollToToday) {
    const target = [...body.querySelectorAll("[data-schedule-date]")].find(section => section.dataset.scheduleDate >= today);
    if (target) body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top;
  }
}

function moveScheduleMonth(offset) {
  scheduleMonth = offset == null
    ? new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    : new Date(scheduleMonth.getFullYear(), scheduleMonth.getMonth() + offset, 1);
  renderSchedule({ scrollToToday: scheduleMonthKey(scheduleMonth) === scheduleMonthKey(new Date()) });
}

async function openScheduleModal() {
  const modal = document.getElementById("scheduleModal");
  if (!modal) return;
  scheduleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  schedulePayload = null;
  renderSchedule();
  modal.showModal();
  if (!scheduleLoadInFlight) scheduleLoadInFlight = apiFetchSchedule();
  try {
    schedulePayload = await scheduleLoadInFlight;
    renderSchedule({ scrollToToday: true });
  } catch (error) {
    const body = document.getElementById("scheduleBody");
    if (body) body.innerHTML = `<div class="schedule-empty error">${esc(error.message || "일정을 불러오지 못했습니다.")}</div>`;
  } finally {
    scheduleLoadInFlight = null;
  }
}

function toggleScheduleSetValue(set, value, storageKey) {
  if (set.has(value)) set.delete(value); else set.add(value);
  storageSet(storageKey, JSON.stringify([...set]));
  renderSchedule();
}

function initScheduleModal() {
  const modal = document.getElementById("scheduleModal");
  if (!modal) return;
  document.getElementById("scheduleOpen")?.addEventListener("click", openScheduleModal);
  document.getElementById("scheduleClose")?.addEventListener("click", () => modal.close());
  document.getElementById("schedulePrev")?.addEventListener("click", () => moveScheduleMonth(-1));
  document.getElementById("scheduleNext")?.addEventListener("click", () => moveScheduleMonth(1));
  document.getElementById("scheduleToday")?.addEventListener("click", () => moveScheduleMonth(null));
  document.querySelectorAll("[data-schedule-type]").forEach(button => button.addEventListener("click", () =>
    toggleScheduleSetValue(scheduleTypeVisible, button.dataset.scheduleType, scheduleStorage.types)));
  document.querySelectorAll("[data-schedule-market]").forEach(button => button.addEventListener("click", () =>
    toggleScheduleSetValue(scheduleMarketVisible, button.dataset.scheduleMarket, scheduleStorage.markets)));
  document.querySelectorAll("[data-schedule-kind]").forEach(button => button.addEventListener("click", () => {
    scheduleKind = button.dataset.scheduleKind;
    storageSet(scheduleStorage.kind, scheduleKind);
    renderSchedule();
  }));
  document.querySelectorAll("[data-schedule-held]").forEach(button => button.addEventListener("click", () => {
    scheduleHeldOnly = !scheduleHeldOnly;
    storageSet(scheduleStorage.heldOnly, scheduleHeldOnly ? "1" : "0");
    renderSchedule();
  }));
  document.getElementById("scheduleBody")?.addEventListener("click", event => {
    const ticker = event.target.closest?.("[data-chart-ticker]")?.dataset.chartTicker;
    if (!ticker) return;
    modal.close();
    history.pushState(null, "", chartHref(ticker));
    openChart(ticker);
  });
  modal.addEventListener("click", event => {
    if (event.target === modal) modal.close();
  });
}

(window.__loaded = window.__loaded || new Set()).add("app-calendar");

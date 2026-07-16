const scheduleStorage = {
  view: "portfolio.schedule.view",
  heldOnly: "portfolio.schedule.heldOnly",
};

let schedulePayload = null;
let scheduleLoadInFlight = null;
let scheduleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let scheduleView = storageGet(scheduleStorage.view) === "list" ? "list" : "grid";
let scheduleHeldOnly = storageGet(scheduleStorage.heldOnly) === "1";
let scheduleFocusDate = "";

function scheduleDateKey(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "";
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function scheduleMonthIndex(value) {
  return value.getFullYear() * 12 + value.getMonth();
}

function scheduleTickerLabel(event) {
  return /\.(KS|KQ)$/i.test(event.ticker || "") ? event.name : event.ticker;
}

function normalizedScheduleEvents() {
  if (!schedulePayload) return [];
  const earnings = (schedulePayload.earnings || []).flatMap(row => {
    const display = earningsDisplayDate(row.earnings_date);
    if (!display) return [];
    return [{
      type: "earnings",
      date: scheduleDateKey(display.date),
      ticker: row.ticker,
      name: row.name,
      owned: Boolean(row.owned),
      estimated: Boolean(display.estimated),
      logo: row.logo,
      sourceDate: row.earnings_date,
    }];
  });
  const dividends = (schedulePayload.dividends || []).map(row => ({
    type: "dividend",
    date: String(row.date || "").slice(0, 10),
    ticker: row.ticker,
    name: row.name,
    owned: Boolean(row.owned),
    estimated: Boolean(row.estimated),
    logo: row.logo,
    amount: row.amount,
    currency: row.currency,
  }));
  return [...earnings, ...dividends]
    .filter(event => /^\d{4}-\d{2}-\d{2}$/.test(event.date))
    .sort((a, b) => a.date.localeCompare(b.date)
      || a.type.localeCompare(b.type)
      || a.ticker.localeCompare(b.ticker));
}

function visibleScheduleEvents() {
  const monthKey = `${scheduleMonth.getFullYear()}-${String(scheduleMonth.getMonth() + 1).padStart(2, "0")}`;
  return normalizedScheduleEvents().filter(event => (
    event.date.startsWith(monthKey) && (!scheduleHeldOnly || event.owned)
  ));
}

function scheduleEventButton(event) {
  const label = scheduleTickerLabel(event);
  const typeLabel = event.type === "earnings" ? "실적발표" : "배당지급";
  const title = `${typeLabel} · ${event.name} (${event.ticker})${event.estimated ? " · 예상일" : ""}`;
  return `
    <button class="schedule-event ${event.type}${event.estimated ? " estimated" : ""}${event.owned ? " owned" : ""}"
      type="button" data-chart-ticker="${esc(event.ticker)}" title="${esc(title)}">
      <i aria-hidden="true"></i><span>${esc(label)}</span>
    </button>`;
}

function renderScheduleGrid(events) {
  const year = scheduleMonth.getFullYear();
  const month = scheduleMonth.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((first.getDay() + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - first.getDay());
  const eventsByDate = new Map();
  events.forEach(event => {
    const rows = eventsByDate.get(event.date) || [];
    rows.push(event);
    eventsByDate.set(event.date, rows);
  });
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"]
    .map((day, index) => `<div class="schedule-weekday${index === 0 ? " sunday" : index === 6 ? " saturday" : ""}">${day}</div>`)
    .join("");
  const today = schedulePayload?.today || todayLocal();
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = scheduleDateKey(date);
    const dayEvents = eventsByDate.get(key) || [];
    const visible = dayEvents.slice(0, 4).map(scheduleEventButton).join("");
    const more = dayEvents.length > 4
      ? `<button class="schedule-more" type="button" data-schedule-list-date="${key}">+${dayEvents.length - 4}개</button>`
      : "";
    const classes = [
      "schedule-day",
      date.getMonth() !== month ? "outside" : "",
      key === today ? "today" : "",
      date.getDay() === 0 ? "sunday" : "",
      date.getDay() === 6 ? "saturday" : "",
    ].filter(Boolean).join(" ");
    return `
      <div class="${classes}" data-schedule-date="${key}">
        <span class="schedule-day-number">${date.getDate()}</span>
        <div class="schedule-day-events">${visible}${more}</div>
      </div>`;
  }).join("");
  return `<div class="schedule-calendar"><div class="schedule-weekdays">${weekdays}</div><div class="schedule-days">${cells}</div></div>`;
}

function scheduleEventDetail(event) {
  if (event.type === "earnings") {
    return `<span class="schedule-list-note${event.estimated ? " estimated" : ""}">${event.estimated ? "예상 발표일" : "발표 예정"}</span>`;
  }
  const amount = event.amount == null ? "금액 미정" : `주당 ${unitMoney(event.amount, event.currency, event.ticker)}`;
  return `<span class="schedule-list-note${event.estimated ? " estimated" : ""}">${event.estimated ? "예상 지급일" : "지급 예정"} · ${amount}</span>`;
}

function renderScheduleList(events) {
  if (!events.length) {
    return `<div class="schedule-empty">선택한 조건의 일정이 없습니다.</div>`;
  }
  const grouped = new Map();
  events.forEach(event => {
    const rows = grouped.get(event.date) || [];
    rows.push(event);
    grouped.set(event.date, rows);
  });
  const groups = Array.from(grouped.entries()).map(([dateText, rows]) => {
    const date = localDateFromIso(dateText);
    const weekday = date?.toLocaleDateString("ko-KR", { weekday: "short" }) || "";
    const items = rows.map(event => `
      <button class="schedule-list-row ${event.type}${event.estimated ? " estimated" : ""}"
        type="button" data-chart-ticker="${esc(event.ticker)}">
        <span class="schedule-list-logo">${logoMarkup(event)}</span>
        <span class="schedule-type-badge ${event.type}">${event.type === "earnings" ? "실적" : "배당"}</span>
        <span class="schedule-list-identity">
          <strong>${esc(event.name)}</strong><small>${esc(event.ticker)}</small>
        </span>
        ${scheduleEventDetail(event)}
        ${event.owned ? '<span class="schedule-owned-badge">보유</span>' : ""}
      </button>`).join("");
    return `
      <section class="schedule-list-group" id="schedule-date-${dateText}">
        <div class="schedule-list-date"><strong>${dateText.slice(8, 10)}</strong><span>${weekday}</span></div>
        <div class="schedule-list-items">${items}</div>
      </section>`;
  }).join("");
  return `<div class="schedule-list">${groups}</div>`;
}

function syncScheduleControls(events) {
  const monthLabel = document.getElementById("scheduleMonthLabel");
  const count = document.getElementById("scheduleCount");
  if (monthLabel) monthLabel.textContent = `${scheduleMonth.getFullYear()}년 ${scheduleMonth.getMonth() + 1}월`;
  if (count) count.textContent = `${events.length}건`;
  document.querySelectorAll("[data-schedule-view]").forEach(button => {
    const active = button.dataset.scheduleView === scheduleView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll("[data-schedule-held]").forEach(button => {
    const active = (button.dataset.scheduleHeld === "1") === scheduleHeldOnly;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const minDate = localDateFromIso(schedulePayload?.start);
  const maxDate = localDateFromIso(schedulePayload?.end);
  const currentIndex = scheduleMonthIndex(scheduleMonth);
  document.getElementById("schedulePrev").disabled = Boolean(minDate && currentIndex <= scheduleMonthIndex(minDate));
  document.getElementById("scheduleNext").disabled = Boolean(maxDate && currentIndex >= scheduleMonthIndex(maxDate));
}

function renderSchedule() {
  const body = document.getElementById("scheduleBody");
  if (!body) return;
  if (!schedulePayload) {
    body.innerHTML = '<div class="schedule-loading"><span class="skeleton-bar"></span><span class="skeleton-bar"></span><span class="skeleton-bar"></span></div>';
    return;
  }
  const events = visibleScheduleEvents();
  syncScheduleControls(events);
  body.innerHTML = scheduleView === "list" ? renderScheduleList(events) : renderScheduleGrid(events);
  if (scheduleView === "list" && scheduleFocusDate) {
    const target = document.getElementById(`schedule-date-${scheduleFocusDate}`);
    requestAnimationFrame(() => target?.scrollIntoView({ block: "start" }));
    scheduleFocusDate = "";
  }
}

async function openScheduleModal() {
  const modal = document.getElementById("scheduleModal");
  if (!modal) return;
  scheduleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  scheduleFocusDate = "";
  schedulePayload = null;
  renderSchedule();
  modal.showModal();
  if (!scheduleLoadInFlight) scheduleLoadInFlight = apiFetchSchedule();
  try {
    schedulePayload = await scheduleLoadInFlight;
    renderSchedule();
  } catch (error) {
    const body = document.getElementById("scheduleBody");
    if (body) body.innerHTML = `<div class="schedule-empty error">${esc(error.message || "일정을 불러오지 못했습니다.")}</div>`;
  } finally {
    scheduleLoadInFlight = null;
  }
}

function initScheduleModal() {
  const modal = document.getElementById("scheduleModal");
  if (!modal) return;
  document.getElementById("scheduleOpen")?.addEventListener("click", openScheduleModal);
  document.getElementById("scheduleClose")?.addEventListener("click", () => modal.close());
  document.getElementById("schedulePrev")?.addEventListener("click", () => {
    scheduleMonth = new Date(scheduleMonth.getFullYear(), scheduleMonth.getMonth() - 1, 1);
    scheduleFocusDate = "";
    renderSchedule();
  });
  document.getElementById("scheduleNext")?.addEventListener("click", () => {
    scheduleMonth = new Date(scheduleMonth.getFullYear(), scheduleMonth.getMonth() + 1, 1);
    scheduleFocusDate = "";
    renderSchedule();
  });
  document.getElementById("scheduleToday")?.addEventListener("click", () => {
    scheduleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    scheduleFocusDate = "";
    renderSchedule();
  });
  document.querySelectorAll("[data-schedule-view]").forEach(button => {
    button.addEventListener("click", () => {
      scheduleView = button.dataset.scheduleView === "list" ? "list" : "grid";
      storageSet(scheduleStorage.view, scheduleView);
      scheduleFocusDate = "";
      renderSchedule();
    });
  });
  document.querySelectorAll("[data-schedule-held]").forEach(button => {
    button.addEventListener("click", () => {
      scheduleHeldOnly = button.dataset.scheduleHeld === "1";
      storageSet(scheduleStorage.heldOnly, scheduleHeldOnly ? "1" : "0");
      scheduleFocusDate = "";
      renderSchedule();
    });
  });
  document.getElementById("scheduleBody")?.addEventListener("click", event => {
    const more = event.target.closest?.("[data-schedule-list-date]");
    if (more) {
      scheduleView = "list";
      scheduleFocusDate = more.dataset.scheduleListDate || "";
      storageSet(scheduleStorage.view, scheduleView);
      renderSchedule();
      return;
    }
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

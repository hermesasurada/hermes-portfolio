// 관심목록 스크리닝 — 표의 수치 열에 '이상/이하' 조건을 최대 5개까지 AND로 건다(2026-10-07 사용자 지시).
// 조건은 그룹과 무관하게 관심목록 전체에 적용하고, 이 브라우저에 저장한다(detailStorage.interestScreen).
// 값이 없는 종목은 그 조건을 통과하지 못한다(배당율만 예외 — 무배당 = 0%).
const INTEREST_SCREEN_MAX = 5;
// 표가 소수(0.25 = 25%)로 들고 있는 값 — 입력은 표에 보이는 % 단위로 받고 비교 때 1/100로 바꾼다.
const INTEREST_SCREEN_FRACTION_KEYS = new Set([
  "gross_margin", "operating_margin", "ebitda_margin", "profit_margin", "return_on_assets", "return_on_equity",
  "revenue_growth", "earnings_growth", "earnings_quarterly_growth", "payout_ratio",
  "short_percent_float", "short_percent_shares", "insider_ownership", "institutional_ownership",
]);
const INTEREST_SCREEN_PERCENT_KEYS = new Set([
  "display_change_pct", "extended_change_pct", "dividend_yield", "dividend_growth_5y", "drawdown_52w",
  "ma20_pct", "ma50_pct", "ma200_pct", "perf_1w", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y",
  "perf_3y", "perf_5y", "perf_10y", "debt_to_equity", "upside_pct", "dispersion_pct",
]);
// 통화가 종목마다 달라 한 기준으로 비교할 수 없거나 수치가 아닌 열
const INTEREST_SCREEN_EXCLUDED = new Set([
  "logo", "name", "delete", "trade_timing", "rating_rank", "next_earnings_date",
  "current_price", "target_price", "free_cash_flow",
]);
const INTEREST_SCREEN_LABELS = {
  display_change_pct: "등락", extended_change_pct: "연장 등락", market_cap_usd: "시총/AUM",
  perf_1w: "수익률 1주", perf_1m: "수익률 1개월", perf_3m: "수익률 3개월", perf_6m: "수익률 6개월",
  perf_ytd: "수익률 YTD", perf_1y: "수익률 1년", perf_3y: "수익률 3년(연)", perf_5y: "수익률 5년(연)",
  perf_10y: "수익률 10년(연)",
};
const INTEREST_SCREEN_OPS = { gte: "이상", lte: "이하" };

let interestScreenConditions = [];   // [{key, op, value}] — 적용 중인 조건
let interestScreenDraft = [];        // 팝업에서 편집 중인 조건
let interestPreScreenRows = [];      // 스크리닝 직전 행(팝업의 '일치 종목 수' 미리보기용)
let interestScreenStatsPending = false;   // 지표(RSI·수익률 등)를 아직 불러오는 중

function interestScreenFields() {
  return INTEREST_COLUMNS
    .filter(column => column.numeric && !INTEREST_SCREEN_EXCLUDED.has(column.key))
    .map(column => ({
      key: column.key,
      label: INTEREST_SCREEN_LABELS[column.key]
        || String(column.label).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      group: column.group ? INTEREST_COLUMN_GROUPS[column.group] : "기본",
      unit: column.key === "market_cap_usd" ? "B$"
        : INTEREST_SCREEN_PERCENT_KEYS.has(column.key) || INTEREST_SCREEN_FRACTION_KEYS.has(column.key) ? "%" : "",
    }));
}

function interestScreenField(key) {
  return interestScreenFields().find(field => field.key === key) || null;
}

// 입력값(표에 보이는 단위) → 행 값과 같은 단위
function interestScreenThreshold(condition) {
  const value = Number(condition.value);
  if (INTEREST_SCREEN_FRACTION_KEYS.has(condition.key)) return value / 100;
  if (condition.key === "market_cap_usd") return value * 1e9;
  return value;
}

function interestScreenRowValue(row, key) {
  const raw = row?.[key];
  if (key === "dividend_yield" && (raw == null || raw === "")) return 0;
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function validInterestScreenCondition(condition) {
  return Boolean(condition && interestScreenField(condition.key) && INTEREST_SCREEN_OPS[condition.op]
    && condition.value !== "" && condition.value != null && Number.isFinite(Number(condition.value)));
}

function passesInterestScreen(row, conditions = interestScreenConditions) {
  return conditions.every(condition => {
    const value = interestScreenRowValue(row, condition.key);
    if (value == null) return false;
    const threshold = interestScreenThreshold(condition);
    return condition.op === "gte" ? value >= threshold : value <= threshold;
  });
}

function applyInterestScreen(rows) {
  interestPreScreenRows = rows;
  return interestScreenConditions.length ? rows.filter(row => passesInterestScreen(row)) : rows;
}

function loadInterestScreen() {
  let saved = [];
  try {
    saved = JSON.parse(storageGet(detailStorage.interestScreen) || "[]");
  } catch (_err) {
    saved = [];
  }
  interestScreenConditions = (Array.isArray(saved) ? saved : [])
    .filter(validInterestScreenCondition)
    .slice(0, INTEREST_SCREEN_MAX)
    .map(({ key, op, value }) => ({ key, op, value: Number(value) }));
}

function saveInterestScreen(conditions) {
  interestScreenConditions = conditions.filter(validInterestScreenCondition)
    .slice(0, INTEREST_SCREEN_MAX)
    .map(({ key, op, value }) => ({ key, op, value: Number(value) }));
  storageSet(detailStorage.interestScreen, JSON.stringify(interestScreenConditions));
  syncInterestScreenButton();
}

function interestScreenSummary(conditions = interestScreenConditions) {
  return conditions.map(condition => {
    const field = interestScreenField(condition.key);
    return `${field?.label || condition.key} ${condition.value}${field?.unit || ""} ${INTEREST_SCREEN_OPS[condition.op]}`;
  }).join(" · ");
}

function syncInterestScreenButton() {
  const button = document.getElementById("interestScreenButton");
  if (!button) return;
  const count = interestScreenConditions.length;
  button.textContent = count ? `스크리닝 ${count}` : "스크리닝";
  button.classList.toggle("active", count > 0);
  button.title = count ? `스크리닝 적용 중 — ${interestScreenSummary()}` : "항목별 조건으로 종목 거르기(최대 5개, 모두 만족)";
  button.setAttribute("aria-label", count ? `스크리닝 조건 ${count}개 적용 중` : "스크리닝");
}

function interestScreenFieldOptions(selected) {
  const groups = new Map();
  interestScreenFields().forEach(field => {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  });
  return [...groups].map(([group, fields]) => `<optgroup label="${esc(group)}">${fields.map(field =>
    `<option value="${esc(field.key)}"${field.key === selected ? " selected" : ""}>${esc(field.label)}</option>`
  ).join("")}</optgroup>`).join("");
}

function renderInterestScreenRows() {
  const host = document.getElementById("interestScreenRows");
  if (!host) return;
  host.innerHTML = interestScreenDraft.length
    ? interestScreenDraft.map((condition, index) => {
      const field = interestScreenField(condition.key);
      return `<div class="screen-row" data-screen-index="${index}">
        <select class="screen-field" aria-label="조건 ${index + 1} 항목">${interestScreenFieldOptions(condition.key)}</select>
        <span class="screen-value-wrap">
          <input class="screen-value" type="number" step="any" inputmode="decimal" value="${esc(condition.value ?? "")}" aria-label="조건 ${index + 1} 값" placeholder="값">
          <span class="screen-unit">${esc(field?.unit || "")}</span>
        </span>
        <select class="screen-op" aria-label="조건 ${index + 1} 비교">${Object.entries(INTEREST_SCREEN_OPS).map(([op, label]) =>
          `<option value="${op}"${op === condition.op ? " selected" : ""}>${label}</option>`).join("")}</select>
        <button class="ghost-btn screen-remove" type="button" data-screen-remove="${index}" aria-label="조건 ${index + 1} 삭제">×</button>
      </div>`;
    }).join("")
    : `<div class="screen-empty">조건이 없습니다. '조건 추가'로 항목을 고르세요.</div>`;
  const add = document.getElementById("interestScreenAdd");
  if (add) add.disabled = interestScreenDraft.length >= INTEREST_SCREEN_MAX;
  syncInterestScreenPreview();
}

function syncInterestScreenPreview() {
  const status = document.getElementById("interestScreenStatus");
  if (!status) return;
  const valid = interestScreenDraft.filter(validInterestScreenCondition);
  const total = interestPreScreenRows.length;
  const matched = valid.length ? interestPreScreenRows.filter(row => passesInterestScreen(row, valid)).length : total;
  const incomplete = interestScreenDraft.length - valid.length;
  status.textContent = `현재 그룹 ${total}종목 중 ${matched}종목 일치`
    + (incomplete ? ` · 값이 비어 있는 조건 ${incomplete}개는 빼고 셈` : "")
    + (interestScreenStatsPending ? " · 지표를 불러오는 중이라 늘어날 수 있음" : "");
}

function openInterestScreenModal() {
  interestScreenDraft = interestScreenConditions.map(condition => ({ ...condition }));
  if (!interestScreenDraft.length) interestScreenDraft.push({ key: "rsi_day", op: "lte", value: "" });
  renderInterestScreenRows();
  document.getElementById("interestScreenModal")?.showModal();
}

function closeInterestScreenModal() {
  document.getElementById("interestScreenModal")?.close();
}

function initInterestScreen() {
  loadInterestScreen();
  syncInterestScreenButton();
  document.getElementById("interestScreenButton")?.addEventListener("click", openInterestScreenModal);
  document.getElementById("interestScreenClose")?.addEventListener("click", closeInterestScreenModal);
  document.getElementById("interestScreenCancel")?.addEventListener("click", closeInterestScreenModal);
  document.getElementById("interestScreenAdd")?.addEventListener("click", () => {
    if (interestScreenDraft.length >= INTEREST_SCREEN_MAX) return;
    interestScreenDraft.push({ key: "perf_1y", op: "gte", value: "" });
    renderInterestScreenRows();
    document.querySelector("#interestScreenRows .screen-row:last-child .screen-field")?.focus();
  });
  document.getElementById("interestScreenReset")?.addEventListener("click", () => {
    interestScreenDraft = [];
    saveInterestScreen([]);
    closeInterestScreenModal();
    render();
  });
  document.getElementById("interestScreenApply")?.addEventListener("click", () => {
    saveInterestScreen(interestScreenDraft);
    closeInterestScreenModal();
    render();
  });
  const host = document.getElementById("interestScreenRows");
  host?.addEventListener("click", event => {
    const remove = event.target.closest("[data-screen-remove]");
    if (!remove) return;
    interestScreenDraft.splice(Number(remove.dataset.screenRemove), 1);
    renderInterestScreenRows();
  });
  const update = event => {
    const row = event.target.closest(".screen-row");
    if (!row) return;
    const condition = interestScreenDraft[Number(row.dataset.screenIndex)];
    if (!condition) return;
    if (event.target.classList.contains("screen-field")) {
      condition.key = event.target.value;
      row.querySelector(".screen-unit").textContent = interestScreenField(condition.key)?.unit || "";
    } else if (event.target.classList.contains("screen-op")) {
      condition.op = event.target.value;
    } else if (event.target.classList.contains("screen-value")) {
      condition.value = event.target.value;
    }
    syncInterestScreenPreview();
  };
  host?.addEventListener("input", update);
  host?.addEventListener("change", update);
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-interest-screen");

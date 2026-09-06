// 단일 종목 가격차트 + 통계 패널 + 기간/모달 컨트롤. (공용=app-chart-scale.js, 비교=app-chart-compare.js)
let chartNameSaveInFlight = false;
function chartPayloadExtent(payloads, common = false) {
  const items = (Array.isArray(payloads) ? payloads : [payloads]).filter(Boolean);
  const extents = items.map(item => {
    const pts = aggregateChartPoints(item.points || [])
      .filter(point => point.date && Number.isFinite(Number(point.close)) && Number(point.close) > 0)
      .map(point => new Date(`${point.date}T00:00:00`).getTime())
      .filter(time => Number.isFinite(time))
      .sort((a, b) => a - b);
    const historyStart = new Date(`${item.history_start || ""}T00:00:00`).getTime();
    const historyEnd = new Date(`${item.history_end || ""}T00:00:00`).getTime();
    const start = Number.isFinite(historyStart) ? historyStart : pts[0];
    const end = Number.isFinite(historyEnd) ? historyEnd : pts[pts.length - 1];
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
  }).filter(Boolean);
  if (!extents.length) return null;
  const start = common ? Math.max(...extents.map(item => item.start)) : Math.min(...extents.map(item => item.start));
  const end = common ? Math.min(...extents.map(item => item.end)) : Math.max(...extents.map(item => item.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    start,
    end,
    startDate: new Date(start),
    endDate: new Date(end),
    months: (end - start) / (1000 * 60 * 60 * 24 * 30.44),
  };
}

function chartRangeUnavailable(range, extent) {
  if (!range || !extent || range.all || range.key === "cmax" || range.key === "custom") return false;
  if (range.months) return range.months > extent.months + 0.5;
  if (range.ytd) {
    const yearStart = new Date(extent.endDate.getFullYear(), 0, 1).getTime();
    return extent.start > yearStart;
  }
  return false;
}

function currentChartRangeExtent() {
  const isCompare = chartComparePayloads.length > 0;
  return chartPayloadExtent(
    isCompare ? [chartPayload, ...chartComparePayloads] : [chartPayload],
    isCompare
  );
}

function normalizeChartRangeForPayloads(payloads, common = false, fallback = "all") {
  const range = chartRanges.find(item => item.key === chartRange);
  const extent = chartPayloadExtent(payloads, common);
  if (chartRange !== "custom" && chartRangeUnavailable(range, extent)) {
    chartRange = fallback;
  }
}

function availableChartRangeChoices() {
  const isCompare = chartComparePayloads.length > 0;
  const ranges = isCompare ? chartRanges.filter(range => range.key !== "all") : chartRanges;
  const extent = currentChartRangeExtent();
  return [
    ...ranges.map(range => ({
      ...range,
      disabled: chartRangeUnavailable(range, extent),
    })),
    ...(isCompare ? [{ key: "cmax", label: "최대", disabled: false }] : []),
  ];
}

function renderChartRangeButtons() {
  const isCompare = chartComparePayloads.length > 0;
  const choices = availableChartRangeChoices();
  const currentChoice = choices.find(range => range.key === chartRange);
  const rangeLabel = chartRange === "custom" ? "직접" : (currentChoice?.label || "전체");
  return `
    <div class="chart-ranges" role="group" aria-label="차트 기간">
      <button class="chart-range-btn range-popup-btn active" type="button" data-chart-range-popup aria-haspopup="dialog" aria-label="현재 조회 기간 ${rangeLabel}, 기간 선택">${rangeLabel}</button>
      ${(!isCompare && !performanceChartOpen) ? `
        <span class="chart-marker-toggles" role="group" aria-label="거래 마커 표시">
          <button class="chart-range-btn marker-toggle buy ${chartShowBuys ? "active" : ""}" type="button" data-marker-toggle="buy" aria-label="매수 마커" title="매수 마커" aria-pressed="${chartShowBuys}" ${chartInterval === "day" ? "" : `disabled title="일 단위에서만 표시"`}><i></i>B</button>
          <button class="chart-range-btn marker-toggle sell ${chartShowSells ? "active" : ""}" type="button" data-marker-toggle="sell" aria-label="매도 마커" title="매도 마커" aria-pressed="${chartShowSells}" ${chartInterval === "day" ? "" : `disabled title="일 단위에서만 표시"`}><i></i>S</button>
        </span>
      ` : ""}
    </div>
  `;
}

function renderChartRangeControls() {
  const host = document.getElementById("chartRangeHost");
  if (!host) return;
  host.innerHTML = renderChartRangeButtons();
  requestAnimationFrame(syncChartOverlayPosition);
}

function syncChartOverlayPosition() {
  // Desktop and mobile both use a normal-flow control row above the plot.
  const control = document.getElementById("chartBottomControls");
  if (!control) return;
  control.style.top = "";
  control.style.right = "";
}

function syncChartBottomControls(visible = Boolean(chartTicker || performanceChartOpen)) {
  const control = document.getElementById("chartBottomControls");
  if (!control) return;
  control.classList.toggle("hidden", !visible);
}

function syncChartIntervalControl() {
  const toggle = document.getElementById("chartIntervalToggle");
  if (!toggle) return;
  const order = ["day", "week", "month"];
  const labels = { day: "일", week: "주", month: "월" };
  const next = order[(order.indexOf(chartInterval) + 1) % order.length];
  toggle.classList.toggle("hidden", !chartTicker || performanceChartOpen);
  toggle.textContent = labels[chartInterval] || "일";
  toggle.setAttribute("aria-pressed", "true");
  toggle.setAttribute("aria-label", `현재 ${labels[chartInterval] || "일"} 단위, 클릭하면 ${labels[next]}`);
  toggle.title = `차트 단위: ${labels[chartInterval] || "일"} → ${labels[next]}`;
}

function initChartIntervalControl() {
  const toggle = document.getElementById("chartIntervalToggle");
  if (!toggle) return;
  syncChartIntervalControl();
  toggle.addEventListener("click", () => {
    const order = ["day", "week", "month"];
    chartInterval = order[(order.indexOf(chartInterval) + 1) % order.length];
    storageSet(detailStorage.chartInterval, chartInterval);
    syncChartIntervalControl();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
}

const CHART_MOVING_AVERAGES = [
  { key: "sma_20", period: 20, label: "단기 20일", color: "var(--chart-ma-short)" },
  { key: "sma_50", period: 50, label: "중기 50일", color: "var(--chart-ma-medium)" },
  { key: "sma_200", period: 200, label: "장기 200일", color: "var(--chart-ma-long)" },
];

// 성과차트에도 '부드럽게'만 남겨 노출한다(선 종류·log·BB·MA·일목은 종목차트 전용).
function syncChartDisplayControls(visible = Boolean(chartTicker || performanceChartOpen)) {
  const control = document.getElementById("chartDisplayControls");
  if (!control) return;
  control.classList.toggle("hidden", !visible);
  const smoothToggle = document.getElementById("chartSmoothToggle");
  const logToggle = document.getElementById("chartLogToggle");
  const bollingerToggle = document.getElementById("chartBollingerToggle");
  const ichimokuToggle = document.getElementById("chartIchimokuToggle");
  const typeToggle = document.getElementById("chartTypeToggle");
  const nextTypeLabel = chartType === "line" ? "캔들" : "선";
  if (typeToggle) {
    typeToggle.textContent = chartType === "line" ? "선" : "캔들";
    typeToggle.setAttribute("aria-pressed", "true");
    typeToggle.setAttribute("aria-label", `현재 ${chartType === "line" ? "선" : "캔들"} 차트, 클릭하면 ${nextTypeLabel}`);
    typeToggle.title = `차트 종류: ${chartType === "line" ? "선" : "캔들"} → ${nextTypeLabel}`;
  }
  smoothToggle?.classList.toggle("active", chartSmoothLines);
  smoothToggle?.setAttribute("aria-pressed", String(chartSmoothLines));
  smoothToggle?.classList.toggle("hidden", chartType === "candle" && !performanceChartOpen);
  typeToggle?.classList.toggle("hidden", performanceChartOpen);
  logToggle?.classList.toggle("active", chartLogScale);
  logToggle?.setAttribute("aria-pressed", String(chartLogScale));
  logToggle?.classList.toggle("hidden", performanceChartOpen);
  bollingerToggle?.classList.toggle("active", chartShowBollinger);
  bollingerToggle?.setAttribute("aria-pressed", String(chartShowBollinger));
  ichimokuToggle?.classList.toggle("active", chartShowIchimoku);
  ichimokuToggle?.setAttribute("aria-pressed", String(chartShowIchimoku));
  bollingerToggle?.classList.toggle("hidden", chartComparePayloads.length > 0 || performanceChartOpen);
  ichimokuToggle?.classList.toggle("hidden", chartComparePayloads.length > 0 || performanceChartOpen);
  const maToggle = document.getElementById("chartMovingAverageToggle");
  maToggle?.classList.toggle("active", chartShowMovingAverages);
  maToggle?.setAttribute("aria-pressed", String(chartShowMovingAverages));
  maToggle?.classList.toggle("hidden", chartComparePayloads.length > 0 || performanceChartOpen);
  document.getElementById("chartMaLegend")?.classList.toggle("hidden",
    !visible || !chartShowMovingAverages || chartComparePayloads.length > 0 || performanceChartOpen);
}

function initChartDisplayControls() {
  document.getElementById("chartMovingAverageToggle")?.addEventListener("click", () => {
    chartShowMovingAverages = !chartShowMovingAverages;
    storageSet(detailStorage.chartShowMovingAverages, String(chartShowMovingAverages));
    syncChartDisplayControls();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
  const smoothToggle = document.getElementById("chartSmoothToggle");
  const logToggle = document.getElementById("chartLogToggle");
  const bollingerToggle = document.getElementById("chartBollingerToggle");
  const ichimokuToggle = document.getElementById("chartIchimokuToggle");
  document.getElementById("chartTypeToggle")?.addEventListener("click", () => {
    chartType = chartType === "line" ? "candle" : "line";
    storageSet(detailStorage.chartType, chartType);
    syncChartDisplayControls();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
  smoothToggle?.addEventListener("click", () => {
    chartSmoothLines = !chartSmoothLines;
    storageSet(detailStorage.chartSmoothLines, String(chartSmoothLines));
    syncChartDisplayControls();
    if (performanceChartOpen && performancePayload) renderPerformanceChart(performancePayload);
    else if (chartPayload) renderLineChart(chartPayload);
  });
  logToggle?.addEventListener("click", () => {
    chartLogScale = !chartLogScale;
    storageSet(detailStorage.chartLogScale, String(chartLogScale));
    syncChartDisplayControls();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
  bollingerToggle?.addEventListener("click", () => {
    chartShowBollinger = !chartShowBollinger;
    storageSet(detailStorage.chartShowBollinger, String(chartShowBollinger));
    syncChartDisplayControls();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
  ichimokuToggle?.addEventListener("click", () => {
    chartShowIchimoku = !chartShowIchimoku;
    storageSet(detailStorage.chartShowIchimoku, String(chartShowIchimoku));
    syncChartDisplayControls();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
  window.addEventListener("resize", () => requestAnimationFrame(syncChartOverlayPosition));
  syncChartDisplayControls();
}

function syncChartLogToggle(visible) {
  syncChartDisplayControls(visible);
}

function chartPointDatesForModal() {
  const rawPoints = performanceChartOpen
    ? (performancePayload?.points || []).map(point => ({ date: point.date, close: Number(point.value) }))
    : (chartPayload?.points || []).map(point => ({ date: point.date, close: Number(point.close) }));
  const points = rawPoints.filter(point => point.date && Number.isFinite(point.close));
  if (!points.length) return { start: "", end: "" };
  const visible = chartRange === "custom"
    ? points
    : filterChartPoints(points, chartRange);
  const selected = visible.length >= 2 ? visible : points;
  return {
    start: selected[0]?.date || "",
    end: selected[selected.length - 1]?.date || "",
  };
}

function setChartRangeStatus(message, error = false) {
  const el = document.getElementById("chartRangeStatus");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", error);
}

function renderChartRangeModalPresets() {
  const host = document.getElementById("chartRangePresets");
  if (!host) return;
  host.innerHTML = availableChartRangeChoices().map(range => `
    <button
      class="chart-range-preset ${chartRange === range.key ? "active" : ""}"
      type="button"
      data-chart-range-choice="${range.key}"
      aria-pressed="${chartRange === range.key}"
      ${range.disabled ? "disabled" : ""}
    >${range.label}</button>
  `).join("");
}

function openChartRangeModal() {
  const modal = document.getElementById("chartRangeModal");
  const startInput = document.getElementById("chartRangeStart");
  const endInput = document.getElementById("chartRangeEnd");
  const defaults = chartPointDatesForModal();
  startInput.value = chartCustomRange.start || defaults.start;
  endInput.value = chartCustomRange.end || defaults.end;
  renderChartRangeModalPresets();
  setChartRangeStatus("");
  modal.showModal();
  requestAnimationFrame(() => {
    modal.querySelector(".chart-range-preset.active:not(:disabled), .chart-range-preset:not(:disabled)")?.focus();
  });
}

function applyChartPresetRange(rangeKey) {
  const choice = availableChartRangeChoices().find(range => range.key === rangeKey);
  if (!choice || choice.disabled) return;
  chartRange = choice.key;
  document.getElementById("chartRangeModal").close();
  if (performanceChartOpen) reloadPerformanceChart();
  else if (chartPayload) reloadPriceChartForMarketMode({ skeleton: true });
}

function applyChartCustomRange() {
  const modal = document.getElementById("chartRangeModal");
  const start = document.getElementById("chartRangeStart").value;
  const end = document.getElementById("chartRangeEnd").value;
  const startDate = chartDateObject(start);
  const endDate = chartDateObject(end);
  if (!startDate || !endDate) {
    setChartRangeStatus("시작일과 종료일을 모두 입력하세요.", true);
    return;
  }
  if (startDate > endDate) {
    setChartRangeStatus("시작일은 종료일보다 늦을 수 없습니다.", true);
    return;
  }
  chartCustomRange = { start, end };
  chartRange = "custom";
  modal.close();
  if (performanceChartOpen) reloadPerformanceChart();
  else if (chartPayload) reloadPriceChartForMarketMode({ skeleton: true });
}

function initChartRangeModal() {
  document.getElementById("chartRangeClose").addEventListener("click", () => {
    document.getElementById("chartRangeModal").close();
  });
  document.getElementById("chartRangeApply").addEventListener("click", applyChartCustomRange);
  document.getElementById("chartRangePresets").addEventListener("click", event => {
    const button = event.target.closest("[data-chart-range-choice]");
    if (!button || button.disabled) return;
    applyChartPresetRange(button.dataset.chartRangeChoice);
  });
  ["chartRangeStart", "chartRangeEnd"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyChartCustomRange();
      }
    });
  });
}

function chartLogoRow(payload) {
  const ticker = String(payload?.ticker || "").toUpperCase();
  const holding = flattenHoldings().find(row => String(row.ticker || "").toUpperCase() === ticker);
  const meta = findTickerMeta(ticker);
  return {
    ticker,
    name: payload?.name || holding?.name || meta?.name || ticker,
    logo: payload?.logo || holding?.logo || meta?.logo || null,
  };
}

function isKoreanTicker(ticker) {
  return /\.(KS|KQ)$/i.test(String(ticker || ""));
}

function koreanTickerCode(ticker) {
  const match = String(ticker || "").match(/^([0-9A-Za-z]{6})\.(KS|KQ)$/);
  return match ? match[1].toUpperCase() : null;
}

function renderChartExternalLinks(payload) {
  // 한국 종목이면 상단 툴바(목록·관심목록 옆)의 네이버 증권 링크를 노출.
  const el = document.getElementById("chartNaverLink");
  if (!el) return;
  const code = koreanTickerCode(String(payload?.ticker || "").toUpperCase());
  if (!code) {
    el.classList.add("hidden");
    el.removeAttribute("href");
    return;
  }
  el.href = `https://finance.naver.com/item/main.naver?code=${code}`;
  el.classList.remove("hidden");
}

function clearChartExternalLinks() {
  const el = document.getElementById("chartNaverLink");
  if (el) {
    el.classList.add("hidden");
    el.removeAttribute("href");
  }
}

function closeChartNameEditor() {
  document.getElementById("chartIdText")?.classList.remove("editing");
  document.getElementById("chartNameEditForm")?.classList.add("hidden");
  const input = document.getElementById("chartNameInput");
  if (input) input.dataset.ticker = "";
  const status = document.getElementById("chartNameEditStatus");
  if (status) status.textContent = "";
}

function currentChartDisplayName(ticker = chartTicker) {
  const key = String(ticker || "").toUpperCase();
  if (String(chartPayload?.ticker || "").toUpperCase() === key && chartPayload?.name) return chartPayload.name;
  return findTickerMeta(key)?.name || key;
}

function openChartNameEditor() {
  const ticker = String(chartTicker || "").toUpperCase();
  if (!ticker || performanceChartOpen || chartNameSaveInFlight) return;
  const input = document.getElementById("chartNameInput");
  if (!input) return;
  input.value = currentChartDisplayName(ticker);
  input.dataset.ticker = ticker;
  document.getElementById("chartNameEditStatus").textContent = "";
  document.getElementById("chartIdText")?.classList.add("editing");
  document.getElementById("chartNameEditForm")?.classList.remove("hidden");
  input.focus();
  input.select();
}

function applyTickerDisplayNameLocally(ticker, name) {
  const key = String(ticker || "").toUpperCase();
  (data?.tickers || []).forEach(item => {
    if (String(item.ticker || "").toUpperCase() === key) item.name = name;
  });
  (data?.members || []).forEach(member => {
    (member.accounts || []).forEach(account => {
      (account.holdings || []).forEach(holding => {
        if (String(holding.ticker || "").toUpperCase() === key) holding.name = name;
      });
    });
  });
  if (typeof interestWatchlists !== "undefined") {
    interestWatchlists.forEach(group => {
      (group.items || []).forEach(item => {
        if (String(item.ticker || "").toUpperCase() === key) item.name = name;
      });
    });
  }
  if (typeof tickerSearchDirectory !== "undefined" && Array.isArray(tickerSearchDirectory)) {
    tickerSearchDirectory.forEach(item => {
      if (String(item.ticker || "").toUpperCase() === key) item.name = name;
    });
  }
  if (String(chartPayload?.ticker || "").toUpperCase() === key) chartPayload.name = name;
  chartComparePayloads.forEach(item => {
    if (String(item.ticker || "").toUpperCase() === key) item.name = name;
  });
}

async function saveChartDisplayName(event) {
  event.preventDefault();
  if (chartNameSaveInFlight) return;
  const input = document.getElementById("chartNameInput");
  const status = document.getElementById("chartNameEditStatus");
  const ticker = String(input?.dataset.ticker || chartTicker || "").toUpperCase();
  const name = String(input?.value || "").replace(/\s+/g, " ").trim();
  if (!ticker || !name) {
    if (status) status.textContent = "노출명칭을 입력하세요.";
    input?.focus();
    return;
  }
  if (name === currentChartDisplayName(ticker)) {
    closeChartNameEditor();
    return;
  }
  chartNameSaveInFlight = true;
  document.querySelectorAll("#chartNameEditForm input, #chartNameEditForm button").forEach(el => { el.disabled = true; });
  if (status) status.textContent = "저장 중...";
  try {
    const result = await apiUpdateTickerDisplayName(ticker, name);
    applyTickerDisplayNameLocally(result.ticker, result.name);
    if (String(chartTicker || "").toUpperCase() === ticker) {
      document.getElementById("tableTitle").textContent = result.name;
      closeChartNameEditor();
      renderChartIdentity(chartPayload || { ticker, name: result.name });
    }
    renderInterestWatchlists();
  } catch (err) {
    if (status) status.textContent = err.message || String(err);
  } finally {
    chartNameSaveInFlight = false;
    document.querySelectorAll("#chartNameEditForm input, #chartNameEditForm button").forEach(el => { el.disabled = false; });
  }
}

function initChartNameEditor() {
  document.getElementById("chartNameEdit")?.addEventListener("click", openChartNameEditor);
  document.getElementById("chartNameEditForm")?.addEventListener("submit", saveChartDisplayName);
  document.getElementById("chartNameEditCancel")?.addEventListener("click", closeChartNameEditor);
  document.getElementById("chartNameInput")?.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeChartNameEditor();
    }
  });
}

function renderChartIdentity(payload) {
  const row = chartLogoRow(payload);
  const editingTicker = String(document.getElementById("chartNameInput")?.dataset.ticker || "").toUpperCase();
  if (editingTicker && editingTicker !== String(row.ticker || "").toUpperCase()) closeChartNameEditor();
  document.getElementById("chartIcon").innerHTML = logoMarkup(row);
  document.getElementById("chartTicker").textContent = row.ticker || "";
  document.getElementById("chartName").textContent = row.name || row.ticker || "";
  document.getElementById("chartNameEdit")?.classList.toggle("hidden", !row.ticker || performanceChartOpen);
  document.getElementById("chartInterestOpen")?.classList.toggle("hidden", !row.ticker);
  renderChartExternalLinks(row);
  renderChartPriceSummary(payload);
}

function finiteChartNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function chartSummaryMeta(payload) {
  const ticker = String(payload?.ticker || "").toUpperCase();
  const meta = findTickerMeta(ticker) || {};
  const holding = flattenHoldings().find(row => String(row.ticker || "").toUpperCase() === ticker) || {};
  return { ...holding, ...meta, ...payload, ticker, currency: payload?.currency || meta.currency || holding.currency || "USD" };
}

function chartPriceChangeMetric(price, previous, change, changePct) {
  const cleanPrice = finiteChartNumber(price);
  const cleanPrevious = finiteChartNumber(previous);
  let cleanChange = finiteChartNumber(change);
  let cleanChangePct = finiteChartNumber(changePct);
  if (cleanChange == null && cleanPrice != null && cleanPrevious != null && cleanPrevious !== 0) {
    cleanChange = cleanPrice - cleanPrevious;
  }
  if (cleanChangePct == null && cleanChange != null && cleanPrevious) {
    cleanChangePct = cleanChange / cleanPrevious * 100;
  }
  return { price: cleanPrice, change: cleanChange, changePct: cleanChangePct };
}

function chartPriceClass(change) {
  const number = Number(change);
  if (!Number.isFinite(number)) return "flat";
  return number > 0 ? "up" : number < 0 ? "down" : "flat";
}

function chartPriceDirectionSymbol(cls) {
  if (cls === "up") return "↑";
  if (cls === "down") return "↓";
  return "→";
}

function chartPricePctPill(metric) {
  if (metric.changePct == null) return "";
  const cls = chartPriceClass(metric.changePct);
  return `<span class="chart-price-pill ${cls}">${chartPriceDirectionSymbol(cls)}${fmt2.format(Math.abs(metric.changePct))}%</span>`;
}

function chartExtendedLabel(meta) {
  const source = String(meta.extended_source || "").toLowerCase();
  const state = String(meta.extended_market_state || "").toUpperCase();
  // 한국은 거래소명을 붙여 KRX 종가와 구분한다
  if (source.startsWith("nxt")) return source.includes("pre") ? "NXT 프리" : "NXT 애프터";
  if (source.includes("pre") || state === "PRE") return "프리";
  if (source.includes("after") || state.includes("POST")) return "애프터";
  return "연장";
}

function chartShouldShowExtendedLine(meta, metric, hasExtendedMarket) {
  if (!hasExtendedMarket || metric.price == null) return false;
  if (meta.category === "index") return false;
  const state = String(meta.extended_market_state || meta.market_state || "").toUpperCase();
  if (state === "REGULAR" || state === "REGULAR_MARKET") return false;
  return true;
}

function renderChartPriceQuote(dayMetric, extendedMetric, currency, ticker, hasExtendedMarket, extendedLabel, sessionNote = null) {
  const extendedLine = hasExtendedMarket && extendedMetric.price != null
    ? `
      <div class="chart-price-row extended">
        <span class="chart-price-row-label">${esc(extendedLabel)}</span>
        <strong class="chart-price-current">${esc(chartMoney(extendedMetric.price, currency, ticker))}</strong>
        ${chartPricePctPill(extendedMetric)}
      </div>
    `
    : "";
  return `
    <div class="chart-price-quote">
      <div class="chart-price-row regular">
        <span class="chart-price-row-label">정규</span>
        <strong class="chart-price-current">${dayMetric.price == null ? "-" : esc(chartMoney(dayMetric.price, currency, ticker))}</strong>
        ${chartPricePctPill(dayMetric)}
        ${sessionNote?.label ? `<sup class="change-session-note chart-session-note" title="${esc(sessionNoteTitle(sessionNote))}">${esc(sessionNote.label)}</sup>` : ""}
      </div>
      ${extendedLine}
    </div>
  `;
}

function renderChartPriceSummary(payload) {
  const el = document.getElementById("chartPriceSummary");
  if (!el) return;
  const ticker = String(payload?.ticker || "").toUpperCase();
  if (!ticker || performanceChartOpen) {
    el.innerHTML = "";
    return;
  }
  const meta = chartSummaryMeta(payload);
  const currency = meta.currency || payload?.currency || "USD";
  const dayMetric = chartPriceChangeMetric(
    meta.regular_price ?? meta.current_price,
    meta.regular_previous_price ?? meta.previous_price,
    meta.regular_change ?? meta.change,
    meta.regular_change_pct ?? meta.change_pct
  );
  const extendedMetric = chartPriceChangeMetric(
    meta.extended_price,
    meta.extended_base_price,
    meta.extended_change,
    meta.extended_change_pct
  );
  // 미국(장외) 또는 한국 NXT(프리·애프터) — 연장가가 실제로 온 종목이면 표기한다
  const isUsTicker = currency === "USD" && !ticker.includes(".");
  const hasExtendedMarket = isUsTicker || meta.extended_price != null;
  const showExtended = chartShouldShowExtendedLine(meta, extendedMetric, hasExtendedMarket);
  el.innerHTML = renderChartPriceQuote(dayMetric, showExtended ? extendedMetric : {}, currency, ticker, hasExtendedMarket, chartExtendedLabel(meta), meta.change_session_note);
}

function chartInterestGroups(ticker) {
  const key = String(ticker || "").toUpperCase();
  const meta = findTickerMeta(key) || {};
  const category = String(meta.category || "").toLowerCase();
  return (interestWatchlists || [])
    .filter(group => !group.fixed && group.id > 0)
    .map(group => ({
      ...group,
      checked: group.items?.some(item => String(item.ticker || "").toUpperCase() === key) || false,
      disabled: (group.name === "주요 지수" && category !== "index")
        || (group.name === "환율" && category !== "fx"),
    }));
}

function setChartInterestStatus(message = "", error = false) {
  const el = document.getElementById("chartInterestStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", error);
}

function renderChartInterestModal(ticker) {
  const key = String(ticker || "").toUpperCase();
  const list = document.getElementById("chartInterestList");
  const title = document.getElementById("chartInterestTicker");
  if (title) title.textContent = key || "-";
  if (!list) return;
  const groups = chartInterestGroups(key);
  if (!groups.length) {
    list.innerHTML = `<div class="ticker-search-empty">생성된 관심목록 그룹이 없습니다.</div>`;
    return;
  }
  list.innerHTML = groups.map(group => `
    <label class="chart-interest-row">
      <input type="checkbox" data-chart-interest-group="${group.id}" ${group.checked ? "checked" : ""} ${group.disabled ? "disabled" : ""}>
      <span class="chart-interest-check" aria-hidden="true"></span>
      <span class="chart-interest-name">${esc(group.name)}</span>
      <span class="chart-interest-count">${(group.items || []).length}</span>
    </label>
  `).join("");
}

async function openChartInterestModal() {
  const ticker = String(chartTicker || chartPayload?.ticker || "").toUpperCase();
  if (!ticker) return;
  const modal = document.getElementById("chartInterestModal");
  const list = document.getElementById("chartInterestList");
  if (!modal || !list) return;
  setChartInterestStatus("");
  if (!interestWatchlistsLoaded) {
    list.innerHTML = `<div class="ticker-search-empty">관심목록을 불러오는 중...</div>`;
    modal.showModal();
    try {
      await loadInterestWatchlists();
    } catch (err) {
      setChartInterestStatus(err.message || String(err), true);
      return;
    }
  } else if (!modal.open) {
    modal.showModal();
  }
  renderChartInterestModal(ticker);
}

function initChartInterestModal() {
  const modal = document.getElementById("chartInterestModal");
  const open = document.getElementById("chartInterestOpen");
  const close = document.getElementById("chartInterestClose");
  const list = document.getElementById("chartInterestList");
  if (!modal || !open || !close || !list) return;
  open.addEventListener("click", openChartInterestModal);
  close.addEventListener("click", () => modal.close());
  modal.addEventListener("click", event => {
    if (event.target === modal) modal.close();
  });
  list.addEventListener("change", async event => {
    const input = event.target.closest?.("[data-chart-interest-group]");
    if (!input) return;
    const ticker = String(chartTicker || chartPayload?.ticker || "").toUpperCase();
    const groupId = Number(input.dataset.chartInterestGroup);
    if (!ticker || !groupId) return;
    input.disabled = true;
    setChartInterestStatus(input.checked ? "추가 중..." : "삭제 중...");
    try {
      const payload = input.checked
        ? await apiAddInterestItem(groupId, ticker)
        : await apiDeleteInterestItem(groupId, ticker);
      applyInterestWatchlistPayload(payload);
      renderChartInterestModal(ticker);
      setChartInterestStatus("");
    } catch (err) {
      input.checked = !input.checked;
      input.disabled = false;
      setChartInterestStatus(err.message || String(err), true);
    }
  });
}

function bindLineChartControls(payload) {
  document.querySelectorAll(".chart-range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      if (btn.dataset.chartOverlayToggle != null) {
        if (btn.dataset.chartOverlayToggle === "bollinger") {
          chartShowBollinger = !chartShowBollinger;
          storageSet(detailStorage.chartShowBollinger, String(chartShowBollinger));
        } else if (btn.dataset.chartOverlayToggle === "ichimoku") {
          chartShowIchimoku = !chartShowIchimoku;
          storageSet(detailStorage.chartShowIchimoku, String(chartShowIchimoku));
        }
        renderLineChart(payload);
        return;
      }
      if (btn.dataset.markerToggle != null) {
        if (btn.dataset.markerToggle === "buy") {
          chartShowBuys = !chartShowBuys;
          storageSet(detailStorage.chartShowBuys, String(chartShowBuys));
        } else {
          chartShowSells = !chartShowSells;
          storageSet(detailStorage.chartShowSells, String(chartShowSells));
        }
        renderLineChart(payload);
        return;
      }
      if (btn.dataset.chartRangePopup != null || btn.dataset.chartCustom != null) {
        openChartRangeModal();
        return;
      }
      chartRange = btn.dataset.chartRange || "1y";
      reloadPriceChartForMarketMode({ skeleton: true });
    });
  });
}

function chartNumericValue(point, key) {
  const value = Number(point?.[key]);
  return Number.isFinite(value) ? value : null;
}

function chartCandleValues(point) {
  if (!chartPointHasCandle(point)) return null;
  const open = Number(point.open);
  const close = chartCandleClose(point);
  const high = Math.max(Number(point.high), open, close);
  const low = Math.min(Number(point.low), open, close);
  return { open, high, low, close };
}

function chartCandleExtremes(points) {
  const samples = points.map((point, index) => {
    const candle = chartCandleValues(point);
    const close = Number(point.close);
    return {
      index,
      high: candle?.high ?? close,
      low: candle?.low ?? close,
    };
  }).filter(item => Number.isFinite(item.high) && Number.isFinite(item.low));
  if (!samples.length) return [];
  const high = samples.reduce((best, item) => item.high > best.high ? item : best, samples[0]);
  const low = samples.reduce((best, item) => item.low < best.low ? item : best, samples[0]);
  return [
    { kind: "high", label: "고점", index: high.index, value: high.high },
    { kind: "low", label: "저점", index: low.index, value: low.low },
  ].filter((item, index, items) => index === 0 || item.index !== items[0].index);
}

// 툴팁 한 줄은 문자열(매매 마커) 또는 [라벨, 값] 쌍의 배열이다. 쌍으로 주면
// 라벨은 흐리게, 값은 고정폭으로 그려 항목 경계가 눈에 들어온다.
function chartPointTooltipLines(point, payload) {
  const money = value => chartMoney(value, payload.currency, payload.ticker);
  const lines = [chartFullDateLabel(point.date)];
  const candle = chartType === "candle" ? chartCandleValues(point) : null;
  if (candle) {
    lines.push([["시", money(candle.open)], ["고", money(candle.high)]]);
    lines.push([["저", money(candle.low)], ["종", money(candle.close)]]);
    const current = Number(point.close);
    if (point.live && Number.isFinite(current) && Math.abs(current - candle.close) > 1e-9) {
      lines.push([[point.extended ? "장외" : "현재", money(current)]]);
    }
  } else {
    lines.push([["가격", money(Number(point.close))]]);
  }
  const rsiValue = Number(point.rsi);
  if (Number.isFinite(rsiValue)) lines.push([["RSI", rsiValue.toFixed(1)]]);
  const entryValue = point.entry_score == null ? NaN : Number(point.entry_score);
  if (Number.isFinite(entryValue)) lines.push([["진입점수", entryValue.toFixed(2)]]);
  if (chartShowMovingAverages) CHART_MOVING_AVERAGES.forEach(series => {
    const value = chartNumericValue(point, series.key);
    if (value != null) lines.push([[`MA ${series.period}`, money(value)]]);
  });
  return lines;
}

function chartOverlayScaleValues(points) {
  const values = [];
  if (chartShowMovingAverages) {
    points.forEach(point => CHART_MOVING_AVERAGES.forEach(series => {
      const value = chartNumericValue(point, series.key);
      if (value != null) values.push(value);
    }));
  }
  if (chartShowBollinger) {
    points.forEach(point => ["bb_upper", "bb_mid", "bb_lower"].forEach(key => {
      const value = chartNumericValue(point, key);
      if (value != null) values.push(value);
    }));
  }
  if (chartShowIchimoku) {
    points.forEach(point => ["ichi_tenkan", "ichi_kijun", "ichi_span_a", "ichi_span_b"].forEach(key => {
      const value = chartNumericValue(point, key);
      if (value != null) values.push(value);
    }));
  }
  return values;
}

function chartSeriesPaths(points, key, xFor, yFor) {
  const paths = [];
  let run = [];
  points.forEach((point, index) => {
    const value = chartNumericValue(point, key);
    if (value == null) {
      if (run.length >= 2) paths.push(chartLinePath(run));
      run = [];
      return;
    }
    run.push({ x: xFor(index), y: yFor(value) });
  });
  if (run.length >= 2) paths.push(chartLinePath(run));
  return paths;
}

function ichimokuCloudPaths(points, xFor, yFor) {
  const paths = [];
  let run = [];
  let runBullish = null;
  const flush = () => {
    if (run.length >= 2) {
      const top = run.map(item => ({ x: item.x, y: yFor(Math.max(item.a, item.b)) }));
      const bottom = [...run].reverse().map(item => ({ x: item.x, y: yFor(Math.min(item.a, item.b)) }));
      const d = `${straightLinePath(top)} L${bottom.map(item => `${item.x.toFixed(2)},${item.y.toFixed(2)}`).join(" L")} Z`;
      paths.push({ d, bullish: runBullish });
    }
    run = [];
    runBullish = null;
  };

  points.forEach((point, index) => {
    const a = chartNumericValue(point, "ichi_span_a");
    const b = chartNumericValue(point, "ichi_span_b");
    if (a == null || b == null) {
      flush();
      return;
    }
    const bullish = a >= b;
    if (run.length && bullish !== runBullish) flush();
    if (!run.length) runBullish = bullish;
    run.push({ x: xFor(index), a, b });
  });
  flush();
  return paths;
}

function rsiThresholdAreaPaths(points, threshold, direction, xFor, yFor) {
  const samples = points
    .map((point, index) => ({ x: xFor(index), value: Number(point.rsi) }))
    .filter(point => Number.isFinite(point.value));
  if (samples.length < 2) return [];

  const inside = value => direction === "above" ? value > threshold : value < threshold;
  const thresholdY = yFor(threshold);
  const runs = [];
  let run = [];

  const crossing = (left, right) => {
    const ratio = (threshold - left.value) / (right.value - left.value);
    return {
      x: left.x + (right.x - left.x) * ratio,
      y: thresholdY,
      value: threshold,
    };
  };

  for (let index = 0; index < samples.length - 1; index += 1) {
    const left = samples[index];
    const right = samples[index + 1];
    const leftInside = inside(left.value);
    const rightInside = inside(right.value);

    if (leftInside && !run.length) run.push({ ...left, y: yFor(left.value) });
    if (leftInside && rightInside) {
      run.push({ ...right, y: yFor(right.value) });
    } else if (leftInside && !rightInside) {
      run.push(crossing(left, right));
      runs.push(run);
      run = [];
    } else if (!leftInside && rightInside) {
      run = [crossing(left, right), { ...right, y: yFor(right.value) }];
    }
  }
  if (run.length) runs.push(run);

  return runs
    .filter(items => items.length >= 2)
    .map(items => {
      const curve = chartLinePath(items);
      const first = items[0];
      const last = items[items.length - 1];
      return `${curve} L${last.x.toFixed(2)},${thresholdY.toFixed(2)} L${first.x.toFixed(2)},${thresholdY.toFixed(2)} Z`;
    });
}


function bindChartInteractions(points, payload, geometry) {
  const svg = document.querySelector("#chartCanvas svg");
  const hoverLayer = document.getElementById("chartHoverLayer");
  const hoverGroup = document.getElementById("chartHoverGroup");
  const hoverLine = document.getElementById("chartHoverLine");
  const hoverDot = document.getElementById("chartHoverDot");
  const tooltip = document.getElementById("chartTooltip");
  const tooltipBox = document.getElementById("chartTooltipBox");
  const selectionGroup = document.getElementById("chartSelectionGroup");
  const selectionRect = document.getElementById("chartSelectionRect");
  const selectionStartLine = document.getElementById("chartSelectionStartLine");
  const selectionEndLine = document.getElementById("chartSelectionEndLine");
  const selectionSummary = document.getElementById("chartSelectionSummary");
  const selectionSummaryBox = document.getElementById("chartSelectionSummaryBox");
  const selectionSummaryText = document.getElementById("chartSelectionSummaryText");
  let dragStartIndex = null;
  let isDragging = false;
  let touchPinned = false;
  if (!svg || !hoverLayer || !hoverGroup || !hoverLine || !hoverDot || !tooltip) return;

  // 줄바꿈은 직계 tspan만 담당한다 — 줄 안의 라벨·값 tspan에 x를 다시 박으면 겹친다
  const setTooltipX = value => {
    const formatted = Number(value).toFixed(2);
    tooltip.setAttribute("x", formatted);
    tooltip.querySelectorAll(":scope > tspan").forEach(line => line.setAttribute("x", formatted));
  };

  const tooltipSpan = (cls, text, dx) => {
    const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    span.setAttribute("class", cls);
    if (dx) span.setAttribute("dx", String(dx));
    span.textContent = text;
    return span;
  };

  // 문자열 줄(매매 마커)은 숫자 토큰만 골라 고정폭으로 감싼다
  const appendPlainTooltipLine = (parent, text) => {
    String(text).split(/([0-9][0-9.,]*)/).forEach(part => {
      if (!part) return;
      if (/^[0-9]/.test(part)) parent.appendChild(tooltipSpan("chart-tooltip-num", part));
      else parent.appendChild(document.createTextNode(part));
    });
  };

  const setTooltipLines = (lines, x, y) => {
    tooltip.replaceChildren();
    tooltip.setAttribute("y", Number(y).toFixed(2));
    lines.filter(Boolean).forEach((line, index) => {
      const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      // 날짜(첫 줄)와 본문 사이는 한 번 더 벌려 머리글처럼 보이게 한다
      span.setAttribute("dy", index === 0 ? "0" : index === 1 ? "1.6em" : "1.4em");
      if (index === 0) span.classList.add("chart-tooltip-date");
      if (Array.isArray(line)) {
        line.forEach(([label, value], segment) => {
          span.appendChild(tooltipSpan("chart-tooltip-label", label, segment ? 12 : 0));
          if (value != null) span.appendChild(tooltipSpan("chart-tooltip-num", String(value), 4));
        });
      } else {
        appendPlainTooltipLine(span, line);
      }
      tooltip.appendChild(span);
    });
    setTooltipX(x);
  };

  const updateTooltipBox = () => {
    if (!tooltipBox) return;
    let bbox = tooltip.getBBox();
    let x = Number(tooltip.getAttribute("x") || 0);
    let y = Number(tooltip.getAttribute("y") || 0);
    if (bbox.x < 6) x += 6 - bbox.x;
    if (bbox.x + bbox.width > geometry.width - 6) x -= bbox.x + bbox.width - (geometry.width - 6);
    if (bbox.y < 6) y += 6 - bbox.y;
    if (bbox.y + bbox.height > geometry.height - 6) y -= bbox.y + bbox.height - (geometry.height - 6);
    setTooltipX(x);
    tooltip.setAttribute("y", y.toFixed(2));
    bbox = tooltip.getBBox();
    tooltipBox.setAttribute("x", (bbox.x - 8).toFixed(2));
    tooltipBox.setAttribute("y", (bbox.y - 5).toFixed(2));
    tooltipBox.setAttribute("width", (bbox.width + 16).toFixed(2));
    tooltipBox.setAttribute("height", (bbox.height + 10).toFixed(2));
  };

  function showMarker(marker) {
    const x = Number(marker.dataset.x);
    const y = Number(marker.dataset.y);
    const hoverRsiDot = document.getElementById("chartHoverRsiDot");
    hoverRsiDot?.classList.add("hidden");
    const tooltipY = y < geometry.pad.top + geometry.plotH / 2 ? y + 38 : y - 70;
    const tooltipLines = String(marker.dataset.tooltip || "").split(/\s*·\s*/).filter(Boolean);
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    hoverDot.setAttribute("cx", x.toFixed(2));
    hoverDot.setAttribute("cy", y.toFixed(2));
    setTooltipLines(tooltipLines, x > geometry.width - 190 ? x - 160 : x + 14, tooltipY);
    updateTooltipBox();
  }

  function showPoint(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const svgY = clientY == null ? null : (clientY - rect.top) / rect.height * geometry.height;
    const marker = svgY == null ? null : Array.from(document.querySelectorAll(".trade-marker")).find(item => {
      const dx = Number(item.dataset.x) - svgX;
      const dy = Number(item.dataset.y) - svgY;
      return Math.hypot(dx, dy) <= 13;
    });
    if (marker) {
      showMarker(marker);
      return;
    }
    const xStart = geometry.xStart ?? geometry.pad.left;
    const xSpan = geometry.xSpan ?? geometry.plotW;
    const ratio = Math.min(1, Math.max(0, (svgX - xStart) / xSpan));
    const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
    const point = points[index];
    const x = geometry.xFor(index);
    const y = geometry.yFor(Number(point.close));
    const rsiValue = Number(point.rsi);
    const hoverRsiDot = document.getElementById("chartHoverRsiDot");
    const tooltipLines = chartPointTooltipLines(point, payload);
    const tooltipX = x > geometry.width - 190 ? x - 160 : x + 12;
    const tooltipY = y < geometry.pad.top + geometry.plotH / 2 ? y + 38 : y - (tooltipLines.length > 3 ? 76 : 60);
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    hoverDot.setAttribute("cx", x.toFixed(2));
    hoverDot.setAttribute("cy", y.toFixed(2));
    if (hoverRsiDot && Number.isFinite(rsiValue) && geometry.rsiYFor) {
      hoverRsiDot.classList.remove("hidden");
      hoverRsiDot.setAttribute("cx", x.toFixed(2));
      hoverRsiDot.setAttribute("cy", geometry.rsiYFor(rsiValue).toFixed(2));
    } else {
      hoverRsiDot?.classList.add("hidden");
    }
    setTooltipLines(tooltipLines, tooltipX, tooltipY);
    updateTooltipBox();
  }

  function pointIndexFromClientX(clientX) {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const xStart = geometry.xStart ?? geometry.pad.left;
    const xSpan = geometry.xSpan ?? geometry.plotW;
    const ratio = Math.min(1, Math.max(0, (svgX - xStart) / xSpan));
    return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
  }

  function updateSelection(fromIndex, toIndex) {
    if (
      !selectionGroup
      || !selectionRect
      || !selectionStartLine
      || !selectionEndLine
      || !selectionSummary
      || !selectionSummaryBox
      || !selectionSummaryText
    ) return;
    const startIndex = Math.min(fromIndex, toIndex);
    const endIndex = Math.max(fromIndex, toIndex);
    if (startIndex === endIndex) return;

    const start = points[startIndex];
    const end = points[endIndex];
    const startPrice = Number(start.close);
    const endPrice = Number(end.close);
    const change = endPrice - startPrice;
    const changePct = startPrice ? change / startPrice * 100 : 0;
    const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
    const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
    const x1 = geometry.xFor(startIndex);
    const x2 = geometry.xFor(endIndex);

    selectionGroup.classList.remove("hidden", "up", "down", "flat");
    selectionGroup.classList.add(cls);
    selectionRect.setAttribute("x", x1.toFixed(2));
    selectionRect.setAttribute("width", Math.max(1, x2 - x1).toFixed(2));
    [selectionStartLine, selectionEndLine].forEach((line, index) => {
      const x = index === 0 ? x1 : x2;
      line.setAttribute("x1", x.toFixed(2));
      line.setAttribute("x2", x.toFixed(2));
    });
    selectionSummary.classList.remove("hidden", "up", "down", "flat");
    selectionSummary.classList.add(cls);
    const startEntry = start.entry_score == null ? NaN : Number(start.entry_score);
    const endEntry = end.entry_score == null ? NaN : Number(end.entry_score);
    selectionSummaryText.textContent = [
      `${shortDateText(start.date)}–${shortDateText(end.date)}`,
      `${chartMoney(startPrice, payload.currency, payload.ticker)} → ${chartMoney(endPrice, payload.currency, payload.ticker)}`,
      `${arrow} ${changePct > 0 ? "+" : ""}${fmt2.format(changePct)}% (${signedChartMoney(change, payload.currency, payload.ticker)})`,
      // 구간 양끝의 진입점수 — 눌림이 깊어졌는지(점수↑) 과열로 갔는지(점수↓) 한눈에
      ...(Number.isFinite(startEntry) && Number.isFinite(endEntry)
        ? [`진입점수 ${startEntry.toFixed(2)} → ${endEntry.toFixed(2)}`]
        : []),
    ].join(" · ");

    const inset = geometry.pad.left + 8;
    const rightEdge = geometry.pad.left + geometry.plotW - 8;
    let summaryX = geometry.pad.left + geometry.plotW / 2;
    selectionSummaryText.setAttribute("x", summaryX.toFixed(2));
    let textBox = selectionSummaryText.getBBox();
    if (textBox.x < inset) summaryX += inset - textBox.x;
    if (textBox.x + textBox.width > rightEdge) summaryX -= textBox.x + textBox.width - rightEdge;
    selectionSummaryText.setAttribute("x", summaryX.toFixed(2));
    textBox = selectionSummaryText.getBBox();
    selectionSummaryBox.setAttribute("x", (textBox.x - 10).toFixed(2));
    selectionSummaryBox.setAttribute("y", (textBox.y - 5).toFixed(2));
    selectionSummaryBox.setAttribute("width", (textBox.width + 20).toFixed(2));
    selectionSummaryBox.setAttribute("height", (textBox.height + 10).toFixed(2));
  }

  hoverLayer.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch") {
      touchPinned = true;
      showPoint(event.clientX, event.clientY);
      return;
    }
    dragStartIndex = pointIndexFromClientX(event.clientX);
    isDragging = true;
    selectionGroup?.classList.add("hidden");
    selectionSummary?.classList.add("hidden");
    hoverGroup.classList.add("hidden");
    hoverLayer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  hoverLayer.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") {
      if (event.buttons) showPoint(event.clientX, event.clientY);
      return;
    }
    if (isDragging && dragStartIndex != null) {
      updateSelection(dragStartIndex, pointIndexFromClientX(event.clientX));
      return;
    }
    showPoint(event.clientX, event.clientY);
  });
  hoverLayer.addEventListener("pointerup", event => {
    if (event.pointerType === "touch") {
      showPoint(event.clientX, event.clientY);
      return;
    }
    if (isDragging && dragStartIndex != null) {
      updateSelection(dragStartIndex, pointIndexFromClientX(event.clientX));
    }
    isDragging = false;
    dragStartIndex = null;
    hoverLayer.releasePointerCapture?.(event.pointerId);
  });
  hoverLayer.addEventListener("pointercancel", () => {
    isDragging = false;
    dragStartIndex = null;
  });
  hoverLayer.addEventListener("pointerenter", event => showPoint(event.clientX, event.clientY));
  hoverLayer.addEventListener("pointerleave", () => {
    if (!touchPinned) hoverGroup.classList.add("hidden");
  });

  document.querySelectorAll(".trade-marker").forEach(marker => {
    ["pointerenter", "mouseenter", "mouseover", "focus", "click"].forEach(eventName => {
      marker.addEventListener(eventName, () => showMarker(marker));
    });
  });
}

function renderLineChart(payload) {
  syncChartBottomControls(true);
  syncChartIntervalControl();
  if (chartComparePayloads.length) {
    renderCompareLineChart(payload);
    return;
  }
  const allPoints = aggregateChartPoints(payload.points || [])
    .filter(point => Number.isFinite(Number(point.close)));
  normalizeChartRangeForPayloads([payload], false, "all");
  const points = filterChartPoints(allPoints, chartRange);
  // 매수/매도 마커 표시 토글 반영 (꺼진 쪽은 마커·스케일에서 제외)
  const chartTransactions = chartInterval === "day"
    ? transactionsForChart(payload, points).filter(tx => (tx.side === "BUY" ? chartShowBuys : chartShowSells))
    : [];
  renderChartIdentity(payload);
  if (points.length < 2) {
    syncChartLogToggle(false);
    document.getElementById("chartMeta").textContent = `${points.length} points`;
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">차트 데이터 없음</div>${renderChartCompareControls()}`;
    renderChartRangeControls();
    bindChartCompareControls(payload);
    bindLineChartControls(payload);
    renderChartStats(payload);
    ensureChartStats(payload.ticker);
    return;
  }
  syncChartLogToggle(true);

  const values = points.map(point => Number(point.close));
  const candleScaleValues = chartType === "candle"
    ? points.flatMap(point => {
        const candle = chartCandleValues(point);
        return candle ? [candle.open, candle.high, candle.low, candle.close] : [];
      })
    : [];
  const overlayValues = chartOverlayScaleValues(points);
  const markerValues = chartTransactions.map(tx => tx.price);
  // 로그 스케일은 모든 값이 양수일 때만 적용 (아니면 선형 폴백)
  const scaleValues = [...values, ...candleScaleValues, ...markerValues, ...overlayValues];
  const useLog = chartLogScale && scaleValues.every(value => value > 0);
  const scale = useLog ? logChartScale(scaleValues) : tightLowerChartScale(scaleValues);
  const min = scale.min;
  const max = scale.max;
  const width = 980;
  const compactChart = window.matchMedia?.("(max-width: 980px)")?.matches;
  const height = compactChart ? 900 : 530;
  const last = values[values.length - 1];
  const overlayMetrics = chartOverlayMetrics(values);
  const extremeRadius = compactChart ? 7 : 4;
  const tradeMarkerRadius = compactChart ? 10 : 5;
  document.getElementById("chartMeta").textContent = "";

  // 컨트롤은 차트 밖 상단 한 줄. 플롯에는 고점 라벨 여유만 남긴다.
  // 화면 픽셀을 viewBox 단위로 환산하는 규칙은 유지한다.
  const headroomPx = 16;
  const canvasEl = document.getElementById("chartCanvas");
  const pxToView = width / Math.max(1, canvasEl?.clientWidth || width);
  const dataHeadroom = Math.ceil(headroomPx * pxToView);
  // RSI 아래·날짜축 위의 차트 내부 스트립을 드래그 구간 요약에 사용한다.
  const pad = { top: 12, right: 58, bottom: compactChart ? 54 : 44, left: 14 };
  const plotW = width - pad.left - pad.right;
  const rsiGap = compactChart ? 24 : 18;
  const rsiH = compactChart ? 180 : 96;
  const plotH = height - pad.top - pad.bottom - rsiGap - rsiH;
  const rsiTop = pad.top + plotH + rsiGap;
  const rsiBottom = rsiTop + rsiH;
  const selectionSummaryY = compactChart ? height - 32 : height - 27;
  const range = max - min || Math.max(1, Math.abs(max));
  const logMax = useLog ? Math.log10(max) : 0;
  const logSpan = useLog ? ((Math.log10(max) - Math.log10(min)) || 1) : 1;
  const candleWidth = Math.max(.75, Math.min(compactChart ? 10 : 8, plotW / Math.max(1, points.length) * .68));
  // 캔들 중심을 플롯 경계에 두면 clipPath가 몸통 절반을 잘라낸다. 캔들
  // 모드에서만 몸통 바깥으로 약 8 viewBox 단위의 숨 쉴 여백을 확보한다.
  const candleInset = chartType === "candle" ? Math.max(10, candleWidth / 2 + 8) : 0;
  const xStart = pad.left + candleInset;
  const xSpan = Math.max(1, plotW - candleInset * 2);
  const xFor = index => points.length === 1
    ? pad.left + plotW / 2
    : xStart + index / (points.length - 1) * xSpan;
  // 데이터는 플롯 상단 헤드룸(컨트롤 오버레이 영역) 아래에서 시작
  const dataTop = pad.top + dataHeadroom;
  const dataH = Math.max(40, plotH - dataHeadroom);
  const yFor = useLog
    ? (value => dataTop + (logMax - Math.log10(value)) / logSpan * dataH)
    : (value => dataTop + (max - value) / range * dataH);
  const candleMarkup = chartType === "candle" ? points.map((point, index) => {
    const candle = chartCandleValues(point);
    if (!candle) return "";
    const x = xFor(index);
    const openY = yFor(candle.open);
    const closeY = yFor(candle.close);
    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(1.15, Math.abs(closeY - openY));
    const cls = candle.close > candle.open ? "up" : candle.close < candle.open ? "down" : "flat";
    return `
      <g class="chart-candle ${cls}">
        <line class="chart-candle-wick" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${yFor(candle.high).toFixed(2)}" y2="${yFor(candle.low).toFixed(2)}"></line>
        <rect class="chart-candle-body" x="${(x - candleWidth / 2).toFixed(2)}" y="${bodyY.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${bodyH.toFixed(2)}" rx="${Math.min(.7, candleWidth / 5).toFixed(2)}"></rect>
      </g>
    `;
  }).join("") : "";
  const rsiValues = points
    .map(point => Number(point.rsi))
    .filter(value => Number.isFinite(value));
  const rsiScale = dynamicRsiChartScale(rsiValues);
  const rsiSpan = rsiScale.max - rsiScale.min || 1;
  const rsiYFor = value => {
    const bounded = Math.max(rsiScale.min, Math.min(rsiScale.max, value));
    return rsiTop + (rsiScale.max - bounded) / rsiSpan * rsiH;
  };
  const line = chartLinePath(points.map((point, index) => ({ x: xFor(index), y: yFor(Number(point.close)) })));
  const area = `${line} L${pad.left + plotW},${pad.top + plotH} L${pad.left},${pad.top + plotH} Z`;
  const bbUpperPaths = chartShowBollinger ? chartSeriesPaths(points, "bb_upper", xFor, yFor) : [];
  const maSeries = chartShowMovingAverages ? CHART_MOVING_AVERAGES.map(series => ({
    ...series, paths: chartSeriesPaths(points, series.key, xFor, yFor),
  })) : [];
  const maLegend = document.getElementById("chartMaLegend");
  if (maLegend) maLegend.innerHTML = maSeries.map(series =>
    `<span class="chart-ma-label ${series.paths.length ? "" : "unavailable"}" style="color:${series.color}" title="${series.period} 거래일 단순이동평균${series.paths.length ? "" : " · 표시 구간의 데이터 부족"}"><i class="ma-${series.period}"></i>${series.label}${series.paths.length ? "" : " (자료 부족)"}</span>`
  ).join("");
  const bbMidPaths = chartShowBollinger ? chartSeriesPaths(points, "bb_mid", xFor, yFor) : [];
  const bbLowerPaths = chartShowBollinger ? chartSeriesPaths(points, "bb_lower", xFor, yFor) : [];
  const bbRuns = chartShowBollinger ? points.reduce((runs, point, index) => {
    const upper = chartNumericValue(point, "bb_upper");
    const lower = chartNumericValue(point, "bb_lower");
    if (upper == null || lower == null) {
      if (runs.current.length >= 2) runs.items.push(runs.current);
      runs.current = [];
      return runs;
    }
    runs.current.push({ x: xFor(index), upper: yFor(upper), lower: yFor(lower) });
    return runs;
  }, { current: [], items: [] }) : { current: [], items: [] };
  if (bbRuns.current.length >= 2) bbRuns.items.push(bbRuns.current);
  const bbFillAreas = bbRuns.items.map(run => {
    const top = run.map(item => ({ x: item.x, y: item.upper }));
    const bottom = [...run].reverse().map(item => ({ x: item.x, y: item.lower }));
    return `${straightLinePath(top)} L${bottom.map(item => `${item.x.toFixed(2)},${item.y.toFixed(2)}`).join(" L")} Z`;
  });
  const ichiTenkanPaths = chartShowIchimoku ? chartSeriesPaths(points, "ichi_tenkan", xFor, yFor) : [];
  const ichiKijunPaths = chartShowIchimoku ? chartSeriesPaths(points, "ichi_kijun", xFor, yFor) : [];
  const ichiSpanAPaths = chartShowIchimoku ? chartSeriesPaths(points, "ichi_span_a", xFor, yFor) : [];
  const ichiSpanBPaths = chartShowIchimoku ? chartSeriesPaths(points, "ichi_span_b", xFor, yFor) : [];
  const ichiCloudAreas = chartShowIchimoku ? ichimokuCloudPaths(points, xFor, yFor) : [];
  const rsiLine = chartLinePath(
    points
      .map((point, index) => ({ x: xFor(index), y: rsiYFor(Number(point.rsi)), value: Number(point.rsi) }))
      .filter(point => Number.isFinite(point.value))
  );
  const rsiOverboughtAreas = rsiThresholdAreaPaths(points, 70, "above", xFor, rsiYFor);
  const rsiOversoldAreas = rsiThresholdAreaPaths(points, 30, "below", xFor, rsiYFor);
  const rsiGuides = rsiScale.ticks.map(value => ({
    value,
    y: rsiYFor(value),
    boundary: value === rsiScale.min || value === rsiScale.max,
  }));
  const latestRsi = [...points].reverse().map(point => Number(point.rsi)).find(value => Number.isFinite(value));
  const currentRsiY = Number.isFinite(latestRsi) ? rsiYFor(latestRsi) : null;
  // 진입점수(종가 기준)는 RSI 패널에 겹쳐 그린다 — 축은 왼쪽 안쪽에 0~max.
  // 점수는 실질 0~4 범위라 RSI(0~100)와 축을 나눠야 과열 구간과 0점대가 같은 시점에서 읽힌다.
  const entryValues = points
    .map(point => point.entry_score == null ? NaN : Number(point.entry_score))
    .filter(value => Number.isFinite(value));
  const entryMax = entryValues.length ? Math.max(1, Math.ceil(Math.max(...entryValues))) : 0;
  const entryYFor = value => rsiTop + (entryMax - Math.max(0, Math.min(entryMax, value))) / (entryMax || 1) * rsiH;
  const entryLine = entryMax ? chartLinePath(
    points
      .map((point, index) => ({ x: xFor(index), value: point.entry_score == null ? NaN : Number(point.entry_score) }))
      .filter(point => Number.isFinite(point.value))
      .map(point => ({ x: point.x, y: entryYFor(point.value) }))
  ) : "";
  const entryTicks = entryMax ? [entryMax, entryMax / 2, 0] : [];
  const latestEntry = [...points].reverse()
    .map(point => point.entry_score == null ? NaN : Number(point.entry_score))
    .find(value => Number.isFinite(value));
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
  const currentPriceY = yFor(last);
  const currentPriceLabel = chartMoney(last, payload.currency, payload.ticker);
  const vGrid = indexedChartVerticalGrid(points, xFor, chartRange);
  const labelEvery = Math.max(1, Math.ceil(vGrid.ticks.length / 8));
  const markers = chartTransactions.map((tx, index) => {
    const pointIndex = nearestPointIndex(points, tx.date);
    const x = xFor(pointIndex);
    const y = yFor(tx.price);
    const isBuy = tx.side === "BUY";
    return {
      ...tx,
      key: `${tx.date}-${tx.side}-${index}`,
      label: isBuy ? "B" : "S",
      cls: isBuy ? "buy" : "sell",
      x,
      y,
      tooltip: `${chartFullDateLabel(tx.date)} · ${tx.side === "BUY" ? "매수" : "매도"} ${fmt2.format(tx.qty)}주 · ${chartMoney(tx.price, tx.currency || payload.currency, payload.ticker)} · ${tx.account || tx.member || "-"}`,
    };
  });
  const extremes = (chartType === "candle" ? chartCandleExtremes(points) : chartExtremes(values)).map(item => {
    const x = xFor(item.index);
    const y = yFor(item.value);
    const leftSide = x > width - 180;
    const tooHigh = y < pad.top + 24;
    const tooLow = y > pad.top + plotH - 20;
    const labelY = item.kind === "high"
      ? (tooHigh ? y + 24 : y - 12)
      : (tooLow ? y - 12 : y + 24);
    return {
      ...item,
      x,
      y,
      labelX: leftSide ? x - 10 : x + 10,
      labelY,
      anchor: leftSide ? "end" : "start",
      text: `${item.label} ${chartMoney(item.value, payload.currency, payload.ticker)}`,
    };
  });

  document.getElementById("chartCanvas").innerHTML = `
    <svg class="line-chart single-price-chart ${chartType === "candle" ? "candle-chart" : "price-line-chart"}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(payload.name)} ${chartType === "candle" ? "캔들" : "종가"} 및 RSI 차트">
      <defs>
        <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-price)" stop-opacity=".18"></stop>
          <stop offset="72%" stop-color="var(--chart-price)" stop-opacity=".045"></stop>
          <stop offset="100%" stop-color="var(--chart-price)" stop-opacity="0"></stop>
        </linearGradient>
        <clipPath id="chartPlotClip">
          <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
        </clipPath>
        <clipPath id="chartRsiClip">
          <rect x="${pad.left}" y="${rsiTop}" width="${plotW}" height="${rsiH}"></rect>
        </clipPath>
      </defs>
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      <rect class="chart-plot-border" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      <rect class="chart-rsi-border" x="${pad.left}" y="${rsiTop}" width="${plotW}" height="${rsiH}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${width - 6}" y="${(tick.y + 4).toFixed(2)}">${esc(chartMoney(tick.value, payload.currency, payload.ticker))}</text>
      `).join("")}
      ${vGrid.ticks.map(tick => `
        <line class="chart-grid perf-vgrid" x1="${tick.x.toFixed(2)}" x2="${tick.x.toFixed(2)}" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(2)}"></line>
        <line class="chart-grid perf-vgrid" x1="${tick.x.toFixed(2)}" x2="${tick.x.toFixed(2)}" y1="${rsiTop}" y2="${rsiBottom}"></line>
      `).join("")}
      ${vGrid.ticks.map((tick, index) => {
        if (index % labelEvery !== 0) return "";
        const anchor = tick.x < pad.left + 18 ? "start" : tick.x > pad.left + plotW - 18 ? "end" : "middle";
        return `<text class="chart-x-label" x="${tick.x.toFixed(2)}" y="${height - 6}" text-anchor="${anchor}">${esc(perfGridLabel(tick.time, vGrid.unit))}</text>`;
      }).join("")}
      ${chartType === "line" ? `<path class="chart-area" d="${area}"></path>` : ""}
      <g class="chart-price-overlays" clip-path="url(#chartPlotClip)">
        ${ichiCloudAreas.map(item => `<path class="chart-ichi-cloud ${item.bullish ? "bullish" : "bearish"}" d="${item.d}"></path>`).join("")}
        ${ichiSpanAPaths.map(path => `<path class="chart-ichi-line span-a" d="${path}"></path>`).join("")}
        ${ichiSpanBPaths.map(path => `<path class="chart-ichi-line span-b" d="${path}"></path>`).join("")}
        ${ichiTenkanPaths.map(path => `<path class="chart-ichi-line tenkan" d="${path}"></path>`).join("")}
        ${ichiKijunPaths.map(path => `<path class="chart-ichi-line kijun" d="${path}"></path>`).join("")}
        ${bbFillAreas.map(path => `<path class="chart-bb-fill" d="${path}"></path>`).join("")}
        ${bbUpperPaths.map(path => `<path class="chart-bb-line outer" d="${path}"></path>`).join("")}
        ${bbMidPaths.map(path => `<path class="chart-bb-line mid" d="${path}"></path>`).join("")}
        ${bbLowerPaths.map(path => `<path class="chart-bb-line outer" d="${path}"></path>`).join("")}
      </g>
      ${chartType === "candle"
        ? `<g class="chart-candles" clip-path="url(#chartPlotClip)">${candleMarkup}</g>`
        : `<path class="chart-line" d="${line}"></path>`}
      <g class="chart-moving-averages" clip-path="url(#chartPlotClip)">
        ${maSeries.map(series => series.paths.map(path => `<path class="chart-ma-line ma-${series.period}" style="stroke:${series.color}" data-ma-period="${series.period}" d="${path}"></path>`).join("")).join("")}
      </g>
      <line class="chart-current-price-tick" x1="${(pad.left + plotW).toFixed(2)}" x2="${(width - 8).toFixed(2)}" y1="${currentPriceY.toFixed(2)}" y2="${currentPriceY.toFixed(2)}"></line>
      <text class="chart-current-price-label" x="${width - 6}" y="${(currentPriceY + 4).toFixed(2)}">${esc(currentPriceLabel)}</text>
      <g class="chart-rsi-series" clip-path="url(#chartRsiClip)">
        ${rsiOverboughtAreas.map(path => `<path class="chart-rsi-zone overbought" d="${path}"></path>`).join("")}
        ${rsiOversoldAreas.map(path => `<path class="chart-rsi-zone oversold" d="${path}"></path>`).join("")}
      </g>
      ${rsiGuides.map(guide => `
        <line class="chart-rsi-guide ${guide.boundary ? "boundary" : `level-${guide.value}`}" x1="${pad.left}" x2="${pad.left + plotW}" y1="${guide.y.toFixed(2)}" y2="${guide.y.toFixed(2)}"></line>
        <text class="chart-rsi-axis" x="${width - 6}" y="${(guide.y + 4).toFixed(2)}">${guide.value}</text>
      `).join("")}
      ${entryTicks.map((value, index) => `
        <text class="chart-entry-axis" x="${pad.left + 4}" y="${(entryYFor(value) + (index === 0 ? 11 : index === entryTicks.length - 1 ? -2 : 4)).toFixed(2)}">${Number.isInteger(value) ? value : value.toFixed(1)}</text>
      `).join("")}
      <text class="chart-rsi-title" x="${pad.left + (entryMax ? 26 : 7)}" y="${rsiTop + 14}">RSI (14)</text>
      ${Number.isFinite(latestEntry) ? `<text class="chart-entry-title" x="${pad.left + (entryMax ? 26 : 7) + 52}" y="${rsiTop + 14}">진입점수 ${latestEntry.toFixed(2)}</text>` : ""}
      <g class="chart-rsi-line-series" clip-path="url(#chartRsiClip)">
        ${entryLine ? `<path class="chart-entry-line" d="${entryLine}"></path>` : ""}
        ${rsiLine ? `<path class="chart-rsi-line" d="${rsiLine}"></path>` : ""}
      </g>
      ${currentRsiY != null ? `
        <line class="chart-rsi-current-tick" x1="${(pad.left + plotW).toFixed(2)}" x2="${(width - 8).toFixed(2)}" y1="${currentRsiY.toFixed(2)}" y2="${currentRsiY.toFixed(2)}"></line>
        <text class="chart-rsi-current-label" x="${width - 6}" y="${(currentRsiY + 4).toFixed(2)}">${Math.round(latestRsi)}</text>
      ` : ""}
      ${extremes.map(item => `
        <g class="chart-extreme ${item.kind}">
          <circle cx="${item.x.toFixed(2)}" cy="${item.y.toFixed(2)}" r="${extremeRadius}"></circle>
          <text x="${item.labelX.toFixed(2)}" y="${item.labelY.toFixed(2)}" text-anchor="${item.anchor}">${esc(item.text)}</text>
        </g>
      `).join("")}
      ${renderChartMetricsOverlay(overlayMetrics, pad.left + 10, pad.top + 10, compactChart)}
      <g id="chartSelectionGroup" class="chart-selection hidden">
        <rect id="chartSelectionRect" class="chart-selection-range" x="0" y="${pad.top}" width="0" height="${plotH}"></rect>
        <line id="chartSelectionStartLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${rsiBottom}"></line>
        <line id="chartSelectionEndLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${rsiBottom}"></line>
      </g>
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${rsiBottom - pad.top}"></rect>
      ${markers.map(marker => `
        <g class="trade-marker ${marker.cls}" data-x="${marker.x.toFixed(2)}" data-y="${marker.y.toFixed(2)}" data-tooltip="${esc(marker.tooltip)}" tabindex="0" role="img" aria-label="${esc(marker.tooltip)}">
          <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="${tradeMarkerRadius}"></circle>
          <text x="${marker.x.toFixed(2)}" y="${(marker.y + (compactChart ? 4.5 : 3)).toFixed(2)}" text-anchor="middle">${marker.label}</text>
        </g>
      `).join("")}
      ${(chartType === "line" || !chartPointHasCandle(points[points.length - 1]) || Math.abs(last - chartCandleClose(points[points.length - 1])) > 1e-9)
        ? `<circle class="chart-last-dot" cx="${xFor(points.length - 1).toFixed(2)}" cy="${yFor(last).toFixed(2)}" r="4"></circle>`
        : ""}
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${rsiBottom}"></line>
        <circle id="chartHoverDot" class="chart-hover-dot" cx="0" cy="0" r="4"></circle>
        <circle id="chartHoverRsiDot" class="chart-hover-rsi-dot hidden" cx="0" cy="0" r="3.5"></circle>
        <rect id="chartTooltipBox" class="chart-tooltip-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartTooltip" class="chart-tooltip" x="0" y="0">-</text>
      </g>
      <g id="chartSelectionSummary" class="chart-selection-summary hidden" aria-live="polite">
        <rect id="chartSelectionSummaryBox" class="chart-selection-summary-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartSelectionSummaryText" class="chart-selection-summary-text" x="${(pad.left + plotW / 2).toFixed(2)}" y="${selectionSummaryY}" text-anchor="middle"></text>
      </g>
    </svg>
    ${renderChartCompareControls()}
  `;
  renderChartRangeControls();
  bindChartInteractions(points, payload, { width, height, pad, plotW, plotH, xStart, xSpan, xFor, yFor, rsiYFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
  renderChartStats(payload);
  ensureChartStats(payload.ticker);
  ensureChartQuote(payload.ticker);
  // rAF 타이밍에 기대지 않고 렌더 직후 즉시 위치 계산(+rAF는 보험)
  syncChartOverlayPosition();
  requestAnimationFrame(syncChartOverlayPosition);
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-line-chart");

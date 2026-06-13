// Performance chart rendering. Classic script loaded before app.js; shares
// the global scope and resolves state/helpers at call time.

function accountPerformanceTitle(payload) {
  const accounts = payload?.accounts || [];
  if (!accounts.length) return "선택 계좌 성과";
  if (accounts.length === 1) return `${accounts[0].member} · ${accounts[0].name}`;
  return `${accounts.length}개 계좌`;
}

function normalizePerformancePoints(points, rangeKey, bounds = null) {
  const raw = (points || [])
    .filter(point => point.date && Number.isFinite(Number(point.value)))
    .map(point => ({ date: point.date, value: Number(point.value) }));
  const startDate = bounds?.startDate || null;
  const endDate = bounds?.endDate || null;
  const filtered = startDate || endDate
    ? raw.filter(point => {
        const date = new Date(`${point.date}T00:00:00`);
        return (!startDate || date >= startDate) && (!endDate || date <= endDate);
      })
    : filterChartPoints(raw.map(point => ({ date: point.date, close: point.value })), rangeKey)
        .map(point => ({ date: point.date, value: Number(point.close) }));
  if (filtered.length < 2) return [];
  const base = filtered.find(point => point.value > 0)?.value;
  if (!base) return [];
  return filtered.map(point => ({
    date: point.date,
    close: (point.value / base - 1) * 100,
    value: point.value,
    time: new Date(`${point.date}T00:00:00`).getTime(),
  }));
}

function performanceSeries(payload) {
  const portfolioRaw = payload?.points || [];
  const accountSeries = payload?.account_series || [];
  const lastDate = portfolioRaw[portfolioRaw.length - 1]?.date
    || accountSeries.flatMap(item => item.points || []).map(point => point.date).sort().at(-1)
    || Object.values(payload?.indexes || {}).flatMap(item => item.points || []).map(point => point.date).sort().at(-1);
  const bounds = lastDate ? chartRangeBounds([{ date: lastDate }], chartRange) : null;
  const series = [
    {
      key: "portfolio",
      name: "선택 계좌",
      color: "var(--brand)",
      points: normalizePerformancePoints(portfolioRaw, chartRange, bounds),
      primary: true,
    },
  ];
  if (performanceDetailEnabled() && accountSeries.length > 1) {
    accountSeries.forEach((account, index) => {
      series.push({
        key: `account-${account.id}`,
        name: account.name || `계좌 ${index + 1}`,
        color: chartCompareColors[(index + 1) % chartCompareColors.length],
        points: normalizePerformancePoints(account.points || [], chartRange, bounds),
        primary: false,
        detail: true,
      });
    });
  }
  // 빨강=상승/파랑=하락 시맨틱과 충돌하지 않도록 중립 비교색(보라·청록·앰버)
  const indexMeta = [
    ["SP500", "S&P 500", "#7c3aed"],
    ["NASDAQ", "나스닥", "#0d9488"],
    ["KOSPI", "코스피", "#d97706"],
  ];
  indexMeta.forEach(([key, label, color]) => {
    if (!performanceIndexes[key]) return;
    const index = payload?.indexes?.[key];
    series.push({
      key,
      name: label,
      color,
      points: normalizePerformancePoints(index?.points || [], chartRange, bounds),
      primary: false,
    });
  });
  return series.filter(item => item.points.length >= 2);
}

function renderPerformanceControls() {
  const items = [
    ["SP500", "S&P 500"],
    ["NASDAQ", "나스닥"],
    ["KOSPI", "코스피"],
  ];
  return `
    <div class="perf-controls" role="group" aria-label="비교 지수">
      ${items.map(([key, label]) => `
        <button class="perf-index-toggle ${performanceIndexes[key] ? "active" : ""}" type="button" data-index="${key}" aria-pressed="${performanceIndexes[key] ? "true" : "false"}">${label}</button>
      `).join("")}
    </div>
  `;
}

function bindPerformanceHover(series, geometry) {
  // 비교 차트와 동일한 HTML 오버레이 툴팁 사용(색상 이름 + %). 단, 로고·주가는 제외.
  const svg = document.querySelector("#chartCanvas svg");
  const canvas = document.getElementById("chartCanvas");
  const hoverLayer = document.getElementById("chartHoverLayer");
  const hoverGroup = document.getElementById("chartHoverGroup");
  const hoverLine = document.getElementById("chartHoverLine");
  const tooltip = document.getElementById("compareTooltip");
  if (!svg || !canvas || !hoverLayer || !hoverGroup || !hoverLine || !tooltip) return;

  const showPoint = clientX => {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    const targetTime = geometry.minTime + ratio * (geometry.maxTime - geometry.minTime);
    const x = geometry.xForTime(targetTime);
    const mainPoint = nearestChartPoint(series[0]?.points || [], targetTime);
    const dateText = mainPoint?.date || new Date(targetTime).toISOString().slice(0, 10);
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    series.forEach(item => {
      const dot = document.getElementById(`perfDot-${item.key}`);
      if (!dot) return;
      const point = nearestChartPoint(item.points, targetTime);
      if (point) {
        dot.setAttribute("cx", x.toFixed(2));
        dot.setAttribute("cy", geometry.yFor(point.close).toFixed(2));
        dot.style.display = "";
      } else {
        dot.style.display = "none";
      }
    });
    const rows = series.map(item => {
      const point = nearestChartPoint(item.points, targetTime);
      if (!point) return "";
      const cls = point.close > 0 ? "up" : point.close < 0 ? "down" : "flat";
      return `<div class="ct-row simple"><span class="ct-name" style="color:${item.color}">${esc(item.name)}</span><span class="ct-pct ${cls}">${esc(pctChartLabel(point.close))}</span></div>`;
    }).join("");
    tooltip.innerHTML = `<div class="ct-date">${esc(chartFullDateLabel(dateText))}</div>${rows}`;
    tooltip.classList.remove("hidden");
    placeChartHoverTooltip(tooltip, canvas, rect, geometry, x);
  };

  bindHoverPointerEvents(hoverLayer, showPoint, () => {
    hoverGroup.classList.add("hidden");
    tooltip.classList.add("hidden");
  });
}

function renderPerformanceChart(payload) {
  performancePayload = payload;
  const series = performanceSeries(payload);
  if (typeof syncChartLogToggle === "function") syncChartLogToggle(false);   // 성과 차트는 로그 미적용
  const statsEl = document.getElementById("chartStats");
  if (statsEl) statsEl.innerHTML = "";   // 성과 차트엔 종목별 지표 패널 숨김
  document.getElementById("chartIcon").innerHTML = `<span class="asset-icon">%</span>`;
  document.getElementById("chartTicker").textContent = "성과";
  document.getElementById("chartName").textContent = accountPerformanceTitle(payload);
  if (typeof clearChartExternalLinks === "function") clearChartExternalLinks();

  if (!series.length || !series[0]?.points.length) {
    document.getElementById("chartMeta").textContent = `${payload?.holdings_count || 0}개 종목`;
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">성과 차트 데이터 없음</div>${renderPerformanceControls()}${renderChartRangeButtons()}`;
    bindPerformanceChartControls();
    return;
  }

  const allPoints = series.flatMap(item => item.points);
  const minTime = Math.min(...allPoints.map(point => point.time));
  const maxTime = Math.max(...allPoints.map(point => point.time));
  const values = allPoints.map(point => point.close);
  const scale = niceChartScale([...values, 0]);
  const min = scale.min;
  const max = scale.max;
  const width = 980;
  const isMobileChart = Boolean(window.matchMedia?.("(max-width: 980px)")?.matches);
  const height = isMobileChart ? 864 : 432;
  const pad = { top: 26, right: 104, bottom: 34, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const range = max - min || 1;
  const xForTime = time => pad.left + (maxTime === minTime ? 0 : (time - minTime) / (maxTime - minTime) * plotW);
  const yFor = value => pad.top + (max - value) / range * plotH;
  const clampY = value => Math.max(pad.top + 4, Math.min(pad.top + plotH - 2, value));
  const pathFor = points => points.map((point, index) => `${index === 0 ? "M" : "L"}${xForTime(point.time).toFixed(2)},${yFor(point.close).toFixed(2)}`).join(" ");
  const portfolio = series[0];
  const lastPoint = portfolio.points[portfolio.points.length - 1];
  document.getElementById("chartMeta").textContent = "";
  const tickLabel = value => `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.round(Math.abs(value))}%`;
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
  const vGrid = perfVerticalGrid(minTime, maxTime, chartRange);
  const labelEvery = Math.max(1, Math.ceil(vGrid.lines.length / 8));
  // (#3) per-line total performance shown at each line's right end, de-collided vertically
  const endLabels = series
    .map(item => {
      const last = item.points[item.points.length - 1].close;
      return { color: item.color, close: last, y: yFor(last) };
    })
    .sort((a, b) => a.y - b.y);
  const minGap = 13;
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < minGap) endLabels[i].y = endLabels[i - 1].y + minGap;
  }
  // (#3) top legend keeps only colour + name; the % moved to the line ends
  const legend = series
    .map(item => `<span class="perf-legend-item"><i style="background:${item.color}"></i>${esc(item.name)}</span>`)
    .join("");

  document.getElementById("chartCanvas").innerHTML = `
    <div class="perf-chart-top">
      <div class="perf-legend">${legend}</div>
      ${renderPerformanceControls()}
    </div>
    <svg class="line-chart perf-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="계좌 기간 성과 차트">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      <rect class="chart-plot-border" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${pad.left - 8}" y="${(tick.y + 4).toFixed(2)}">${esc(tickLabel(tick.value))}</text>
      `).join("")}
      ${vGrid.lines.map(time => `
        <line class="chart-grid perf-vgrid" x1="${xForTime(time).toFixed(2)}" x2="${xForTime(time).toFixed(2)}" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(2)}"></line>
      `).join("")}
      <line class="perf-zero-line" x1="${pad.left}" x2="${pad.left + plotW}" y1="${yFor(0).toFixed(2)}" y2="${yFor(0).toFixed(2)}"></line>
      ${vGrid.lines.map((time, index) => {
        if (index % labelEvery !== 0) return "";
        const x = xForTime(time);
        const anchor = x < pad.left + 18 ? "start" : x > pad.left + plotW - 18 ? "end" : "middle";
        return `<text class="chart-x-label" x="${x.toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${esc(perfGridLabel(time, vGrid.unit))}</text>`;
      }).join("")}
      ${series.map(item => `
        <path class="perf-line ${item.primary ? "primary" : "index"}" d="${pathFor(item.points)}" style="stroke:${item.color}"></path>
      `).join("")}
      ${endLabels.map(label => `
        <text class="perf-end-label" x="${(pad.left + plotW + 7).toFixed(2)}" y="${(clampY(label.y) + 3.5).toFixed(2)}" style="fill:${label.color}">${esc(pctChartLabel(label.close))}</text>
      `).join("")}
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        ${series.map(item => `<circle id="perfDot-${item.key}" class="perf-hover-dot" r="3.6" cx="0" cy="0" style="stroke:${item.color}"></circle>`).join("")}
      </g>
    </svg>
    <div id="compareTooltip" class="compare-tooltip hidden" aria-hidden="true"></div>
    ${renderChartRangeButtons()}
  `;
  bindPerformanceHover(series, { width, height, pad, plotW, plotH, minTime, maxTime, xForTime, yFor });
  bindPerformanceChartControls();
}

function bindPerformanceChartControls() {
  document.querySelectorAll(".perf-index-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.index;
      performanceIndexes[key] = !performanceIndexes[key];
      renderPerformanceChart(performancePayload);
    });
  });
  document.querySelectorAll(".chart-range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.chartCustom != null) {
        openChartRangeModal();
        return;
      }
      chartRange = btn.dataset.chartRange || "6m";
      renderPerformanceChart(performancePayload);
    });
  });
}

async function openPerformanceChart() {
  performanceChartOpen = true;
  syncTransactionPanel();
  chartTicker = null;
  chartPayload = null;
  syncDetailTabs();
  document.getElementById("chartIcon").innerHTML = `<span class="asset-icon">%</span>`;
  document.getElementById("chartTicker").textContent = "성과";
  document.getElementById("chartName").textContent = "계좌 퍼포먼스";
  if (typeof clearChartExternalLinks === "function") clearChartExternalLinks();
  document.getElementById("chartMeta").textContent = "loading...";
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  const accounts = visibleAccounts();
  const allAccounts = selectionMode === "all";
  performanceLoadInFlight = apiFetchAccountPerformance(accounts.map(account => account.id), allAccounts);
  try {
    const payload = await performanceLoadInFlight;
    if (!performanceChartOpen) return;
    renderPerformanceChart(payload);
  } catch (err) {
    if (!performanceChartOpen) return;
    document.getElementById("chartMeta").textContent = "";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">${esc(err.message || String(err))}</div>`;
  } finally {
    if (performanceLoadInFlight) performanceLoadInFlight = null;
  }
}

async function openChart(ticker) {
  const cleanTicker = String(ticker || "").trim().toUpperCase();
  if (!cleanTicker) return;
  performanceChartOpen = false;
  if (chartTicker !== cleanTicker) chartComparePayloads = [];
  chartTicker = cleanTicker;
  syncTransactionPanel();
  syncDetailTabs();
  document.getElementById("tableTitle").textContent = cleanTicker;
  renderChartIdentity({ ticker: cleanTicker, name: cleanTicker });
  document.getElementById("chartMeta").textContent = "loading...";
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  chartLoadInFlight = apiFetchChart(cleanTicker);
  try {
    const payload = await chartLoadInFlight;
    if (chartTicker !== cleanTicker) return;
    chartPayload = payload;
    document.getElementById("tableTitle").textContent = payload.name || payload.ticker;
    renderLineChart(payload);
  } catch (err) {
    if (chartTicker !== cleanTicker) return;
    document.getElementById("chartMeta").textContent = "";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">${esc(err.message || String(err))}</div>`;
  } finally {
    if (chartLoadInFlight) chartLoadInFlight = null;
  }
}

function closeChart(updateHash = true) {
  chartTicker = null;
  chartLoadInFlight = null;
  chartPayload = null;
  chartComparePayloads = [];
  performanceChartOpen = false;
  performanceLoadInFlight = null;
  performancePayload = null;
  if (updateHash && (location.hash.startsWith("#chart=") || location.hash === "#performance")) {
    history.pushState(null, "", location.pathname + location.search);
  }
  renderTable();
}
window.openChart = openChart;
window.openPerformanceChart = openPerformanceChart;
window.closeChart = closeChart;

function syncChartRoute() {
  if (performanceChartFromHash()) {
    openPerformanceChart();
    return;
  }
  const ticker = chartTickerFromHash();
  if (ticker) openChart(ticker);
  else if (chartTicker || performanceChartOpen) closeChart(false);
}

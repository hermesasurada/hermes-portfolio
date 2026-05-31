// Performance & price-chart rendering — extracted from app.js (#12).
// Classic script loaded before app.js; shares the global scope (state and
// helpers live in app.js and resolve at call time).

function pctChartLabel(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${fmt2.format(Math.abs(value))}%`;
}

// (#6) vertical gridline cadence by selected range: 1m→주, 3y/5y→분기, 그 외→월
function perfGridUnit(rangeKey) {
  if (rangeKey === "1m") return "week";
  if (rangeKey === "3y" || rangeKey === "5y") return "quarter";
  return "month";
}

function perfVerticalGrid(minTime, maxTime, rangeKey) {
  const unit = perfGridUnit(rangeKey);
  const start = new Date(minTime);
  let cursor;
  if (unit === "week") {
    cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7)); // back to Monday
    if (cursor.getTime() < minTime) cursor.setDate(cursor.getDate() + 7);
  } else if (unit === "quarter") {
    cursor = new Date(start.getFullYear(), Math.floor(start.getMonth() / 3) * 3, 1);
    if (cursor.getTime() < minTime) cursor.setMonth(cursor.getMonth() + 3);
  } else {
    cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    if (cursor.getTime() < minTime) cursor.setMonth(cursor.getMonth() + 1);
  }
  const lines = [];
  let guard = 0;
  while (cursor.getTime() <= maxTime && guard++ < 240) {
    lines.push(cursor.getTime());
    if (unit === "week") cursor.setDate(cursor.getDate() + 7);
    else if (unit === "quarter") cursor.setMonth(cursor.getMonth() + 3);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return { unit, lines };
}

function perfGridLabel(time, unit) {
  const d = new Date(time);
  if (unit === "week") return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

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
  const lastDate = portfolioRaw[portfolioRaw.length - 1]?.date
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
  const indexMeta = [
    ["SP500", "S&P 500", "#ea4335"],
    ["NASDAQ", "나스닥", "#fbbc04"],
    ["KOSPI", "코스피", "#34a853"],
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

function performanceContributionItems(payload, portfolioPoints) {
  const startPoint = portfolioPoints?.[0];
  const endPoint = portfolioPoints?.[portfolioPoints.length - 1];
  const startValue = Number(startPoint?.value);
  const endValue = Number(endPoint?.value);
  const totalContribution = endValue - startValue;
  if (
    !startPoint?.date
    || !endPoint?.date
    || !Number.isFinite(startValue)
    || !Number.isFinite(endValue)
    || startValue <= 0
    || Math.abs(totalContribution) < 0.000001
  ) return [];
  return (payload?.contributors || [])
    .map(item => {
      const periodPoints = (item.points || [])
        .filter(point => point.date >= startPoint.date && point.date <= endPoint.date && Number.isFinite(Number(point.value)))
        .map(point => ({ date: point.date, value: Number(point.value) }));
      if (periodPoints.length < 2) return null;
      const start = periodPoints[0].value;
      const end = periodPoints[periodPoints.length - 1].value;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return null;
      const contribution = end - start;
      const contributionSharePct = contribution / totalContribution * 100;
      const holdingPct = (end / start - 1) * 100;
      return {
        ticker: String(item.ticker || "").toUpperCase(),
        name: item.name || item.ticker,
        contribution,
        contributionSharePct,
        holdingPct,
        size: Math.abs(contribution),
      };
    })
    .filter(item => item && item.size > 0)
    .sort((a, b) => b.size - a.size);
}

function binaryTreemap(items, x, y, width, height) {
  if (!items.length || width <= 0 || height <= 0) return [];
  if (items.length === 1) return [{ ...items[0], x, y, width, height }];
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (total <= 0) return [];
  let bestIndex = 1;
  let bestDistance = Infinity;
  let running = 0;
  for (let index = 0; index < items.length - 1; index++) {
    running += items[index].size;
    const distance = Math.abs(total / 2 - running);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index + 1;
    }
  }
  const leftItems = items.slice(0, bestIndex);
  const rightItems = items.slice(bestIndex);
  const leftTotal = leftItems.reduce((sum, item) => sum + item.size, 0);
  const ratio = leftTotal / total;
  if (width >= height) {
    const leftWidth = width * ratio;
    return [
      ...binaryTreemap(leftItems, x, y, leftWidth, height),
      ...binaryTreemap(rightItems, x + leftWidth, y, width - leftWidth, height),
    ];
  }
  const topHeight = height * ratio;
  return [
    ...binaryTreemap(leftItems, x, y, width, topHeight),
    ...binaryTreemap(rightItems, x, y + topHeight, width, height - topHeight),
  ];
}

function contributionTileColor(item, maxAbsPct) {
  const intensity = Math.min(1, Math.max(0.18, Math.abs(item.contributionSharePct) / Math.max(0.01, maxAbsPct)));
  return `${Math.round(16 + intensity * 42)}%`;
}

function contributionTileLabel(item) {
  const ticker = String(item.ticker || "").toUpperCase();
  const name = String(item.name || "").trim();
  if (/\.(KS|KQ)$/.test(ticker) && name) return name;
  return ticker || name;
}

function renderPerformanceContributionChart(payload, portfolioPoints) {
  const items = performanceContributionItems(payload, portfolioPoints);
  if (!items.length) return `<div class="perf-contrib-empty">기여도 데이터 없음</div>`;
  const maxAbsPct = Math.max(...items.map(item => Math.abs(item.contributionSharePct)));
  const rects = binaryTreemap(items, 0, 0, 100, 100);
  return `
    <div class="perf-contrib-chart" aria-label="기간 성과 기여도">
      ${rects.map(item => {
        const area = item.width * item.height;
        const sizeClass = area > 1200 ? "large" : area > 620 ? "medium" : area > 260 ? "small" : "tiny";
        const title = `${item.ticker} 기여 ${pctChartLabel(item.contributionSharePct)} · 종목 ${pctChartLabel(item.holdingPct)}`;
        const label = contributionTileLabel(item);
        return `
          <div class="perf-contrib-tile ${item.contribution >= 0 ? "up" : "down"} ${sizeClass}"
            style="left:${item.x.toFixed(3)}%;top:${item.y.toFixed(3)}%;width:${item.width.toFixed(3)}%;height:${item.height.toFixed(3)}%;--tile-mix:${contributionTileColor(item, maxAbsPct)}"
            title="${esc(title)}">
            <span class="perf-contrib-ticker">${esc(label)}</span>
            <span class="perf-contrib-pct">${esc(pctChartLabel(item.contributionSharePct))}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function bindPerformanceHover(series, geometry) {
  const svg = document.querySelector("#chartCanvas svg");
  const hoverLayer = document.getElementById("chartHoverLayer");
  const hoverGroup = document.getElementById("chartHoverGroup");
  const hoverLine = document.getElementById("chartHoverLine");
  const tooltip = document.getElementById("chartTooltip");
  const tooltipBox = document.getElementById("chartTooltipBox");
  if (!svg || !hoverLayer || !hoverGroup || !hoverLine || !tooltip || !tooltipBox) return;

  const nearest = (points, targetTime) => points.reduce((best, point) => {
    const distance = Math.abs(point.time - targetTime);
    return !best || distance < best.distance ? { point, distance } : best;
  }, null)?.point;

  const updateTooltipBox = () => {
    let bbox = tooltip.getBBox();
    let x = Number(tooltip.getAttribute("x") || 0);
    if (bbox.x + bbox.width > geometry.width - 8) x -= bbox.x + bbox.width - (geometry.width - 8);
    if (bbox.x < 8) x += 8 - bbox.x;
    tooltip.setAttribute("x", x.toFixed(2));
    tooltip.querySelectorAll("tspan").forEach(tspan => tspan.setAttribute("x", x.toFixed(2)));
    bbox = tooltip.getBBox();
    tooltipBox.setAttribute("x", (bbox.x - 9).toFixed(2));
    tooltipBox.setAttribute("y", (bbox.y - 7).toFixed(2));
    tooltipBox.setAttribute("width", (bbox.width + 18).toFixed(2));
    tooltipBox.setAttribute("height", (bbox.height + 14).toFixed(2));
  };

  const showPoint = clientX => {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    const targetTime = geometry.minTime + ratio * (geometry.maxTime - geometry.minTime);
    const x = geometry.xForTime(targetTime);
    const portfolioPoint = nearest(series[0]?.points || [], targetTime);
    const y = portfolioPoint ? geometry.yFor(portfolioPoint.close) : geometry.pad.top;
    const dateText = portfolioPoint?.date || new Date(targetTime).toISOString().slice(0, 10);
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    // place a dot on each line at the hovered date (from-start performance point)
    series.forEach(item => {
      const dot = document.getElementById(`perfDot-${item.key}`);
      if (!dot) return;
      const point = nearest(item.points, targetTime);
      if (point) {
        dot.setAttribute("cx", x.toFixed(2));
        dot.setAttribute("cy", geometry.yFor(point.close).toFixed(2));
        dot.style.display = "";
      } else {
        dot.style.display = "none";
      }
    });
    tooltip.textContent = "";
    const tx = x > geometry.width - 250 ? x - 176 : x + 14;
    [
      chartFullDateLabel(dateText),
      ...series.map(item => {
        const point = nearest(item.points, targetTime);
        return `${item.name} ${pctChartLabel(point?.close)}`;
      }),
    ].forEach((line, index) => {
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttribute("x", tx.toFixed(2));
      tspan.setAttribute("dy", index === 0 ? "0" : "11");
      tspan.textContent = line;
      tooltip.appendChild(tspan);
    });
    tooltip.setAttribute("x", tx.toFixed(2));
    tooltip.setAttribute("y", (y < geometry.pad.top + geometry.plotH / 2 ? y + 42 : y - 62).toFixed(2));
    updateTooltipBox();
  };

  hoverLayer.addEventListener("pointermove", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerenter", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerleave", () => hoverGroup.classList.add("hidden"));
}

function renderPerformanceChart(payload) {
  performancePayload = payload;
  const series = performanceSeries(payload);
  document.getElementById("chartIcon").innerHTML = `<span class="asset-icon">%</span>`;
  document.getElementById("chartTicker").textContent = "성과";
  document.getElementById("chartName").textContent = accountPerformanceTitle(payload);

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
  const height = 360;
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
  const cls = lastPoint.close > 0 ? "up" : lastPoint.close < 0 ? "down" : "flat";
  document.getElementById("chartMeta").innerHTML = `
    <span>${chartDateLabel(portfolio.points[0].date)} - ${chartDateLabel(lastPoint.date)}</span>
    <span>${payload.holdings_count || 0}개 종목</span>
    <span class="${cls}">${pctChartLabel(lastPoint.close)}</span>
  `;
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
        <rect id="chartTooltipBox" class="chart-tooltip-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartTooltip" class="chart-tooltip perf-tooltip" x="0" y="0">-</text>
      </g>
    </svg>
    ${renderPerformanceContributionChart(payload, portfolio.points)}
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
  document.getElementById("chartMeta").textContent = "loading...";
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">loading...</div>`;
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
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">loading...</div>`;
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

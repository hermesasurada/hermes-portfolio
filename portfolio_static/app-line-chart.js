// 단일 종목 가격차트 + 통계 패널 + 기간/모달 컨트롤. (공용=app-chart-scale.js, 비교=app-chart-compare.js)
function renderChartRangeButtons() {
  // 비교 모드: '전체' 대신 공통기간 '최대' 노출 (상장일 차이로 못 쓰는 구간 제외)
  const isCompare = chartComparePayloads.length > 0;
  const ranges = isCompare ? chartRanges.filter(range => range.key !== "all") : chartRanges;
  // 비교 모드: 공통 가용기간보다 긴 기간(예: 상장 5년 미만 종목과 비교 시 '5년')은 비활성화
  const availMonths = isCompare ? compareAvailableMonths() : Infinity;
  const maxBtn = isCompare
    ? `<button class="chart-range-btn ${chartRange === "cmax" ? "active" : ""}" type="button" data-chart-range="cmax">최대</button>`
    : "";
  return `
    <div class="chart-ranges" role="group" aria-label="차트 기간">
      ${ranges.map(range => {
        const disabled = isCompare && range.months && range.months > availMonths + 0.5;
        return `<button class="chart-range-btn ${range.key === chartRange ? "active" : ""}${disabled ? " disabled" : ""}" type="button" data-chart-range="${range.key}"${disabled ? " disabled" : ""}>${range.label}</button>`;
      }).join("")}
      ${maxBtn}
      <button class="chart-range-btn ${chartRange === "custom" ? "active" : ""}" type="button" data-chart-custom>직접설정</button>
    </div>
  `;
}

// 우측 상단 로그 스케일 토글: 단일 가격 차트에서만 노출
function syncChartLogToggle(visible) {
  const btn = document.getElementById("chartLogToggle");
  if (!btn) return;
  btn.classList.toggle("hidden", !visible);
  btn.classList.toggle("active", chartLogScale);
  btn.setAttribute("aria-pressed", String(chartLogScale));
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

function openChartRangeModal() {
  const modal = document.getElementById("chartRangeModal");
  const startInput = document.getElementById("chartRangeStart");
  const endInput = document.getElementById("chartRangeEnd");
  const defaults = chartPointDatesForModal();
  startInput.value = chartCustomRange.start || defaults.start;
  endInput.value = chartCustomRange.end || defaults.end;
  setChartRangeStatus("");
  modal.showModal();
  startInput.focus();
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
  if (performanceChartOpen) renderPerformanceChart(performancePayload);
  else if (chartPayload) renderLineChart(chartPayload);
}

function initChartRangeModal() {
  document.getElementById("chartRangeClose").addEventListener("click", () => {
    document.getElementById("chartRangeModal").close();
  });
  document.getElementById("chartRangeApply").addEventListener("click", applyChartCustomRange);
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

function renderChartIdentity(payload) {
  const row = chartLogoRow(payload);
  document.getElementById("chartIcon").innerHTML = logoMarkup(row);
  document.getElementById("chartTicker").textContent = row.ticker || "";
  document.getElementById("chartName").textContent = row.name || row.ticker || "";
}

function renderChartStats(payload) {
  const el = document.getElementById("chartStats");
  if (!el) return;
  const ticker = String(payload?.ticker || "").toUpperCase();
  if (!ticker) { el.innerHTML = ""; return; }
  const s = statsData[ticker] || {};
  const rsi = s.rsi || {};
  const bb = s.bollinger_pband || {};
  const perf = s.performance || {};
  const loaded = Boolean(statsData[ticker]);
  const mcap = Number.isFinite(Number(s.market_cap)) ? marketCapText(s.market_cap, payload?.currency) : "-";

  const percent = (value, digits = 1) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return "-";
    const cls = number > 0 ? "cstat-positive" : number < 0 ? "cstat-negative" : "";
    return `<span class="${cls}">${number.toLocaleString("ko-KR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}%</span>`;
  };
  const indicator = (value, kind) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return "-";
    let cls = "";
    if (kind === "rsi") cls = number >= 70 ? "cstat-negative" : number <= 30 ? "cstat-cold" : "";
    if (kind === "bb") cls = number >= 100 ? "cstat-negative" : number <= 0 ? "cstat-cold" : "";
    return `<span class="${cls}">${Math.round(number).toLocaleString("ko-KR")}</span>`;
  };
  const row = ([label, value]) => `
    <div class="cstat-row">
      <span class="cstat-k">${esc(label)}</span>
      <span class="cstat-v">${value}</span>
    </div>
  `;
  const columns = [
    [
      ["시가총액", mcap],
      ["배당수익률", dividendYieldText(s.dividend_yield)],
      ["P/E (t)", peText(s.trailing_pe)],
      ["P/E (f)", peText(s.forward_pe)],
      ["P/B", peText(s.price_to_book)],
      ["실적일", earningsText(s.next_earnings_date)],
    ],
    [
      ["RSI (일)", indicator(rsi.day, "rsi")],
      ["RSI (주)", indicator(rsi.week, "rsi")],
      ["RSI (월)", indicator(rsi.month, "rsi")],
      ["BB (일)", indicator(bb.day, "bb")],
      ["BB (주)", indicator(bb.week, "bb")],
      ["BB (월)", indicator(bb.month, "bb")],
    ],
    [
      ["1개월", percent(perf.one_month)],
      ["3개월", percent(perf.three_month, 0)],
      ["6개월", percent(perf.six_month, 0)],
      ["YTD", percent(perf.ytd, 0)],
      ["1년", percent(perf.one_year, 0)],
      ["3년", percent(perf.three_year, 0)],
    ],
    [
      ["5년", percent(perf.five_year, 0)],
      ["52주 고점 대비", percent(s.drawdown_52w)],
      ["β", betaText(s.beta)],
      ["β″", betaText(s.beta_adj)],
    ],
  ];

  el.innerHTML = `
    <div class="cstat-board">
      ${columns.map(items => `<div class="cstat-column">${items.map(row).join("")}</div>`).join("")}
    </div>
    ${loaded ? "" : `<div class="chart-stat-loading">통계 불러오는 중…</div>`}
  `;
}

function ensureChartStats(ticker) {
  const clean = String(ticker || "").toUpperCase();
  if (!clean || statsData[clean]) return;
  apiFetchStats([clean]).then(payload => {
    statsData = { ...statsData, ...(payload.stats || {}) };
    if (chartTicker === clean && !performanceChartOpen && !chartComparePayloads.length) {
      renderChartStats(chartPayload || { ticker: clean });
    }
  }).catch(() => {});
}

function bindLineChartControls(payload) {
  document.querySelectorAll(".chart-range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.chartCustom != null) {
        openChartRangeModal();
        return;
      }
      chartRange = btn.dataset.chartRange || "6m";
      renderLineChart(payload);
    });
  });
}

function tickerDisplayName(ticker) {
  const key = String(ticker || "").toUpperCase();
  const meta = findTickerMeta(key);
  return meta?.name || key;
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
  const selectionTooltip = document.getElementById("chartSelectionTooltip");
  const selectionTooltipBox = document.getElementById("chartSelectionTooltipBox");
  let dragStartIndex = null;
  let isDragging = false;
  if (!svg || !hoverLayer || !hoverGroup || !hoverLine || !hoverDot || !tooltip) return;

  const updateTooltipBox = () => {
    if (!tooltipBox) return;
    let bbox = tooltip.getBBox();
    let x = Number(tooltip.getAttribute("x") || 0);
    let y = Number(tooltip.getAttribute("y") || 0);
    if (bbox.x < 6) x += 6 - bbox.x;
    if (bbox.x + bbox.width > geometry.width - 6) x -= bbox.x + bbox.width - (geometry.width - 6);
    if (bbox.y < 6) y += 6 - bbox.y;
    if (bbox.y + bbox.height > geometry.height - 6) y -= bbox.y + bbox.height - (geometry.height - 6);
    tooltip.setAttribute("x", x.toFixed(2));
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
    const tooltipY = y < geometry.pad.top + geometry.plotH / 2 ? y + 42 : y - 58;
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    hoverDot.setAttribute("cx", x.toFixed(2));
    hoverDot.setAttribute("cy", y.toFixed(2));
    tooltip.setAttribute("x", (x > geometry.width - 280 ? x - 218 : x + 14).toFixed(2));
    tooltip.setAttribute("y", tooltipY.toFixed(2));
    tooltip.textContent = marker.dataset.tooltip || "";
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
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
    const point = points[index];
    const x = geometry.xFor(index);
    const y = geometry.yFor(Number(point.close));
    const tooltipX = x > geometry.width - 250 ? x - 188 : x + 12;
    const tooltipY = y < geometry.pad.top + geometry.plotH / 2 ? y + 42 : y - 58;
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    hoverDot.setAttribute("cx", x.toFixed(2));
    hoverDot.setAttribute("cy", y.toFixed(2));
    tooltip.setAttribute("x", tooltipX.toFixed(2));
    tooltip.setAttribute("y", tooltipY.toFixed(2));
    tooltip.textContent = `${chartFullDateLabel(point.date)} · ${chartMoney(Number(point.close), payload.currency)}`;
    updateTooltipBox();
  }

  function pointIndexFromClientX(clientX) {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
  }

  function updateSelection(fromIndex, toIndex) {
    if (!selectionGroup || !selectionRect || !selectionStartLine || !selectionEndLine || !selectionTooltip || !selectionTooltipBox) return;
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
    const labelX = Math.min(geometry.width - 10, Math.max(10, (x1 + x2) / 2));
    const lines = [
      `${arrow}${signedChartMoney(change, payload.currency)} (${changePct > 0 ? "+" : ""}${fmt2.format(changePct)}%)`,
      `${chartFullDateLabel(start.date)} - ${chartFullDateLabel(end.date)}`,
      `${chartMoney(startPrice, payload.currency)} → ${chartMoney(endPrice, payload.currency)}`,
    ];

    selectionGroup.classList.remove("hidden", "up", "down", "flat");
    selectionGroup.classList.add(cls);
    selectionRect.setAttribute("x", x1.toFixed(2));
    selectionRect.setAttribute("width", Math.max(1, x2 - x1).toFixed(2));
    [selectionStartLine, selectionEndLine].forEach((line, index) => {
      const x = index === 0 ? x1 : x2;
      line.setAttribute("x1", x.toFixed(2));
      line.setAttribute("x2", x.toFixed(2));
    });
    selectionTooltip.setAttribute("x", labelX.toFixed(2));
    selectionTooltip.setAttribute("y", (geometry.pad.top + 16).toFixed(2));
    selectionTooltip.textContent = "";
    lines.forEach((line, index) => {
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttribute("x", labelX.toFixed(2));
      tspan.setAttribute("dy", index === 0 ? "0" : "15");
      tspan.textContent = line;
      selectionTooltip.appendChild(tspan);
    });

    let bbox = selectionTooltip.getBBox();
    let adjustedX = labelX;
    if (bbox.x < 8) adjustedX += 8 - bbox.x;
    if (bbox.x + bbox.width > geometry.width - 8) adjustedX -= bbox.x + bbox.width - (geometry.width - 8);
    if (adjustedX !== labelX) {
      selectionTooltip.setAttribute("x", adjustedX.toFixed(2));
      selectionTooltip.querySelectorAll("tspan").forEach(tspan => tspan.setAttribute("x", adjustedX.toFixed(2)));
      bbox = selectionTooltip.getBBox();
    }
    selectionTooltipBox.setAttribute("x", (bbox.x - 9).toFixed(2));
    selectionTooltipBox.setAttribute("y", (bbox.y - 7).toFixed(2));
    selectionTooltipBox.setAttribute("width", (bbox.width + 18).toFixed(2));
    selectionTooltipBox.setAttribute("height", (bbox.height + 14).toFixed(2));
  }

  hoverLayer.addEventListener("pointerdown", event => {
    dragStartIndex = pointIndexFromClientX(event.clientX);
    isDragging = true;
    hoverGroup.classList.add("hidden");
    hoverLayer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  hoverLayer.addEventListener("pointermove", event => {
    if (isDragging && dragStartIndex != null) {
      updateSelection(dragStartIndex, pointIndexFromClientX(event.clientX));
      return;
    }
    showPoint(event.clientX, event.clientY);
  });
  hoverLayer.addEventListener("pointerup", event => {
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
  hoverLayer.addEventListener("pointerleave", () => hoverGroup.classList.add("hidden"));

  document.querySelectorAll(".trade-marker").forEach(marker => {
    ["pointerenter", "mouseenter", "mouseover", "focus", "click"].forEach(eventName => {
      marker.addEventListener(eventName, () => showMarker(marker));
    });
  });
}

function renderLineChart(payload) {
  if (chartComparePayloads.length) {
    renderCompareLineChart(payload);
    return;
  }
  const allPoints = (payload.points || []).filter(point => Number.isFinite(Number(point.close)));
  const points = filterChartPoints(allPoints, chartRange);
  const chartTransactions = transactionsForChart(payload, points);
  renderChartIdentity(payload);
  if (points.length < 2) {
    syncChartLogToggle(false);
    document.getElementById("chartMeta").textContent = `${points.length} points`;
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">차트 데이터 없음</div>${renderChartCompareControls()}${renderChartRangeButtons()}`;
    bindChartCompareControls(payload);
    bindLineChartControls(payload);
    renderChartStats(payload);
    ensureChartStats(payload.ticker);
    return;
  }
  syncChartLogToggle(true);

  const values = points.map(point => Number(point.close));
  const markerValues = chartTransactions.map(tx => tx.price);
  // 로그 스케일은 모든 값이 양수일 때만 적용 (아니면 선형 폴백)
  const useLog = chartLogScale && [...values, ...markerValues].every(value => value > 0);
  const scale = useLog ? logChartScale([...values, ...markerValues]) : niceChartScale([...values, ...markerValues]);
  const min = scale.min;
  const max = scale.max;
  const first = values[0];
  const last = values[values.length - 1];
  const changePct = first ? (last - first) / first * 100 : null;
  const cls = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
  const arrow = changePct > 0 ? "▲" : changePct < 0 ? "▼" : "→";
  document.getElementById("chartMeta").innerHTML = `
    <span>${chartDateLabel(points[0].date)} - ${chartDateLabel(points[points.length - 1].date)}</span>
    <span>${points.length}일</span>
    <span class="${cls}">${arrow}${fmt2.format(Math.abs(changePct || 0))}%</span>
    <span>${chartMoney(last, payload.currency)}</span>
  `;

  const width = 980;
  const height = 408;
  const pad = { top: 28, right: 58, bottom: 32, left: 14 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const range = max - min || Math.max(1, Math.abs(max));
  const logMax = useLog ? Math.log10(max) : 0;
  const logSpan = useLog ? ((Math.log10(max) - Math.log10(min)) || 1) : 1;
  const xFor = index => pad.left + (points.length === 1 ? 0 : index / (points.length - 1) * plotW);
  const yFor = useLog
    ? (value => pad.top + (logMax - Math.log10(value)) / logSpan * plotH)
    : (value => pad.top + (max - value) / range * plotH);
  const line = smoothLinePath(points.map((point, index) => ({ x: xFor(index), y: yFor(Number(point.close)) })));
  const area = `${line} L${pad.left + plotW},${pad.top + plotH} L${pad.left},${pad.top + plotH} Z`;
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
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
      tooltip: `${tx.account || tx.member || "-"} · ${tx.side === "BUY" ? "매수" : "매도"} ${fmt2.format(tx.qty)}주 · ${chartMoney(tx.price, tx.currency || payload.currency)}`,
    };
  });
  const extremes = chartExtremes(values).map(item => {
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
      text: `${item.label} ${chartMoney(item.value, payload.currency)}`,
    };
  });

  document.getElementById("chartCanvas").innerHTML = `
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(payload.name)} 종가 차트">
      <defs>
        <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity=".18"></stop>
          <stop offset="72%" stop-color="var(--brand)" stop-opacity=".045"></stop>
          <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${width - 6}" y="${(tick.y + 4).toFixed(2)}">${esc(chartMoney(tick.value, payload.currency))}</text>
      `).join("")}
      ${vGrid.ticks.map(tick => `
        <line class="chart-grid perf-vgrid" x1="${tick.x.toFixed(2)}" x2="${tick.x.toFixed(2)}" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(2)}"></line>
      `).join("")}
      ${vGrid.ticks.map((tick, index) => {
        if (index % labelEvery !== 0) return "";
        const anchor = tick.x < pad.left + 18 ? "start" : tick.x > pad.left + plotW - 18 ? "end" : "middle";
        return `<text class="chart-x-label" x="${tick.x.toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${esc(perfGridLabel(tick.time, vGrid.unit))}</text>`;
      }).join("")}
      <path class="chart-area" d="${area}"></path>
      <path class="chart-line" d="${line}"></path>
      ${extremes.map(item => `
        <g class="chart-extreme ${item.kind}">
          <circle cx="${item.x.toFixed(2)}" cy="${item.y.toFixed(2)}" r="4"></circle>
          <text x="${item.labelX.toFixed(2)}" y="${item.labelY.toFixed(2)}" text-anchor="${item.anchor}">${esc(item.text)}</text>
        </g>
      `).join("")}
      <g id="chartSelectionGroup" class="chart-selection hidden">
        <rect id="chartSelectionRect" class="chart-selection-range" x="0" y="${pad.top}" width="0" height="${plotH}"></rect>
        <line id="chartSelectionStartLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        <line id="chartSelectionEndLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        <rect id="chartSelectionTooltipBox" class="chart-selection-box" x="0" y="0" width="0" height="0" rx="5"></rect>
        <text id="chartSelectionTooltip" class="chart-selection-tooltip" x="0" y="0"></text>
      </g>
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      ${markers.map(marker => `
        <g class="trade-marker ${marker.cls}" data-x="${marker.x.toFixed(2)}" data-y="${marker.y.toFixed(2)}" data-tooltip="${esc(marker.tooltip)}" tabindex="0" role="img" aria-label="${esc(marker.tooltip)}">
          <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="5"></circle>
        </g>
      `).join("")}
      <circle class="chart-last-dot" cx="${xFor(points.length - 1).toFixed(2)}" cy="${yFor(last).toFixed(2)}" r="4"></circle>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        <circle id="chartHoverDot" class="chart-hover-dot" cx="0" cy="0" r="4"></circle>
        <rect id="chartTooltipBox" class="chart-tooltip-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartTooltip" class="chart-tooltip" x="0" y="0">-</text>
      </g>
    </svg>
    ${renderChartCompareControls()}
    ${renderChartRangeButtons()}
  `;
  bindChartInteractions(points, payload, { width, height, pad, plotW, plotH, xFor, yFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
  renderChartStats(payload);
  ensureChartStats(payload.ticker);
}

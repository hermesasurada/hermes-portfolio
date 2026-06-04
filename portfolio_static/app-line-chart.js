function chartMoney(value, currency) {
  if (!Number.isFinite(value)) return "-";
  return unitMoney(value, currency).replace(/<[^>]+>/g, "");
}

function signedChartMoney(value, currency) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${chartMoney(Math.abs(value), currency)}`;
}

function chartDateLabel(dateText) {
  if (!dateText) return "-";
  const text = String(dateText);
  return text.length >= 10 ? text.slice(2, 10).replaceAll("-", ".") : text;
}

function chartFullDateLabel(dateText) {
  if (!dateText) return "-";
  const text = String(dateText);
  return text.length >= 10 ? text.slice(0, 10).replaceAll("-", ".") : text;
}

function chartDateObject(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) return null;
  const date = new Date(`${dateText}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function chartRangeStartDate(points, rangeKey) {
  const lastDateText = points[points.length - 1]?.date;
  if (!lastDateText) return null;
  const lastDate = new Date(`${lastDateText}T00:00:00`);
  if (Number.isNaN(lastDate.getTime())) return null;
  if (rangeKey === "ytd") {
    return new Date(lastDate.getFullYear(), 0, 1);
  }
  const range = chartRanges.find(item => item.key === rangeKey) || chartRanges.find(item => item.key === "1y");
  const start = new Date(lastDate);
  start.setMonth(start.getMonth() - (range.months || 12));
  return start;
}

function chartRangeBounds(points, rangeKey) {
  if (rangeKey === "custom") {
    return {
      startDate: chartDateObject(chartCustomRange.start),
      endDate: chartDateObject(chartCustomRange.end),
    };
  }
  return {
    startDate: chartRangeStartDate(points, rangeKey),
    endDate: null,
  };
}

function filterChartPoints(points, rangeKey) {
  if (!points.length) return points;
  const { startDate, endDate } = chartRangeBounds(points, rangeKey);
  if (!startDate && !endDate) return points;
  const filtered = points.filter(point => {
    const date = new Date(`${point.date}T00:00:00`);
    return (!startDate || date >= startDate) && (!endDate || date <= endDate);
  });
  if (rangeKey === "custom") return filtered;
  return filtered.length >= 2 ? filtered : points.slice(-Math.min(points.length, 2));
}

function niceChartStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / power;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * power;
}

function niceChartScale(values, desiredTicks = 5) {
  const cleanValues = values.filter(value => Number.isFinite(value));
  if (!cleanValues.length) return { min: 0, max: 1, ticks: [0, .25, .5, .75, 1] };
  const rawMin = Math.min(...cleanValues);
  const rawMax = Math.max(...cleanValues);
  const rawRange = rawMax - rawMin || Math.max(1, Math.abs(rawMax));
  const paddedMin = rawMin - rawRange * 0.05;
  const paddedMax = rawMax + rawRange * 0.12;
  const step = niceChartStep((paddedMax - paddedMin) / Math.max(1, desiredTicks - 1));
  const min = Math.floor(paddedMin / step) * step;
  const max = Math.ceil(paddedMax / step) * step;
  const ticks = [];
  for (let value = min; value <= max + step / 2; value += step) {
    ticks.push(Math.abs(value) < step / 1_000_000 ? 0 : value);
  }
  return { min, max, ticks };
}

function transactionsForChart(payload, points) {
  const start = points[0]?.date;
  const end = points[points.length - 1]?.date;
  if (!start || !end) return [];
  return (payload.transactions || [])
    .filter(tx => tx.date >= start && tx.date <= end && Number.isFinite(Number(tx.price)))
    .map(tx => ({ ...tx, price: Number(tx.price), qty: Number(tx.qty || 0) }));
}

function nearestPointIndex(points, dateText) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  const target = new Date(`${dateText}T00:00:00`).getTime();
  points.forEach((point, index) => {
    const distance = Math.abs(new Date(`${point.date}T00:00:00`).getTime() - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function chartLocalDateText(time) {
  const date = new Date(time);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function indexedChartVerticalGrid(points, xFor, rangeKey) {
  if (points.length < 2) return { unit: "month", ticks: [] };
  const minTime = new Date(`${points[0].date}T00:00:00`).getTime();
  const maxTime = new Date(`${points[points.length - 1].date}T00:00:00`).getTime();
  const grid = perfVerticalGrid(minTime, maxTime, rangeKey);
  const seen = new Set();
  const ticks = grid.lines
    .map(time => {
      const date = chartLocalDateText(time);
      const index = nearestPointIndex(points, date);
      if (seen.has(index)) return null;
      seen.add(index);
      return { time, index, x: xFor(index), date: points[index].date };
    })
    .filter(Boolean);
  if (ticks.length) return { unit: grid.unit, ticks };
  return {
    unit: grid.unit,
    ticks: [0, points.length - 1]
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .map(index => ({
        time: new Date(`${points[index].date}T00:00:00`).getTime(),
        index,
        x: xFor(index),
        date: points[index].date,
      })),
  };
}

function chartExtremes(values) {
  if (!values.length) return [];
  const highIndex = values.reduce((best, value, index) => value > values[best] ? index : best, 0);
  const lowIndex = values.reduce((best, value, index) => value < values[best] ? index : best, 0);
  return [
    { kind: "high", label: "고점", index: highIndex, value: values[highIndex] },
    { kind: "low", label: "저점", index: lowIndex, value: values[lowIndex] },
  ].filter((item, index, items) => index === 0 || item.index !== items[0].index);
}

function renderChartRangeButtons() {
  return `
    <div class="chart-ranges" role="group" aria-label="차트 기간">
      ${chartRanges.map(range => `
        <button class="chart-range-btn ${range.key === chartRange ? "active" : ""}" type="button" data-chart-range="${range.key}">${range.label}</button>
      `).join("")}
      <button class="chart-range-btn ${chartRange === "custom" ? "active" : ""}" type="button" data-chart-custom>직접설정</button>
    </div>
  `;
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

  const tile = ([label, value]) => `<div class="cstat"><span class="cstat-k">${esc(label)}</span><span class="cstat-v">${value}</span></div>`;
  const basic = [
    ["시가총액", mcap],
    ["배당", dividendYieldText(s.dividend_yield)],
    ["β", betaText(s.beta)],
    ["β″", betaText(s.beta_adj)],
    ["P/E", peText(s.trailing_pe)],
    ["선행 P/E", peText(s.forward_pe)],
    ["실적일", earningsText(s.next_earnings_date)],
  ];
  const perfItems = [
    ["1개월", signedPercentText(perf.one_month, 1)],
    ["3개월", signedPercentText(perf.three_month, 0)],
    ["6개월", signedPercentText(perf.six_month, 0)],
    ["YTD", signedPercentText(perf.ytd, 0)],
    ["1년", signedPercentText(perf.one_year, 0)],
    ["3년", signedPercentText(perf.three_year, 0)],
    ["5년", signedPercentText(perf.five_year, 0)],
  ];

  el.innerHTML = `
    <div class="cstat-block">
      <h4>기본 지표</h4>
      <div class="cstat-grid">${basic.map(tile).join("")}</div>
    </div>
    <div class="cstat-block">
      <h4>기술 지표 <span class="cstat-sub">일 · 주 · 월</span></h4>
      <table class="cstat-matrix">
        <thead><tr><th scope="col"></th><th scope="col">일</th><th scope="col">주</th><th scope="col">월</th></tr></thead>
        <tbody>
          <tr><th scope="row">RSI</th><td>${indicatorText(rsi.day, "rsi")}</td><td>${indicatorText(rsi.week, "rsi")}</td><td>${indicatorText(rsi.month, "rsi")}</td></tr>
          <tr><th scope="row">BB %B</th><td>${indicatorText(bb.day, "bb")}</td><td>${indicatorText(bb.week, "bb")}</td><td>${indicatorText(bb.month, "bb")}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="cstat-block">
      <h4>기간 수익률</h4>
      <div class="cstat-grid cstat-grid-perf">${perfItems.map(tile).join("")}</div>
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

function chartCompareSeries(payload) {
  return [payload, ...chartComparePayloads].map((item, index) => {
    const rawPoints = (item.points || [])
      .filter(point => point.date && Number.isFinite(Number(point.close)))
      .map(point => ({ date: point.date, value: Number(point.close) }));
    const filtered = filterChartPoints(rawPoints.map(point => ({ date: point.date, close: point.value })), chartRange)
      .map(point => ({
        date: point.date,
        value: Number(point.close),
        time: new Date(`${point.date}T00:00:00`).getTime(),
      }));
    if (filtered.length < 2) return null;
    const base = filtered.find(point => point.value > 0)?.value;
    if (!base) return null;
    return {
      key: String(item.ticker || `compare-${index}`).toUpperCase(),
      ticker: String(item.ticker || "").toUpperCase(),
      name: item.name || item.ticker,
      color: chartCompareColors[index % chartCompareColors.length],
      primary: index === 0,
      points: filtered.map(point => ({
        ...point,
        close: (point.value / base - 1) * 100,
      })),
    };
  }).filter(Boolean);
}

function renderChartCompareControls() {
  return `
    <div class="chart-compare-panel">
      <div class="chart-compare-add">
        <input id="chartCompareInput" placeholder="티커 직접 입력" autocomplete="off" spellcheck="false">
        <button class="ghost-btn" id="chartCompareAdd" type="button">추가</button>
      </div>
      <div class="chart-compare-list">
        ${chartComparePayloads.map(item => `
          <span class="compare-chip">
            ${esc(item.ticker)} · ${esc(item.name || item.ticker)}
            <button type="button" data-compare-remove="${esc(item.ticker)}" aria-label="${esc(item.ticker)} 삭제">&times;</button>
          </span>
        `).join("") || `<span class="compare-empty">비교 종목 없음</span>`}
      </div>
    </div>
  `;
}

function bindChartCompareControls(payload) {
  const input = document.getElementById("chartCompareInput");
  const add = document.getElementById("chartCompareAdd");
  if (add && input) {
    add.addEventListener("click", () => addChartCompareTicker(input.value));
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        addChartCompareTicker(input.value);
      }
    });
  }
  document.querySelectorAll("[data-compare-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const ticker = btn.dataset.compareRemove;
      chartComparePayloads = chartComparePayloads.filter(item => item.ticker !== ticker);
      renderLineChart(payload);
    });
  });
}

async function addChartCompareTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  if (!ticker || ticker === chartTicker) return;
  if (chartComparePayloads.some(item => item.ticker === ticker)) return;
  if (chartComparePayloads.length >= chartCompareLimit) {
    showTradeStatus(`비교 종목은 최대 ${chartCompareLimit}개까지 추가할 수 있습니다.`, true);
    return;
  }
  const input = document.getElementById("chartCompareInput");
  if (input) input.value = "";
  try {
    const payload = await apiFetchChart(ticker);
    const pricedPoints = (payload.points || []).filter(point => point.date && Number.isFinite(Number(point.close)));
    if (pricedPoints.length < 2) {
      showTradeStatus(`${ticker} 가격 이력이 없습니다.`, true);
      return;
    }
    chartComparePayloads = [...chartComparePayloads, payload];
    renderLineChart(chartPayload);
  } catch (err) {
    showTradeStatus(err.message || String(err), true);
  }
}

function bindCompareHover(series, geometry) {
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
    tooltipBox.setAttribute("x", (bbox.x - 8).toFixed(2));
    tooltipBox.setAttribute("y", (bbox.y - 6).toFixed(2));
    tooltipBox.setAttribute("width", (bbox.width + 16).toFixed(2));
    tooltipBox.setAttribute("height", (bbox.height + 12).toFixed(2));
  };
  const showPoint = clientX => {
    const rect = svg.getBoundingClientRect();
    const svgX = (clientX - rect.left) / rect.width * geometry.width;
    const ratio = Math.min(1, Math.max(0, (svgX - geometry.pad.left) / geometry.plotW));
    const targetTime = geometry.minTime + ratio * (geometry.maxTime - geometry.minTime);
    const x = geometry.xForTime(targetTime);
    const mainPoint = nearest(series[0]?.points || [], targetTime);
    const dateText = mainPoint?.date || new Date(targetTime).toISOString().slice(0, 10);
    hoverGroup.classList.remove("hidden");
    hoverLine.setAttribute("x1", x.toFixed(2));
    hoverLine.setAttribute("x2", x.toFixed(2));
    series.forEach(item => {
      const dot = document.getElementById(`compareDot-${item.key}`);
      const point = nearest(item.points, targetTime);
      if (!dot || !point) return;
      dot.setAttribute("cx", x.toFixed(2));
      dot.setAttribute("cy", geometry.yFor(point.close).toFixed(2));
      dot.style.display = "";
    });
    tooltip.textContent = "";
    const tx = x > geometry.width - 250 ? x - 176 : x + 14;
    [
      chartFullDateLabel(dateText),
      ...series.map(item => {
        const point = nearest(item.points, targetTime);
        return `${item.ticker || item.name} ${pctChartLabel(point?.close)}`;
      }),
    ].forEach((line, index) => {
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttribute("x", tx.toFixed(2));
      tspan.setAttribute("dy", index === 0 ? "0" : "11");
      tspan.textContent = line;
      tooltip.appendChild(tspan);
    });
    tooltip.setAttribute("x", tx.toFixed(2));
    tooltip.setAttribute("y", geometry.pad.top + 14);
    updateTooltipBox();
  };
  hoverLayer.addEventListener("pointermove", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerenter", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerleave", () => hoverGroup.classList.add("hidden"));
}

function renderCompareLineChart(payload) {
  const series = chartCompareSeries(payload);
  renderChartIdentity(payload);
  const statsEl = document.getElementById("chartStats");
  if (statsEl) statsEl.innerHTML = "";   // 비교 모드에선 단일 종목 통계 숨김
  if (series.length < 2 || !series[0]?.points.length) {
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">비교 차트 데이터 없음</div>${renderChartCompareControls()}${renderChartRangeButtons()}`;
    bindChartCompareControls(payload);
    bindLineChartControls(payload);
    return;
  }
  const allPoints = series.flatMap(item => item.points);
  const minTime = Math.min(...allPoints.map(point => point.time));
  const maxTime = Math.max(...allPoints.map(point => point.time));
  const values = allPoints.map(point => point.close);
  const scale = niceChartScale([...values, 0]);
  const width = 980;
  const height = 420;
  const pad = { top: 28, right: 108, bottom: 34, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const min = scale.min;
  const max = scale.max;
  const range = max - min || 1;
  const xForTime = time => pad.left + (maxTime === minTime ? 0 : (time - minTime) / (maxTime - minTime) * plotW);
  const yFor = value => pad.top + (max - value) / range * plotH;
  const clampY = value => Math.max(pad.top + 4, Math.min(pad.top + plotH - 2, value));
  const pathFor = points => points.map((point, index) => `${index === 0 ? "M" : "L"}${xForTime(point.time).toFixed(2)},${yFor(point.close).toFixed(2)}`).join(" ");
  const main = series[0];
  const first = main.points[0];
  const last = main.points[main.points.length - 1];
  const cls = last.close > 0 ? "up" : last.close < 0 ? "down" : "flat";
  document.getElementById("chartMeta").innerHTML = `
    <span>${chartDateLabel(first.date)} - ${chartDateLabel(last.date)}</span>
    <span>비교 ${chartComparePayloads.length}개</span>
    <span class="${cls}">${pctChartLabel(last.close)}</span>
  `;
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
  const vGrid = perfVerticalGrid(minTime, maxTime, chartRange);
  const labelEvery = Math.max(1, Math.ceil(vGrid.lines.length / 8));
  const endLabels = series
    .map(item => {
      const lastPoint = item.points[item.points.length - 1];
      return { color: item.color, close: lastPoint.close, y: yFor(lastPoint.close) };
    })
    .sort((a, b) => a.y - b.y);
  const minGap = 13;
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < minGap) endLabels[i].y = endLabels[i - 1].y + minGap;
  }
  const legend = series.map(item => `<span class="perf-legend-item"><i style="background:${item.color}"></i>${esc(item.ticker || item.name)}</span>`).join("");
  document.getElementById("chartCanvas").innerHTML = `
    <div class="perf-chart-top">
      <div class="perf-legend">${legend}</div>
    </div>
    <svg class="line-chart compare-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(payload.name)} 비교 차트">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${pad.left - 8}" y="${(tick.y + 4).toFixed(2)}">${esc(pctChartLabel(tick.value))}</text>
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
      ${series.map(item => `<path class="perf-line ${item.primary ? "primary" : "index"}" d="${pathFor(item.points)}" style="stroke:${item.color}"></path>`).join("")}
      ${endLabels.map(label => `
        <text class="perf-end-label" x="${(pad.left + plotW + 7).toFixed(2)}" y="${(clampY(label.y) + 3.5).toFixed(2)}" style="fill:${label.color}">${esc(pctChartLabel(label.close))}</text>
      `).join("")}
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        ${series.map(item => `<circle id="compareDot-${item.key}" class="perf-hover-dot" r="3.6" cx="0" cy="0" style="stroke:${item.color}"></circle>`).join("")}
        <rect id="chartTooltipBox" class="chart-tooltip-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartTooltip" class="chart-tooltip perf-tooltip" x="0" y="0">-</text>
      </g>
    </svg>
    ${renderChartCompareControls()}
    ${renderChartRangeButtons()}
  `;
  bindCompareHover(series, { width, height, pad, plotW, plotH, minTime, maxTime, xForTime, yFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
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
    document.getElementById("chartMeta").textContent = `${points.length} points`;
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">차트 데이터 없음</div>${renderChartCompareControls()}${renderChartRangeButtons()}`;
    bindChartCompareControls(payload);
    bindLineChartControls(payload);
    renderChartStats(payload);
    ensureChartStats(payload.ticker);
    return;
  }

  const values = points.map(point => Number(point.close));
  const markerValues = chartTransactions.map(tx => tx.price);
  const scale = niceChartScale([...values, ...markerValues]);
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
  const xFor = index => pad.left + (points.length === 1 ? 0 : index / (points.length - 1) * plotW);
  const yFor = value => pad.top + (max - value) / range * plotH;
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(2)},${yFor(Number(point.close)).toFixed(2)}`).join(" ");
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
          <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="8"></circle>
          <text x="${marker.x.toFixed(2)}" y="${(marker.y + 4).toFixed(2)}">${marker.label}</text>
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

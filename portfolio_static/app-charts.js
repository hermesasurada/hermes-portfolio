// Performance chart rendering. Classic script loaded before app.js; shares
// the global scope and resolves state/helpers at call time.

function accountPerformanceTitle(payload) {
  const accounts = payload?.accounts || [];
  if (!accounts.length) return "선택 계좌 성과";
  if (accounts.length === 1) return `${accounts[0].member} · ${accounts[0].name} 성과`;
  return `${accounts.length}개 계좌 성과`;
}

// 범례는 차트(플롯) 영역 밖 — 캔버스 위 별도 호스트에 둔다.
function syncPerformanceLegendHost(html) {
  const host = document.getElementById("perfLegendHost");
  if (!host) return;
  host.innerHTML = html || "";
  host.classList.toggle("hidden", !html);
}

// 성과 타이틀은 차트 헤드가 아니라 툴바(목록·상세 버튼 우측)에 띄운다.
function syncPerformanceTitle(text) {
  const host = document.getElementById("performanceTitle");
  if (!host) return;
  host.textContent = text || "";
  host.classList.toggle("hidden", !text);
}

// 비교 지수 메타 — 범례와 시리즈 구성이 같은 정의를 공유한다.
// 빨강=상승/파랑=하락 시맨틱과 충돌하지 않도록 중립 비교색(보라·청록·앰버)
// 계좌 선(브랜드 블루, 색상환 221°)과 서로 최소 70° 이상 떨어진 색만 쓴다 —
// 예전 보라(#7c3aed, 273°)는 블루와 붙어 얇은 선에서 구분이 안 됐다.
// 상승=빨강 관례와 겹치지 않게 순수 red 계열은 피한다.
const PERF_INDEX_META = [
  ["SP500", "S&P 500", "#c026d3"],      // 292° 푸시아
  ["NIKKEI225", "니케이", "#0891b2"],    // 192° 시안
  ["NASDAQ", "나스닥", "#16a34a"],       // 142° 그린
  ["KOSPI", "코스피", "#d97706"],        // 32° 앰버
];

// useTwr: 계좌 선은 평가액 변화율이 아니라 시간가중 지수(point.twr, 백엔드 체인)로 %를 그린다.
// 평가액(point.value)은 호버 금액·끝 라벨용으로 그대로 들고 간다.
function normalizePerformancePoints(points, rangeKey, bounds = null, useTwr = false) {
  const raw = (points || [])
    .filter(point => point.date && Number.isFinite(Number(point.value)))
    .map(point => ({ date: point.date, value: Number(point.value), twr: Number.isFinite(Number(point.twr)) ? Number(point.twr) : null }));
  const startDate = bounds?.startDate || null;
  const endDate = bounds?.endDate || null;
  const filtered = startDate || endDate
    ? raw.filter(point => {
        const date = new Date(`${point.date}T00:00:00`);
        return (!startDate || date >= startDate) && (!endDate || date <= endDate);
      })
    : filterChartPoints(raw.map(point => ({ date: point.date, close: point.value, twr: point.twr })), rangeKey)
        .map(point => ({ date: point.date, value: Number(point.close), twr: point.twr }));
  if (filtered.length < 2) return [];
  const twrReady = useTwr && filtered.every(point => point.twr != null && point.twr > 0);
  const base = twrReady ? filtered[0].twr : filtered.find(point => point.value > 0)?.value;
  if (!base) return [];
  return filtered.map(point => ({
    date: point.date,
    close: ((twrReady ? point.twr : point.value) / base - 1) * 100,
    value: point.value,
    time: new Date(`${point.date}T00:00:00`).getTime(),
  }));
}

function performanceTwrLabel(payload) {
  if (!payload?.twr_basis) return "";
  return payload.twr_basis === "full" ? " · 시간가중" : " · 시간가중(증권 기준)";
}

function performanceValueText(point) {
  const value = Number(point?.value);
  return Number.isFinite(value) ? krwShort(value) : "";
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
      points: normalizePerformancePoints(portfolioRaw, chartRange, bounds, true),
      primary: true,
      amount: true,
    },
  ];
  if (performanceDetailEnabled() && accountSeries.length > 1) {
    accountSeries.forEach((account, index) => {
      series.push({
        key: `account-${account.id}`,
        name: account.name || `계좌 ${index + 1}`,
        color: chartCompareColors[(index + 1) % chartCompareColors.length],
        points: normalizePerformancePoints(account.points || [], chartRange, bounds, true),
        primary: false,
        detail: true,
        amount: true,
      });
    });
  }
  PERF_INDEX_META.forEach(([key, label, color]) => {
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

// 범례 = 색 표시 + 지수 on/off 한 줄. 계좌 선은 정보 칩(고정), 비교 지수는
// 끄든 켜든 항상 자리에 있고 클릭으로 토글된다(꺼진 것도 보여야 다시 켤 수 있다).
function renderPerformanceLegend(series = []) {
  const indexKeys = new Set(PERF_INDEX_META.map(([key]) => key));
  const accountChips = series
    .filter(item => !indexKeys.has(item.key))
    .map(item => `<span class="perf-legend-item"><i style="background:${item.color}"></i>${esc(item.name)}</span>`)
    .join("");
  const indexChips = PERF_INDEX_META
    .map(([key, label, color]) => {
      const on = !!performanceIndexes[key];
      // 꺼짐은 점까지 회색 — 색이 남아 있으면 켜진 것처럼 보인다
      return `<button class="perf-legend-item perf-index-toggle${on ? " active" : ""}" type="button" data-index="${key}" aria-pressed="${on ? "true" : "false"}" title="${esc(label)} ${on ? "숨기기" : "표시"}"><i style="background:${on ? color : "var(--chart-axis)"}"></i>${esc(label)}</button>`;
    })
    .join("");
  return `<div class="perf-legend" role="group" aria-label="차트 선 표시">${accountChips}${indexChips}</div>`;
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
      const value = item.amount ? performanceValueText(point) : "";
      return `<div class="ct-row simple perf-tooltip-row${item.amount ? " with-value" : ""}"><span class="ct-name" style="color:${item.color}">${esc(item.name)}</span><span class="ct-pct ${cls}">${esc(pctChartLabel(point.close))}</span><span class="ct-value">${esc(value)}</span></div>`;
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
  if (typeof syncChartBottomControls === "function") syncChartBottomControls(true);
  // syncChartLogToggle은 곧 syncChartDisplayControls라 인자가 그대로 표시 여부가 된다.
  // 예전엔 false를 넘겨 컨트롤 묶음을 통째로 숨겼지만, 이제 성과차트도 '부드럽게'를
  // 쓰므로 켜 둔다(로그·BB·일목 등 개별 버튼은 sync 안에서 성과일 때 숨긴다).
  if (typeof syncChartDisplayControls === "function") syncChartDisplayControls(true);
  const statsEl = document.getElementById("chartStats");
  if (statsEl) statsEl.innerHTML = "";   // 성과 차트엔 종목별 지표 패널 숨김
  document.getElementById("chartIcon").innerHTML = `<span class="asset-icon">%</span>`;
  document.getElementById("chartTicker").textContent = "성과";
  document.getElementById("chartName").textContent = "";
  syncPerformanceTitle(accountPerformanceTitle(payload));
  const priceSummary = document.getElementById("chartPriceSummary");
  if (priceSummary) priceSummary.innerHTML = "";
  if (typeof clearChartExternalLinks === "function") clearChartExternalLinks();

  if (!series.length || !series[0]?.points.length) {
    document.getElementById("chartMeta").textContent = `${payload?.holdings_count || 0}개 종목`;
    syncPerformanceLegendHost(renderPerformanceLegend());
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">성과 차트 데이터 없음</div>`;
    renderChartRangeControls();
    bindPerformanceChartControls();
    return;
  }

  const allPoints = series.flatMap(item => item.points);
  const minTime = Math.min(...allPoints.map(point => point.time));
  const maxTime = Math.max(...allPoints.map(point => point.time));
  const values = allPoints.map(point => point.close);
  const scale = tightChartScale(values);
  const min = scale.min;
  const max = scale.max;
  const width = 980;
  const isMobileChart = Boolean(window.matchMedia?.("(max-width: 980px)")?.matches);
  const height = isMobileChart ? 864 : 432;
  // 우측은 % 끝라벨만 — 금액은 호버 툴팁에서 본다(여백을 넓게 먹던 원인)
  const pad = { top: 22, right: 74, bottom: 22, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const range = max - min || 1;
  const xForTime = time => pad.left + (maxTime === minTime ? 0 : (time - minTime) / (maxTime - minTime) * plotW);
  const yFor = value => pad.top + (max - value) / range * plotH;
  const clampY = value => Math.max(pad.top + 4, Math.min(pad.top + plotH - 2, value));
  const pathFor = points => chartLinePath(points.map(point => ({ x: xForTime(point.time), y: yFor(point.close) })));
  const portfolio = series[0];
  const lastPoint = portfolio.points[portfolio.points.length - 1];
  document.getElementById("chartMeta").textContent = "";
  const tickLabel = value => `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.round(Math.abs(value))}%`;
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
  const vGrid = perfVerticalGrid(minTime, maxTime, chartRange);
  const labelEvery = Math.max(1, Math.ceil(vGrid.lines.length / 8));
  // (#3) per-line total performance shown at each line's right end, de-collided vertically
  const endLabels = declutterChartLabels(series
    .map(item => {
      const lastPoint = item.points[item.points.length - 1];
      const last = lastPoint.close;
      return {
        color: item.color,
        close: last,
        value: "",
        y: yFor(last),
      };
    })
    , 13);
  // 끝라벨은 소수 첫째 자리까지 — 축·툴팁과 달리 선 옆에 붙어 자리가 좁다
  const endPct = value => `${value > 0 ? "+" : value < 0 ? "-" : ""}${fmt1.format(Math.abs(value))}%`;
  // (#3) 범례에 색·이름만 두고 %는 선 끝으로. 지수 on/off도 이 범례가 겸한다.
  syncPerformanceLegendHost(renderPerformanceLegend(series));
  document.getElementById("chartCanvas").innerHTML = `
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
        return `<text class="chart-x-label" x="${x.toFixed(2)}" y="${height - 6}" text-anchor="${anchor}">${esc(perfGridLabel(time, vGrid.unit))}</text>`;
      }).join("")}
      ${series.map(item => `
        <path class="perf-line ${item.primary ? "primary" : "index"}" d="${pathFor(item.points)}" style="stroke:${item.color}"></path>
      `).join("")}
      ${endLabels.map(label => `
        <text class="perf-end-label" x="${(pad.left + plotW + 7).toFixed(2)}" y="${(clampY(label.y) + 3.5).toFixed(2)}" style="fill:${label.color}">${esc(endPct(label.close))}</text>
      `).join("")}
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        ${series.map(item => `<circle id="perfDot-${item.key}" class="perf-hover-dot" r="3.6" cx="0" cy="0" style="stroke:${item.color}"></circle>`).join("")}
      </g>
    </svg>
    <div id="compareTooltip" class="compare-tooltip hidden" aria-hidden="true"></div>
  `;
  renderChartRangeControls();
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
      if (btn.dataset.chartRangePopup != null || btn.dataset.chartCustom != null) {
        openChartRangeModal();
        return;
      }
      chartRange = btn.dataset.chartRange || DEFAULT_CHART_RANGE;
      reloadPerformanceChart();
    });
  });
}

function performanceRequestOptions() {
  return {
    detail: performanceDetailEnabled(),
    range: chartRange,
    start: chartRange === "custom" ? chartCustomRange.start : "",
    end: chartRange === "custom" ? chartCustomRange.end : "",
  };
}

async function reloadPerformanceChart({ skeleton = false } = {}) {
  if (!performanceChartOpen) return;
  const accounts = visibleAccounts();
  const allAccounts = selectionMode === "all";
  const token = ++performanceLoadToken;
  if (skeleton) {
    document.getElementById("chartMeta").textContent = "loading...";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  }
  const request = apiFetchAccountPerformance(
    accounts.map(account => account.id),
    allAccounts,
    performanceRequestOptions(),
  );
  performanceLoadInFlight = request;
  try {
    const payload = await request;
    if (!performanceChartOpen || token !== performanceLoadToken) return;
    renderPerformanceChart(payload);
  } catch (err) {
    if (!performanceChartOpen || token !== performanceLoadToken) return;
    document.getElementById("chartMeta").textContent = "";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">${esc(err.message || String(err))}</div>`;
  } finally {
    if (token === performanceLoadToken) performanceLoadInFlight = null;
  }
}

async function openPerformanceChart() {
  performanceChartOpen = true;
  discardHiddenListRowsForChart();
  syncTransactionPanel();
  chartTicker = null;
  chartPayload = null;
  syncDetailTabs();
  document.getElementById("chartIcon").innerHTML = `<span class="asset-icon">%</span>`;
  document.getElementById("chartTicker").textContent = "성과";
  document.getElementById("chartName").textContent = "";
  syncPerformanceTitle("계좌 성과");
  if (typeof clearChartExternalLinks === "function") clearChartExternalLinks();
  const perfPriceSummary = document.getElementById("chartPriceSummary");
  if (perfPriceSummary) perfPriceSummary.innerHTML = "";
  const perfRangeHost = document.getElementById("chartRangeHost");
  if (perfRangeHost) perfRangeHost.innerHTML = "";
  document.getElementById("chartMeta").textContent = "loading...";
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  await reloadPerformanceChart();
}

function priceChartRequestOptions() {
  return {
    range: chartRange,
    start: chartRange === "custom" ? chartCustomRange.start : "",
    end: chartRange === "custom" ? chartCustomRange.end : "",
  };
}

function discardHiddenListRowsForChart() {
  const holdings = document.getElementById("holdings");
  const interest = document.getElementById("interestRows");
  if (holdings) holdings.innerHTML = "";
  if (interest) interest.innerHTML = "";
}

async function openChart(ticker) {
  const cleanTicker = String(ticker || "").trim().toUpperCase();
  if (!cleanTicker) return;
  // 같은 티커를 이미 로딩 중이면 재진입 무시 (연타·중복 클릭 시 fetch 중복 방지)
  if (chartTicker === cleanTicker && chartLoadInFlight) return;
  performanceChartOpen = false;
  performanceLoadToken += 1;
  syncPerformanceTitle("");   // 성과 → 종목 차트로 넘어갈 때 툴바 타이틀도 함께 내린다
  syncPerformanceLegendHost("");
  if (chartTicker !== cleanTicker) chartComparePayloads = [];
  chartTicker = cleanTicker;
  discardHiddenListRowsForChart();
  syncTransactionPanel();
  syncDetailTabs();
  document.getElementById("tableTitle").textContent = cleanTicker;
  renderChartIdentity({ ticker: cleanTicker, name: cleanTicker });
  const rangeHost = document.getElementById("chartRangeHost");
  if (rangeHost) rangeHost.innerHTML = "";
  document.getElementById("chartMeta").textContent = "loading...";
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  chartLoadInFlight = apiFetchChart(cleanTicker, usExtendedEnabled(), priceChartRequestOptions());
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

async function reloadPriceChartForMarketMode({ skeleton = false } = {}) {
  const cleanTicker = String(chartTicker || "").trim().toUpperCase();
  if (!cleanTicker || performanceChartOpen) return;
  const compareTickers = chartComparePayloads
    .map(item => String(item?.ticker || "").trim().toUpperCase())
    .filter(Boolean);
  if (skeleton) {
    document.getElementById("chartMeta").textContent = "loading...";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  }
  const options = priceChartRequestOptions();
  chartLoadInFlight = apiFetchChart(cleanTicker, usExtendedEnabled(), options);
  try {
    const payloads = await Promise.all([
      chartLoadInFlight,
      ...compareTickers.map(ticker => apiFetchChart(ticker, usExtendedEnabled(), options)),
    ]);
    if (chartTicker !== cleanTicker) return;
    chartPayload = payloads[0];
    chartComparePayloads = payloads.slice(1);
    document.getElementById("tableTitle").textContent = chartPayload.name || chartPayload.ticker;
    renderLineChart(chartPayload);
  } catch (err) {
    if (chartTicker !== cleanTicker) return;
    document.getElementById("chartMeta").textContent = "";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">${esc(err.message || String(err))}</div>`;
  } finally {
    chartLoadInFlight = null;
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
  syncPerformanceTitle("");
  syncPerformanceLegendHost("");
  if (updateHash && (location.hash.startsWith("#chart=") || location.hash === "#performance")) {
    history.pushState(null, "", location.pathname + location.search);
  }
  renderTable();
}

function syncChartRoute() {
  if (performanceChartFromHash()) {
    openPerformanceChart();
    return;
  }
  const ticker = chartTickerFromHash();
  if (ticker) openChart(ticker);
  else if (chartTicker || performanceChartOpen) closeChart(false);
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-charts");

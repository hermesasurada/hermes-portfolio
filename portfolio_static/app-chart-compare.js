// 비교(compare) 차트 전용: 공통기간·시리즈·범례·검색추가·호버툴팁·렌더. app-line-chart.js에서 분리.
// 비교 대상(메인+추가) 전 종목이 데이터를 갖는 공통 시작 시각 (가장 늦은 최초가용일).
// 비교 모드에서 이보다 긴 기간 옵션은 사용 불가 → 비활성화 판정에 사용.
function compareCommonStartTime() {
  const payloads = [chartPayload, ...chartComparePayloads].filter(Boolean);
  const starts = payloads.map(item => {
    const pts = aggregateChartPoints(item.points || [])
      .filter(point => point.date && Number.isFinite(Number(point.close)) && Number(point.close) > 0);
    return pts.length ? new Date(`${pts[0].date}T00:00:00`).getTime() : null;
  }).filter(value => value != null);
  return starts.length ? Math.max(...starts) : null;
}

function compareAvailableMonths() {
  const start = compareCommonStartTime();
  if (!start) return Infinity;
  return (Date.now() - start) / (1000 * 60 * 60 * 24 * 30.44);
}

function chartCompareSeries(payload) {
  // 종목별 양수 가격 시계열
  const raw = [payload, ...chartComparePayloads].map((item, index) => {
    const pts = aggregateChartPoints(item.points || [])
      .filter(point => point.date && Number.isFinite(Number(point.close)) && Number(point.close) > 0)
      .map(point => ({
        date: point.date,
        value: Number(point.close),
        rsi: point.rsi != null && Number.isFinite(Number(point.rsi)) ? Number(point.rsi) : null,
        time: new Date(`${point.date}T00:00:00`).getTime(),
      }));
    return { item, index, pts };
  }).filter(entry => entry.pts.length >= 2);
  if (!raw.length) return [];

  // 상장일 차이 보정: 모든 종목이 데이터를 갖는 공통 시작 = 가장 늦은 최초가용일
  const commonStartTime = Math.max(...raw.map(entry => entry.pts[0].time));
  const mainRangePoints = raw[0].pts.map(point => ({ date: point.date, close: point.value }));
  let startTime = commonStartTime;
  let endTime = Infinity;
  if (chartRange === "custom") {
    const bounds = chartRangeBounds(mainRangePoints, "custom");
    if (bounds.startDate) startTime = Math.max(commonStartTime, bounds.startDate.getTime());
    if (bounds.endDate) endTime = bounds.endDate.getTime();
  } else if (chartRange !== "cmax" && chartRange !== "all") {
    const sd = chartRangeStartDate(mainRangePoints, chartRange);
    if (sd) startTime = Math.max(commonStartTime, sd.getTime());
  }
  // chartRange가 'cmax'/'all'이면 startTime = commonStartTime (전체 공통기간)

  return raw.map(({ item, index, pts }) => {
    const windowed = pts.filter(point => point.time >= startTime && point.time <= endTime);
    if (windowed.length < 2) return null;
    const base = windowed[0].value;
    if (!base) return null;
    return {
      key: String(item.ticker || `compare-${index}`).toUpperCase(),
      ticker: String(item.ticker || "").toUpperCase(),
      name: item.name || item.ticker,
      currency: item.currency || "USD",
      logo: chartLogoRow(item).logo,
      color: chartCompareColors[index % chartCompareColors.length],
      primary: index === 0,
      points: windowed.map(point => ({
        date: point.date,
        time: point.time,
        value: point.value,                          // 원주가
        close: (point.value / base - 1) * 100,       // 공통 기준일 대비 %
        rsi: point.rsi,
      })),
    };
  }).filter(Boolean);
}

function renderChartCompareControls() {
  // 추가된 비교 종목은 상단 범례에서 표시·삭제 (여기는 검색·추가만)
  return `
    <div class="chart-compare-panel">
      <div class="chart-compare-add">
        <input id="chartCompareInput" placeholder="비교 종목 검색 (티커·종목명)" autocomplete="off" spellcheck="false" list="compareTickerOptions">
        <datalist id="compareTickerOptions"></datalist>
        <button class="ghost-btn" id="chartCompareAdd" type="button">추가</button>
      </div>
    </div>
  `;
}

let compareTickerDirectoryCache = null;
async function populateCompareDatalist() {
  const list = document.getElementById("compareTickerOptions");
  if (!list) return;
  try {
    if (!compareTickerDirectoryCache) {
      const payload = await apiFetchTickerDirectory();
      compareTickerDirectoryCache = payload.tickers || [];
    }
  } catch {
    compareTickerDirectoryCache = compareTickerDirectoryCache || [];
  }
  // 이미 비교에 추가됐거나 메인인 종목은 제외
  const used = new Set([String(chartTicker || "").toUpperCase(), ...chartComparePayloads.map(item => String(item.ticker || "").toUpperCase())]);
  list.innerHTML = compareTickerDirectoryCache
    .filter(item => !used.has(String(item.ticker || "").toUpperCase()))
    .map(item => {
      const aliases = Array.isArray(item.aliases) && item.aliases.length ? ` · ${item.aliases.join(", ")}` : "";
      return `<option value="${esc(item.ticker)}">${esc(item.ticker)} · ${esc(item.name)}${esc(aliases)}</option>`;
    })
    .join("");
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
    populateCompareDatalist();
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
  if (!compareTickerDirectoryCache) {
    try {
      const payload = await apiFetchTickerDirectory();
      compareTickerDirectoryCache = payload.tickers || [];
    } catch {
      compareTickerDirectoryCache = compareTickerDirectoryCache || [];
    }
  }
  const ticker = resolveTickerFromDirectory(value, compareTickerDirectoryCache);
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
      const dot = document.getElementById(`compareDot-${item.key}`);
      const rsiDot = document.getElementById(`compareRsiDot-${item.key}`);
      const point = nearestChartPoint(item.points, targetTime);
      if (!dot || !point) return;
      dot.setAttribute("cx", x.toFixed(2));
      dot.setAttribute("cy", geometry.yFor(point.close).toFixed(2));
      dot.style.display = "";
      if (rsiDot && Number.isFinite(point.rsi)) {
        rsiDot.setAttribute("cx", x.toFixed(2));
        rsiDot.setAttribute("cy", geometry.rsiYFor(point.rsi).toFixed(2));
        rsiDot.style.display = "";
      } else if (rsiDot) {
        rsiDot.style.display = "none";
      }
    });
    // HTML 툴팁: 로고 + 기업명(선 색) + 등락% + 주가
    const rows = series.map(item => {
      const point = nearestChartPoint(item.points, targetTime);
      if (!point) return "";
      const logo = item.logo;
      const logoHtml = logo && logo.url
        ? `<img class="ct-logo${logo.dark ? " dark-logo" : ""}" src="${esc(logo.url)}" alt="">`
        : `<span class="ct-logo ct-logo-dot" style="background:${item.color}"></span>`;
      const pctCls = point.close > 0 ? "up" : point.close < 0 ? "down" : "flat";
      return `<div class="ct-row">
        ${logoHtml}
        <span class="ct-name" style="color:${item.color}">${esc(item.ticker || item.name)}</span>
        <span class="ct-pct ${pctCls}">${esc(pctChartLabel(point.close))}</span>
        <span class="ct-price">${chartMoney(point.value, item.currency, item.ticker)}</span>
        <span class="ct-rsi">${Number.isFinite(point.rsi) ? `RSI ${point.rsi.toFixed(1)}` : "RSI -"}</span>
      </div>`;
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

function renderCompareLineChart(payload) {
  // 선택된 기간이 공통 가용기간을 초과하면 '최대'로 자동 보정 (해당 버튼은 비활성)
  const currentRange = chartRanges.find(range => range.key === chartRange);
  if (currentRange && currentRange.months && currentRange.months > compareAvailableMonths() + 0.5) chartRange = "cmax";
  const series = chartCompareSeries(payload);
  renderChartIdentity(payload);
  clearChartExternalLinks();   // 비교 모드에선 단일 종목 바로가기 숨김
  syncChartLogToggle(true);   // 비교 차트도 로그 지원 (비율 기준)
  renderCompareChartStats(payload);
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
  const useLog = Boolean(chartLogScale);   // 비교 %는 (1+%/100) 비율로 로그축에 매핑
  const ratioOf = pct => 1 + pct / 100;
  const scale = useLog ? compareLogScale(values.map(ratioOf)) : niceChartScale([...values, 0]);
  const width = 980;
  const compactChart = window.matchMedia?.("(max-width: 980px)")?.matches;
  const height = compactChart ? 900 : 560;
  const pad = { top: 28, right: 108, bottom: 34, left: 52 };
  const plotW = width - pad.left - pad.right;
  const rsiGap = compactChart ? 24 : 18;
  const rsiH = compactChart ? 180 : 100;
  const plotH = height - pad.top - pad.bottom - rsiGap - rsiH;
  const rsiTop = pad.top + plotH + rsiGap;
  const rsiBottom = rsiTop + rsiH;
  const min = scale.min;
  const max = scale.max;
  const range = max - min || 1;
  const logMin = useLog ? Math.log10(min) : 0;
  const logSpan = useLog ? ((Math.log10(max) - logMin) || 1) : 1;
  const xForTime = time => pad.left + (maxTime === minTime ? 0 : (time - minTime) / (maxTime - minTime) * plotW);
  // 입력은 항상 %(close). 로그 모드면 비율로 변환해 매핑.
  const yFor = pct => useLog
    ? pad.top + (Math.log10(max) - Math.log10(ratioOf(pct))) / logSpan * plotH
    : pad.top + (max - pct) / range * plotH;
  const rsiYFor = value => rsiTop + (100 - Math.max(0, Math.min(100, value))) / 100 * rsiH;
  const clampY = value => Math.max(pad.top + 4, Math.min(pad.top + plotH - 2, value));
  const pathFor = points => chartLinePath(points.map(point => ({ x: xForTime(point.time), y: yFor(point.close) })));
  const rsiPathFor = points => chartLinePath(
    points
      .filter(point => Number.isFinite(point.rsi))
      .map(point => ({ x: xForTime(point.time), y: rsiYFor(point.rsi) }))
  );
  const main = series[0];
  const first = main.points[0];
  const last = main.points[main.points.length - 1];
  document.getElementById("chartMeta").textContent = "";
  const yTicks = scale.ticks.map(tick => {
    const pct = useLog ? (tick - 1) * 100 : tick;   // 로그 틱은 비율 → %로 환산
    return { value: pct, y: yFor(pct) };
  });
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
  const rsiEndLabels = series
    .map(item => {
      const lastPoint = [...item.points].reverse().find(point => Number.isFinite(point.rsi));
      return lastPoint ? { color: item.color, value: lastPoint.rsi, y: rsiYFor(lastPoint.rsi) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.y - b.y);
  const rsiMinGap = compactChart ? 12 : 9;
  for (let i = 1; i < rsiEndLabels.length; i++) {
    if (rsiEndLabels[i].y - rsiEndLabels[i - 1].y < rsiMinGap) rsiEndLabels[i].y = rsiEndLabels[i - 1].y + rsiMinGap;
  }
  const clampRsiY = value => Math.max(rsiTop + 7, Math.min(rsiBottom - 4, value));
  const rsiGuides = [30, 50, 70].map(value => ({ value, y: rsiYFor(value) }));
  const legend = series.map(item => `<span class="perf-legend-item ${item.primary ? "" : "removable"}" style="color:${item.color}"><i style="background:${item.color}"></i><span class="pl-name">${esc(item.ticker || item.name)}</span>${item.primary ? "" : `<button class="legend-remove" type="button" data-compare-remove="${esc(item.ticker)}" aria-label="${esc(item.ticker)} 비교 삭제" title="비교 삭제">&times;</button>`}</span>`).join("");
  document.getElementById("chartCanvas").innerHTML = `
    <div class="perf-chart-top">
      <div class="perf-legend">${legend}</div>
    </div>
    <svg class="line-chart compare-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(payload.name)} 비교 차트">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      <rect class="chart-plot-border" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      <rect class="chart-rsi-border" x="${pad.left}" y="${rsiTop}" width="${plotW}" height="${rsiH}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${pad.left - 8}" y="${(tick.y + 4).toFixed(2)}">${esc(pctChartLabel(tick.value))}</text>
      `).join("")}
      ${vGrid.lines.map(time => `
        <line class="chart-grid perf-vgrid" x1="${xForTime(time).toFixed(2)}" x2="${xForTime(time).toFixed(2)}" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(2)}"></line>
        <line class="chart-grid perf-vgrid" x1="${xForTime(time).toFixed(2)}" x2="${xForTime(time).toFixed(2)}" y1="${rsiTop}" y2="${rsiBottom}"></line>
      `).join("")}
      <line class="perf-zero-line" x1="${pad.left}" x2="${pad.left + plotW}" y1="${yFor(0).toFixed(2)}" y2="${yFor(0).toFixed(2)}"></line>
      ${vGrid.lines.map((time, index) => {
        if (index % labelEvery !== 0) return "";
        const x = xForTime(time);
        const anchor = x < pad.left + 18 ? "start" : x > pad.left + plotW - 18 ? "end" : "middle";
        return `<text class="chart-x-label" x="${x.toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${esc(perfGridLabel(time, vGrid.unit))}</text>`;
      }).join("")}
      ${series.map(item => `<path class="perf-line ${item.primary ? "primary" : "index"}" d="${pathFor(item.points)}" style="stroke:${item.color}"></path>`).join("")}
      ${rsiGuides.map(guide => `
        <line class="chart-rsi-guide level-${guide.value}" x1="${pad.left}" x2="${pad.left + plotW}" y1="${guide.y.toFixed(2)}" y2="${guide.y.toFixed(2)}"></line>
        <text class="chart-rsi-axis" x="${pad.left - 8}" y="${(guide.y + 4).toFixed(2)}">${guide.value}</text>
      `).join("")}
      <text class="chart-rsi-title" x="${pad.left + 7}" y="${rsiTop + 14}">RSI (14)</text>
      ${series.map(item => {
        const path = rsiPathFor(item.points);
        return path ? `<path class="compare-rsi-line ${item.primary ? "primary" : ""}" d="${path}" style="stroke:${item.color}"></path>` : "";
      }).join("")}
      ${endLabels.map(label => `
        <text class="perf-end-label" x="${(pad.left + plotW + 7).toFixed(2)}" y="${(clampY(label.y) + 3.5).toFixed(2)}" style="fill:${label.color}">${esc(pctChartLabel(label.close))}</text>
      `).join("")}
      ${rsiEndLabels.map(label => `
        <text class="compare-rsi-end-label" x="${(pad.left + plotW + 7).toFixed(2)}" y="${(clampRsiY(label.y) + 3.5).toFixed(2)}" style="fill:${label.color}">${Math.round(label.value)}</text>
      `).join("")}
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${rsiBottom - pad.top}"></rect>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${rsiBottom}"></line>
        ${series.map(item => `<circle id="compareDot-${item.key}" class="perf-hover-dot" r="3.6" cx="0" cy="0" style="stroke:${item.color}"></circle>`).join("")}
        ${series.map(item => `<circle id="compareRsiDot-${item.key}" class="perf-hover-dot compare-rsi-dot" r="3.2" cx="0" cy="0" style="stroke:${item.color}"></circle>`).join("")}
      </g>
    </svg>
    <div id="compareTooltip" class="compare-tooltip hidden" aria-hidden="true"></div>
    ${renderChartCompareControls()}
    ${renderChartRangeButtons()}
  `;
  bindCompareHover(series, { width, height, pad, plotW, plotH, minTime, maxTime, xForTime, yFor, rsiYFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
}

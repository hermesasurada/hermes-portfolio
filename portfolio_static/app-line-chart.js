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
      ${(!isCompare && !performanceChartOpen) ? `
        <span class="chart-marker-toggles" role="group" aria-label="거래 마커 표시">
          <button class="chart-range-btn marker-toggle buy ${chartShowBuys ? "active" : ""}" type="button" data-marker-toggle="buy" aria-pressed="${chartShowBuys}" ${chartInterval === "day" ? "" : `disabled title="일 단위에서만 표시"`}><i></i>매수</button>
          <button class="chart-range-btn marker-toggle sell ${chartShowSells ? "active" : ""}" type="button" data-marker-toggle="sell" aria-pressed="${chartShowSells}" ${chartInterval === "day" ? "" : `disabled title="일 단위에서만 표시"`}><i></i>매도</button>
        </span>
      ` : ""}
    </div>
  `;
}

function syncChartIntervalControl() {
  const control = document.getElementById("chartIntervalControl");
  if (!control) return;
  control.classList.toggle("hidden", !chartTicker || performanceChartOpen);
  control.querySelectorAll("[data-chart-interval]").forEach(btn => {
    const active = btn.dataset.chartInterval === chartInterval;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

function initChartIntervalControl() {
  const control = document.getElementById("chartIntervalControl");
  if (!control) return;
  syncChartIntervalControl();
  control.addEventListener("click", event => {
    const btn = event.target.closest?.("[data-chart-interval]");
    if (!btn) return;
    const interval = btn.dataset.chartInterval;
    if (!["day", "week", "month"].includes(interval) || interval === chartInterval) return;
    chartInterval = interval;
    storageSet(detailStorage.chartInterval, chartInterval);
    syncChartIntervalControl();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
}

function syncChartDisplayControls(visible = Boolean(chartTicker) && !performanceChartOpen) {
  const control = document.getElementById("chartDisplayControls");
  if (!control) return;
  control.classList.toggle("hidden", !visible);
  const smoothToggle = document.getElementById("chartSmoothToggle");
  const logToggle = document.getElementById("chartLogToggle");
  smoothToggle?.classList.toggle("active", chartSmoothLines);
  smoothToggle?.setAttribute("aria-pressed", String(chartSmoothLines));
  logToggle?.classList.toggle("active", chartLogScale);
  logToggle?.setAttribute("aria-pressed", String(chartLogScale));
}

function initChartDisplayControls() {
  const smoothToggle = document.getElementById("chartSmoothToggle");
  const logToggle = document.getElementById("chartLogToggle");
  smoothToggle?.addEventListener("click", () => {
    chartSmoothLines = !chartSmoothLines;
    storageSet(detailStorage.chartSmoothLines, String(chartSmoothLines));
    syncChartDisplayControls();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
  logToggle?.addEventListener("click", () => {
    chartLogScale = !chartLogScale;
    storageSet(detailStorage.chartLogScale, String(chartLogScale));
    syncChartDisplayControls();
    if (chartPayload && !performanceChartOpen) renderLineChart(chartPayload);
  });
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

const KR_ETF_ISSUERS = [
  { brand: "KODEX", label: "삼성 KODEX", url: "https://www.samsungfund.com/etf/main.do" },
  { brand: "TIGER", label: "미래에셋 TIGER", url: "https://www.tigeretf.com/" },
  { brand: "ACE", label: "한국투자 ACE", url: "https://www.aceetf.co.kr/" },
  { brand: "SOL", label: "신한 SOL", url: "https://www.soletf.com/" },
];

function isKoreanTicker(ticker) {
  return /\.(KS|KQ)$/i.test(String(ticker || ""));
}

function koreanTickerCode(ticker) {
  const match = String(ticker || "").match(/^([0-9A-Za-z]{6})\.(KS|KQ)$/);
  return match ? match[1].toUpperCase() : null;
}

function renderChartExternalLinks(payload) {
  const el = document.getElementById("chartLinks");
  if (!el) return;
  el.innerHTML = "";
  const ticker = String(payload?.ticker || "").toUpperCase();
  const code = koreanTickerCode(ticker);
  if (!code) return;
  const name = String(payload?.name || "");
  const links = [];
  links.push({
    label: "네이버 증권",
    url: `https://finance.naver.com/item/main.naver?code=${code}`,
  });
  const issuer = KR_ETF_ISSUERS.find(it =>
    name.toUpperCase().includes(it.brand)
  );
  if (issuer) {
    links.push({ label: issuer.label, url: issuer.url });
  }
  el.innerHTML = links
    .map(
      link =>
        `<a class="chart-link-btn" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`
    )
    .join("");
}

function clearChartExternalLinks() {
  const el = document.getElementById("chartLinks");
  if (el) el.innerHTML = "";
}

function renderChartIdentity(payload) {
  const row = chartLogoRow(payload);
  document.getElementById("chartIcon").innerHTML = logoMarkup(row);
  document.getElementById("chartTicker").textContent = row.ticker || "";
  document.getElementById("chartName").textContent = row.name || row.ticker || "";
  document.getElementById("chartInterestOpen")?.classList.toggle("hidden", !row.ticker);
  renderChartExternalLinks(row);
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
  const aum = Number(s.aum);
  const hasAum = Number.isFinite(aum);
  const mcap = hasAum
    ? marketCapText(aum, payload?.currency)
    : Number.isFinite(Number(s.market_cap)) ? marketCapText(s.market_cap, payload?.currency) : "-";

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
    <div class="cstat-row${label ? "" : " empty"}">
      <span class="cstat-k">${esc(label)}</span>
      <span class="cstat-v">${value}</span>
    </div>
  `;
  const dividendYieldCell = Number(s.dividend_yield) > 0
    ? `<button class="stat-yield-link" type="button" data-dividend-history="${esc(ticker)}" title="배당 이력 보기">${dividendYieldText(s.dividend_yield)}</button>`
    : dividendYieldText(s.dividend_yield);
  const columns = [
    [
      [hasAum ? "AUM" : "시가총액", mcap],
      ["배당수익률", dividendYieldCell],
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
  const maxRows = Math.max(...columns.map(items => items.length));
  const normalizedColumns = columns.map(items => {
    const filled = [...items];
    while (filled.length < maxRows) filled.push(["", ""]);
    return filled;
  });
  const statCells = [];
  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    for (const items of normalizedColumns) {
      statCells.push(row(items[rowIndex]));
    }
  }

  el.innerHTML = `
    <div class="cstat-board">
      ${statCells.join("")}
    </div>
    ${loaded ? "" : `<div class="chart-stat-loading">통계 불러오는 중…</div>`}
  `;
  el.querySelectorAll("[data-dividend-history]").forEach(btn => {
    btn.addEventListener("click", () => openDividendHistory(btn.dataset.dividendHistory));
  });
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
  const selectionTooltip = document.getElementById("chartSelectionTooltip");
  const selectionTooltipBox = document.getElementById("chartSelectionTooltipBox");
  let dragStartIndex = null;
  let isDragging = false;
  let touchPinned = false;
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
    const hoverRsiDot = document.getElementById("chartHoverRsiDot");
    hoverRsiDot?.classList.add("hidden");
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
    const rsiValue = Number(point.rsi);
    const hoverRsiDot = document.getElementById("chartHoverRsiDot");
    const tooltipX = x > geometry.width - 250 ? x - 188 : x + 12;
    const tooltipY = y < geometry.pad.top + geometry.plotH / 2 ? y + 42 : y - 58;
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
    tooltip.setAttribute("x", tooltipX.toFixed(2));
    tooltip.setAttribute("y", tooltipY.toFixed(2));
    tooltip.textContent = `${chartFullDateLabel(point.date)} · ${chartMoney(Number(point.close), payload.currency, payload.ticker)}${Number.isFinite(rsiValue) ? ` · RSI ${rsiValue.toFixed(1)}` : ""}`;
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
      `${arrow}${signedChartMoney(change, payload.currency, payload.ticker)} (${changePct > 0 ? "+" : ""}${fmt2.format(changePct)}%)`,
      `${chartFullDateLabel(start.date)} - ${chartFullDateLabel(end.date)}`,
      `${chartMoney(startPrice, payload.currency, payload.ticker)} → ${chartMoney(endPrice, payload.currency, payload.ticker)}`,
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
    if (event.pointerType === "touch") {
      touchPinned = true;
      showPoint(event.clientX, event.clientY);
      return;
    }
    dragStartIndex = pointIndexFromClientX(event.clientX);
    isDragging = true;
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
  syncChartIntervalControl();
  if (chartComparePayloads.length) {
    renderCompareLineChart(payload);
    return;
  }
  const allPoints = aggregateChartPoints(payload.points || [])
    .filter(point => Number.isFinite(Number(point.close)));
  const points = filterChartPoints(allPoints, chartRange);
  // 매수/매도 마커 표시 토글 반영 (꺼진 쪽은 마커·스케일에서 제외)
  const chartTransactions = chartInterval === "day"
    ? transactionsForChart(payload, points).filter(tx => (tx.side === "BUY" ? chartShowBuys : chartShowSells))
    : [];
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
  const width = 980;
  const compactChart = window.matchMedia?.("(max-width: 980px)")?.matches;
  const height = compactChart ? 900 : 530;
  const first = values[0];
  const last = values[values.length - 1];
  const changePct = first ? (last - first) / first * 100 : null;
  const changeDirection = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
  const changeArrow = changePct > 0 ? "▲" : changePct < 0 ? "▼" : "";
  const changeLabel = Number.isFinite(changePct)
    ? `${changeArrow}${changeArrow ? " " : ""}${fmt2.format(Math.abs(changePct))}%`
    : "-";
  const extremeRadius = compactChart ? 7 : 4;
  const tradeMarkerRadius = compactChart ? 10 : 5;
  document.getElementById("chartMeta").textContent = "";

  const pad = { top: 28, right: 58, bottom: 32, left: 14 };
  const plotW = width - pad.left - pad.right;
  const rsiGap = compactChart ? 24 : 18;
  const rsiH = compactChart ? 180 : 96;
  const plotH = height - pad.top - pad.bottom - rsiGap - rsiH;
  const rsiTop = pad.top + plotH + rsiGap;
  const rsiBottom = rsiTop + rsiH;
  const range = max - min || Math.max(1, Math.abs(max));
  const logMax = useLog ? Math.log10(max) : 0;
  const logSpan = useLog ? ((Math.log10(max) - Math.log10(min)) || 1) : 1;
  const xFor = index => pad.left + (points.length === 1 ? 0 : index / (points.length - 1) * plotW);
  const yFor = useLog
    ? (value => pad.top + (logMax - Math.log10(value)) / logSpan * plotH)
    : (value => pad.top + (max - value) / range * plotH);
  const rsiYFor = value => rsiTop + (100 - Math.max(0, Math.min(100, value))) / 100 * rsiH;
  const line = chartLinePath(points.map((point, index) => ({ x: xFor(index), y: yFor(Number(point.close)) })));
  const area = `${line} L${pad.left + plotW},${pad.top + plotH} L${pad.left},${pad.top + plotH} Z`;
  const rsiLine = chartLinePath(
    points
      .map((point, index) => ({ x: xFor(index), y: rsiYFor(Number(point.rsi)), value: Number(point.rsi) }))
      .filter(point => Number.isFinite(point.value))
  );
  const rsiOverboughtAreas = rsiThresholdAreaPaths(points, 70, "above", xFor, rsiYFor);
  const rsiOversoldAreas = rsiThresholdAreaPaths(points, 30, "below", xFor, rsiYFor);
  const rsiGuides = [30, 50, 70].map(value => ({ value, y: rsiYFor(value) }));
  const latestRsi = [...points].reverse().map(point => Number(point.rsi)).find(value => Number.isFinite(value));
  const currentRsiY = Number.isFinite(latestRsi) ? rsiYFor(latestRsi) : null;
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
      text: `${item.label} ${chartMoney(item.value, payload.currency, payload.ticker)}`,
    };
  });

  document.getElementById("chartCanvas").innerHTML = `
    <svg class="line-chart single-price-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(payload.name)} 종가 및 RSI 차트">
      <defs>
        <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity=".18"></stop>
          <stop offset="72%" stop-color="var(--brand)" stop-opacity=".045"></stop>
          <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"></stop>
        </linearGradient>
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
        return `<text class="chart-x-label" x="${tick.x.toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${esc(perfGridLabel(tick.time, vGrid.unit))}</text>`;
      }).join("")}
      <path class="chart-area" d="${area}"></path>
      <path class="chart-line" d="${line}"></path>
      <line class="chart-current-price-tick" x1="${(pad.left + plotW).toFixed(2)}" x2="${(width - 8).toFixed(2)}" y1="${currentPriceY.toFixed(2)}" y2="${currentPriceY.toFixed(2)}"></line>
      <text class="chart-current-price-label" x="${width - 6}" y="${(currentPriceY + 4).toFixed(2)}">${esc(currentPriceLabel)}</text>
      ${rsiOverboughtAreas.map(path => `<path class="chart-rsi-zone overbought" d="${path}"></path>`).join("")}
      ${rsiOversoldAreas.map(path => `<path class="chart-rsi-zone oversold" d="${path}"></path>`).join("")}
      ${rsiGuides.map(guide => `
        <line class="chart-rsi-guide level-${guide.value}" x1="${pad.left}" x2="${pad.left + plotW}" y1="${guide.y.toFixed(2)}" y2="${guide.y.toFixed(2)}"></line>
        <text class="chart-rsi-axis" x="${width - 6}" y="${(guide.y + 4).toFixed(2)}">${guide.value}</text>
      `).join("")}
      <text class="chart-rsi-title" x="${pad.left + 7}" y="${rsiTop + 14}">RSI (14)</text>
      ${rsiLine ? `<path class="chart-rsi-line" d="${rsiLine}"></path>` : ""}
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
      <text class="chart-change-overlay ${changeDirection}" x="${pad.left + 10}" y="${pad.top + 24}">${esc(changeLabel)}</text>
      <g id="chartSelectionGroup" class="chart-selection hidden">
        <rect id="chartSelectionRect" class="chart-selection-range" x="0" y="${pad.top}" width="0" height="${plotH}"></rect>
        <line id="chartSelectionStartLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${rsiBottom}"></line>
        <line id="chartSelectionEndLine" class="chart-selection-line" x1="0" x2="0" y1="${pad.top}" y2="${rsiBottom}"></line>
        <rect id="chartSelectionTooltipBox" class="chart-selection-box" x="0" y="0" width="0" height="0" rx="5"></rect>
        <text id="chartSelectionTooltip" class="chart-selection-tooltip" x="0" y="0"></text>
      </g>
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${rsiBottom - pad.top}"></rect>
      ${markers.map(marker => `
        <g class="trade-marker ${marker.cls}" data-x="${marker.x.toFixed(2)}" data-y="${marker.y.toFixed(2)}" data-tooltip="${esc(marker.tooltip)}" tabindex="0" role="img" aria-label="${esc(marker.tooltip)}">
          <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="${tradeMarkerRadius}"></circle>
          <text x="${marker.x.toFixed(2)}" y="${(marker.y + (compactChart ? 4.5 : 3)).toFixed(2)}" text-anchor="middle">${marker.label}</text>
        </g>
      `).join("")}
      <circle class="chart-last-dot" cx="${xFor(points.length - 1).toFixed(2)}" cy="${yFor(last).toFixed(2)}" r="4"></circle>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${rsiBottom}"></line>
        <circle id="chartHoverDot" class="chart-hover-dot" cx="0" cy="0" r="4"></circle>
        <circle id="chartHoverRsiDot" class="chart-hover-rsi-dot hidden" cx="0" cy="0" r="3.5"></circle>
        <rect id="chartTooltipBox" class="chart-tooltip-box" x="0" y="0" width="0" height="0" rx="6"></rect>
        <text id="chartTooltip" class="chart-tooltip" x="0" y="0">-</text>
      </g>
    </svg>
    ${renderChartCompareControls()}
    ${renderChartRangeButtons()}
  `;
  bindChartInteractions(points, payload, { width, height, pad, plotW, plotH, xFor, yFor, rsiYFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
  renderChartStats(payload);
  ensureChartStats(payload.ticker);
}

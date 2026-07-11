// 단일 종목 가격차트 + 통계 패널 + 기간/모달 컨트롤. (공용=app-chart-scale.js, 비교=app-chart-compare.js)
function chartPayloadExtent(payloads, common = false) {
  const items = (Array.isArray(payloads) ? payloads : [payloads]).filter(Boolean);
  const extents = items.map(item => {
    const pts = aggregateChartPoints(item.points || [])
      .filter(point => point.date && Number.isFinite(Number(point.close)) && Number(point.close) > 0)
      .map(point => new Date(`${point.date}T00:00:00`).getTime())
      .filter(time => Number.isFinite(time))
      .sort((a, b) => a - b);
    return pts.length >= 2 ? { start: pts[0], end: pts[pts.length - 1] } : null;
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

function renderChartRangeButtons() {
  // 비교 모드: '전체' 대신 공통기간 '최대' 노출 (상장일 차이로 못 쓰는 구간 제외)
  const isCompare = chartComparePayloads.length > 0;
  const ranges = isCompare ? chartRanges.filter(range => range.key !== "all") : chartRanges;
  const extent = currentChartRangeExtent();
  const maxBtn = isCompare
    ? `<button class="chart-range-btn ${chartRange === "cmax" ? "active" : ""}" type="button" data-chart-range="cmax">최대</button>`
    : "";
  return `
    <div class="chart-ranges" role="group" aria-label="차트 기간">
      ${ranges.map(range => {
        const disabled = chartRangeUnavailable(range, extent);
        const title = disabled ? `가격 이력이 부족해 ${range.label} 기간을 선택할 수 없습니다.` : "";
        return `<button class="chart-range-btn ${range.key === chartRange ? "active" : ""}${disabled ? " disabled" : ""}" type="button" data-chart-range="${range.key}"${disabled ? ` disabled title="${esc(title)}"` : ""}>${range.label}</button>`;
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

function renderChartRangeControls() {
  const host = document.getElementById("chartRangeHost");
  if (!host) return;
  host.innerHTML = renderChartRangeButtons();
}

function syncChartBottomControls(visible = Boolean(chartTicker || performanceChartOpen)) {
  const control = document.getElementById("chartBottomControls");
  if (!control) return;
  control.classList.toggle("hidden", !visible);
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
  {
    brand: "KODEX",
    label: "KODEX ETF",
    icon: "K",
    logoUrl: "/logos/KODEX.png",
    url: code => `https://www.samsungfund.com/etf/product/view.do?id=${encodeURIComponent(code)}`,
  },
  {
    brand: "TIGER",
    label: "TIGER ETF",
    icon: "T",
    logoUrl: "/logos/TIGER.png",
    url: code => `https://www.tigeretf.com/ko/product/search/detail/index.do?ksdFund=${encodeURIComponent(code)}`,
  },
  {
    brand: "ACE",
    label: "ACE ETF",
    icon: "A",
    logoUrl: "/logos/ACE.png",
    url: code => `https://www.aceetf.co.kr/fund/${encodeURIComponent(code)}`,
  },
  {
    brand: "SOL",
    label: "SOL ETF",
    icon: "S",
    logoUrl: "/logos/SOL.svg",
    url: code => `https://www.soletf.co.kr/ko/fund?keyword=${encodeURIComponent(code)}`,
  },
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
    icon: "N",
    logoText: "N",
    kind: "naver",
    url: `https://finance.naver.com/item/main.naver?code=${code}`,
  });
  const issuer = KR_ETF_ISSUERS.find(it =>
    name.toUpperCase().includes(it.brand)
  );
  if (issuer) {
    links.push({
      label: issuer.label,
      icon: issuer.icon,
      logoUrl: issuer.logoUrl,
      kind: "etf",
      url: typeof issuer.url === "function" ? issuer.url(code) : issuer.url,
    });
  }
  el.innerHTML = links
    .map(
      link => {
        const icon = link.logoUrl
          ? `<img src="${esc(link.logoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('logo-fallback');this.remove()"><span class="chart-link-fallback" aria-hidden="true">${esc(link.icon || "↗")}</span>`
          : `<span class="chart-link-symbol" aria-hidden="true">${esc(link.logoText || link.icon || "↗")}</span>`;
        return `<a class="chart-link-btn chart-link-icon-btn ${esc(link.kind || "")}" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" title="${esc(link.label)}" aria-label="${esc(link.label)}">${icon}</a>`;
      }
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
  return { ...holding, ...meta, ticker, currency: payload?.currency || meta.currency || holding.currency || "USD" };
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
  if (source.includes("pre") || state === "PRE") return "프리";
  if (source.includes("after") || state.includes("POST")) return "애프터";
  return "연장";
}

function chartShouldShowExtendedLine(meta, metric, isUsTicker) {
  if (!isUsTicker || metric.price == null) return false;
  if (meta.category === "index") return false;
  const state = String(meta.extended_market_state || meta.market_state || "").toUpperCase();
  if (state === "REGULAR" || state === "REGULAR_MARKET") return false;
  return true;
}

function renderChartPriceQuote(dayMetric, extendedMetric, currency, ticker, isUsTicker, extendedLabel) {
  const extendedLine = isUsTicker && extendedMetric.price != null
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
  const isUsTicker = currency === "USD" && !ticker.includes(".");
  const showExtended = chartShouldShowExtendedLine(meta, extendedMetric, isUsTicker);
  el.innerHTML = renderChartPriceQuote(dayMetric, showExtended ? extendedMetric : {}, currency, ticker, isUsTicker, chartExtendedLabel(meta));
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

let chartStatsLoadKey = "";

function chartStatPercent(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const cls = number > 0 ? "cstat-positive" : number < 0 ? "cstat-negative" : "";
  return `<span class="${cls}">${number.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%</span>`;
}

function chartStatIndicator(value, kind) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `<span class="indicator-tone" ${indicatorToneAttr(number, kind)}>${Math.round(number).toLocaleString("ko-KR")}</span>`;
}

function chartStatMetricRows(payload) {
  const ticker = String(payload?.ticker || "").toUpperCase();
  const s = statsData[ticker] || {};
  const rsi = s.rsi || {};
  const bb = s.bollinger_pband || {};
  const perf = s.performance || {};
  const loaded = Boolean(statsData[ticker]);
  const aum = Number(s.aum);
  const hasAum = s.aum != null && Number.isFinite(aum) && aum > 0;
  const scaleValue = hasAum ? aum : Number(s.market_cap);
  const scaleRaw = Number.isFinite(scaleValue) ? toUsd(scaleValue, payload?.currency) : null;
  const mcap = hasAum
    ? marketCapText(aum, payload?.currency)
    : Number.isFinite(Number(s.market_cap)) ? marketCapText(s.market_cap, payload?.currency) : "-";
  const dividendYield = Number(s.dividend_yield);
  const dividendYieldCell = Number(s.dividend_yield) > 0
    ? `<button class="stat-yield-link" type="button" data-dividend-history="${esc(ticker)}" title="배당 이력 보기">${dividendYieldText(s.dividend_yield)}</button>`
    : dividendYieldText(s.dividend_yield);
  return [
    ["규모", "시총/AUM", mcap, scaleRaw, "high"],
    ["규모", "배당수익률", dividendYieldCell, Number.isFinite(dividendYield) ? dividendYield : null, "high"],
    ["밸류", "P/E (t)", peText(s.trailing_pe), positiveMetric(s.trailing_pe), "low"],
    ["밸류", "P/E (f)", peText(s.forward_pe), positiveMetric(s.forward_pe), "low"],
    ["밸류", "P/B", peText(s.price_to_book), positiveMetric(s.price_to_book), "low"],
    ["일정", "실적일", earningsText(s.next_earnings_date), null, null],
    ["모멘텀", "RSI (일)", chartStatIndicator(rsi.day, "rsi"), finiteMetric(rsi.day), "near50"],
    ["모멘텀", "RSI (주)", chartStatIndicator(rsi.week, "rsi"), finiteMetric(rsi.week), "near50"],
    ["모멘텀", "RSI (월)", chartStatIndicator(rsi.month, "rsi"), finiteMetric(rsi.month), "near50"],
    ["모멘텀", "BB (일)", chartStatIndicator(bb.day, "bb"), finiteMetric(bb.day), "near50"],
    ["모멘텀", "BB (주)", chartStatIndicator(bb.week, "bb"), finiteMetric(bb.week), "near50"],
    ["모멘텀", "BB (월)", chartStatIndicator(bb.month, "bb"), finiteMetric(bb.month), "near50"],
    ["성과", "1개월", chartStatPercent(perf.one_month), finiteMetric(perf.one_month), "high"],
    ["성과", "3개월", chartStatPercent(perf.three_month, 0), finiteMetric(perf.three_month), "high"],
    ["성과", "6개월", chartStatPercent(perf.six_month, 0), finiteMetric(perf.six_month), "high"],
    ["성과", "YTD", chartStatPercent(perf.ytd, 0), finiteMetric(perf.ytd), "high"],
    ["성과", "1년", chartStatPercent(perf.one_year, 0), finiteMetric(perf.one_year), "high"],
    ["성과", "3년", chartStatPercent(perf.three_year, 0), finiteMetric(perf.three_year), "high"],
    ["성과", "5년", chartStatPercent(perf.five_year, 0), finiteMetric(perf.five_year), "high"],
    ["위험", "52주 고점 대비", chartStatPercent(s.drawdown_52w), finiteMetric(s.drawdown_52w), "high"],
    ["위험", "β", betaText(s.beta), finiteMetric(s.beta), "lowAbs"],
    ["위험", "β″", betaText(s.beta_adj), finiteMetric(s.beta_adj), "lowAbs"],
  ];
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function compareBestIndexes(values, mode) {
  if (!mode) return new Set();
  const scored = values
    .map((value, index) => {
      if (value == null || !Number.isFinite(Number(value))) return null;
      const number = Number(value);
      if (mode === "high") return { index, score: number };
      if (mode === "low") return { index, score: -number };
      if (mode === "near50") return { index, score: -Math.abs(number - 50) };
      if (mode === "lowAbs") return { index, score: -Math.abs(number) };
      return null;
    })
    .filter(Boolean);
  if (!scored.length) return new Set();
  const uniqueScores = new Set(scored.map(item => String(item.score)));
  if (uniqueScores.size <= 1) return new Set();
  const best = Math.max(...scored.map(item => item.score));
  return new Set(scored.filter(item => Math.abs(item.score - best) < 1e-9).map(item => item.index));
}

function renderChartStats(payload) {
  const el = document.getElementById("chartStats");
  if (!el) return;
  const ticker = String(payload?.ticker || "").toUpperCase();
  if (!ticker) { el.innerHTML = ""; return; }
  const loaded = Boolean(statsData[ticker]);
  const rows = chartStatMetricRows(payload);
  const row = ([, label, value], mobileOrder = 0) => `
    <div class="cstat-row${label ? "" : " empty"}" style="--mobile-order:${mobileOrder}">
      <span class="cstat-k">${esc(label)}</span>
      <span class="cstat-v">${value}</span>
    </div>
  `;
  const columns = [
    rows.slice(0, 6),
    rows.slice(6, 12),
    rows.slice(12, 18),
    rows.slice(18),
  ];
  const maxRows = Math.max(...columns.map(items => items.length));
  const normalizedColumns = columns.map(items => {
    const filled = [...items];
    while (filled.length < maxRows) filled.push(["", ""]);
    return filled;
  });
  const statCells = [];
  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    normalizedColumns.forEach((items, columnIndex) => {
      statCells.push(row(items[rowIndex], columnIndex * maxRows + rowIndex));
    });
  }

  el.innerHTML = `
    <div class="cstat-board">
      ${statCells.join("")}
    </div>
    ${loaded ? "" : `<div class="chart-stat-loading">통계 불러오는 중…</div>`}
    ${consensusBlockMarkup(ticker)}
  `;
  // 배당이력 버튼 클릭은 app.js의 문서 위임이 처리
}

function compareStatPayloads(payload) {
  return [payload, ...chartComparePayloads]
    .filter(Boolean)
    .map(item => ({ ...item, ticker: String(item.ticker || "").toUpperCase() }))
    .filter(item => item.ticker);
}

function ensureChartStatsForPayloads(payloads, rerender) {
  const missing = payloads
    .map(item => item.ticker)
    .filter(ticker => ticker && !statsData[ticker] && !statsFetchedTickers.has(ticker));
  const unique = Array.from(new Set(missing)).sort();
  if (!unique.length) return;
  const key = unique.join(",");
  if (chartStatsLoadKey === key) return;
  chartStatsLoadKey = key;
  apiFetchStats(unique).then(response => {
    statsData = { ...statsData, ...(response.stats || {}) };
    unique.forEach(ticker => statsFetchedTickers.add(ticker));
    chartStatsLoadKey = "";
    rerender?.();
  }).catch(() => {
    chartStatsLoadKey = "";
  });
}

function renderCompareChartStats(payload) {
  const el = document.getElementById("chartStats");
  if (!el) return;
  const payloads = compareStatPayloads(payload);
  if (payloads.length < 2) {
    renderChartStats(payload);
    return;
  }
  ensureChartStatsForPayloads(payloads, () => {
    if (chartComparePayloads.length && chartPayload) renderLineChart(chartPayload);
  });
  const rowsByTicker = new Map(payloads.map(item => [item.ticker, chartStatMetricRows(item)]));
  const metricRows = (rowsByTicker.get(payloads[0].ticker) || []).map(([group, label,,, mode], index) => ({ group, label, index, mode }));
  const columnTemplate = `132px repeat(${payloads.length}, 118px)`;
  const header = `
    <div class="cstat-compare-head" style="grid-template-columns:${columnTemplate}">
      <div class="cstat-compare-corner">지표</div>
      ${payloads.map((item, index) => `
        <div class="cstat-compare-ticker ${index === 0 ? "" : "removable"}" style="color:${chartCompareColors[index % chartCompareColors.length]}">
          <span>${esc(item.ticker)}</span>
          <small>${esc(item.name || item.ticker)}</small>
          ${index === 0 ? "" : `<button class="cstat-compare-remove" type="button" data-compare-remove="${esc(item.ticker)}" aria-label="${esc(item.ticker)} 비교 삭제" title="비교 삭제">&times;</button>`}
        </div>
      `).join("")}
    </div>
  `;
  const body = metricRows.map(row => {
    const rowItems = payloads.map(item => (rowsByTicker.get(item.ticker) || [])[row.index] || []);
    const bestIndexes = compareBestIndexes(rowItems.map(item => item[3]), row.mode);
    const cells = rowItems.map((item, index) => {
      const value = item[2] || "-";
      const bestClass = bestIndexes.has(index) ? " best" : "";
      return `<div class="cstat-compare-val${bestClass}">${value}</div>`;
    }).join("");
    return `
      <div class="cstat-compare-row" style="grid-template-columns:${columnTemplate}">
        <div class="cstat-compare-key"><small>${esc(row.group)}</small><span>${esc(row.label)}</span></div>
        ${cells}
      </div>
    `;
  }).join("");
  const loaded = payloads.every(item => Boolean(statsData[item.ticker]));
  el.innerHTML = `
    <div class="cstat-compare-wrap">
      <div class="cstat-compare-board">
        ${header}
        ${body}
      </div>
    </div>
    ${loaded ? "" : `<div class="chart-stat-loading">비교 지표 불러오는 중…</div>`}
  `;
  // 배당이력 버튼 클릭은 app.js의 문서 위임이 처리
}

function chartPctMetric(value, neutral = "0.00%", neutralCls = "flat") {
  const number = Number(value);
  if (!Number.isFinite(number)) return { text: "-", cls: "flat" };
  if (Math.abs(number) < 0.005) return { text: neutral, cls: neutralCls };
  const cls = number > 0 ? "up" : "down";
  const arrow = number > 0 ? "▲" : "▼";
  return { text: `${arrow} ${fmt2.format(Math.abs(number))}%`, cls };
}

function chartMaxDrawdown(values) {
  const clean = (values || []).map(Number).filter(value => Number.isFinite(value));
  if (clean.length < 2) return 0;
  let peak = clean[0];
  let maxDrawdown = 0;
  for (let index = 1; index < clean.length; index += 1) {
    const value = clean[index];
    if (value > peak) {
      peak = value;
      continue;
    }
    if (peak > 0) {
      maxDrawdown = Math.min(maxDrawdown, (value - peak) / peak * 100);
    }
  }
  return maxDrawdown;
}

function chartOverlayMetrics(values) {
  const clean = (values || []).map(Number).filter(value => Number.isFinite(value));
  if (clean.length < 2) {
    return [
      ["등락", { text: "-", cls: "flat" }],
      ["MDD", { text: "-", cls: "flat" }],
      ["고점대비", { text: "-", cls: "flat" }],
      ["저점대비", { text: "-", cls: "flat" }],
    ];
  }
  const first = clean[0];
  const last = clean[clean.length - 1];
  const periodChange = first ? (last - first) / first * 100 : null;
  const mdd = chartMaxDrawdown(clean);
  const high = Math.max(...clean);
  const low = Math.min(...clean);
  const vsHigh = high ? (last - high) / high * 100 : null;
  const vsLow = low ? (last - low) / low * 100 : null;
  return [
    ["등락", chartPctMetric(periodChange)],
    ["MDD", chartPctMetric(mdd)],
    ["고점대비", chartPctMetric(vsHigh, "ATH", "up")],
    ["저점대비", chartPctMetric(vsLow, "ATL", "down")],
  ];
}

function renderChartMetricsOverlay(metrics, x, y, compact = false) {
  const width = compact ? 178 : 148;
  const height = compact ? 100 : 78;
  const titleY = y + (compact ? 19 : 15);
  const rowStartY = y + (compact ? 39 : 31);
  const rowGap = compact ? 18 : 13.5;
  const labelX = x + (compact ? 13 : 10);
  const valueX = x + width - (compact ? 11 : 9);
  const rows = metrics.map(([label, metric], index) => {
    const rowY = rowStartY + index * rowGap;
    return `
      <text class="chart-metric-label" x="${labelX}" y="${rowY}">${esc(label)}</text>
      <text class="chart-metric-value ${metric.cls}" x="${valueX}" y="${rowY}" text-anchor="end">${esc(metric.text)}</text>
    `;
  }).join("");
  return `
    <g class="chart-metric-overlay" transform="translate(${x}, ${y})">
      <rect class="chart-metric-box" x="0" y="0" width="${width}" height="${height}" rx="8"></rect>
      <text class="chart-metric-title" x="${labelX - x}" y="${titleY - y}">선택 기간</text>
    </g>
    <g class="chart-metric-overlay-text">
      ${rows}
    </g>
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
      if (btn.dataset.chartCustom != null) {
        openChartRangeModal();
        return;
      }
      chartRange = btn.dataset.chartRange || "1y";
      renderLineChart(payload);
    });
  });
}

function chartNumericValue(point, key) {
  const value = Number(point?.[key]);
  return Number.isFinite(value) ? value : null;
}

function chartOverlayScaleValues(points) {
  const values = [];
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

function renderChartOverlayControls(x, y) {
  return `
    <foreignObject x="${x}" y="${y}" width="190" height="34" class="chart-overlay-controls-fo">
      <div xmlns="http://www.w3.org/1999/xhtml" class="chart-overlay-controls">
        <button class="chart-range-btn overlay-toggle ${chartShowBollinger ? "active" : ""}" type="button" data-chart-overlay-toggle="bollinger" aria-pressed="${chartShowBollinger}">BB</button>
        <button class="chart-range-btn overlay-toggle ${chartShowIchimoku ? "active" : ""}" type="button" data-chart-overlay-toggle="ichimoku" aria-pressed="${chartShowIchimoku}">일목</button>
      </div>
    </foreignObject>
  `;
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
  const overlayValues = chartOverlayScaleValues(points);
  const markerValues = chartTransactions.map(tx => tx.price);
  // 로그 스케일은 모든 값이 양수일 때만 적용 (아니면 선형 폴백)
  const scaleValues = [...values, ...markerValues, ...overlayValues];
  const useLog = chartLogScale && scaleValues.every(value => value > 0);
  const scale = useLog ? logChartScale(scaleValues) : niceChartScale(scaleValues);
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
  const bbUpperPaths = chartShowBollinger ? chartSeriesPaths(points, "bb_upper", xFor, yFor) : [];
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
        <clipPath id="chartPlotClip">
          <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
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
        return `<text class="chart-x-label" x="${tick.x.toFixed(2)}" y="${height - 12}" text-anchor="${anchor}">${esc(perfGridLabel(tick.time, vGrid.unit))}</text>`;
      }).join("")}
      <path class="chart-area" d="${area}"></path>
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
      ${renderChartMetricsOverlay(overlayMetrics, pad.left + 10, pad.top + 10, compactChart)}
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
      ${renderChartOverlayControls(width - 244, pad.top + 8)}
    </svg>
    ${renderChartCompareControls()}
  `;
  renderChartRangeControls();
  bindChartInteractions(points, payload, { width, height, pad, plotW, plotH, xFor, yFor, rsiYFor });
  bindChartCompareControls(payload);
  bindLineChartControls(payload);
  renderChartStats(payload);
  ensureChartStats(payload.ticker);
  ensureChartQuote(payload.ticker);
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-line-chart");

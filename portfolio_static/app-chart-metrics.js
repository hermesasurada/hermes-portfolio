// Chart statistics, comparison board, and overlay metrics.

let chartStatsLoadKey = "";

function chartStatPercent(value, digits = 1) {
  if (value == null || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  // 상승=빨강·하락=파랑(2026-11-11 사용자 지시 — 예전 초록/빨강은 시장 색 규칙과 반대였다).
  // 방향은 목록과 같은 ▲▼(2026-11-20 — 예전엔 −부호였다).
  return signedPercentText(number, digits);
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
  const financialCurrency = s.financial_currency || payload?.currency;
  const freeCashFlow = finiteMetric(s.free_cash_flow);
  const freeCashFlowUsd = freeCashFlow == null ? null : toUsd(freeCashFlow, financialCurrency);
  // 첫 칸은 묶음 이름 — 지표판이 묶음이 바뀌는 자리에 제목 줄을 넣고(2026-11-20 디자인 재검토 03), 비교 보드는 지표 이름 위에 작게 붙인다.
  return [
    ["밸류에이션", "시총/AUM", mcap, scaleRaw, "high"],
    ["밸류에이션", "P/E (t)", peText(s.trailing_pe), positiveMetric(s.trailing_pe), "low"],
    ["밸류에이션", "P/E (f)", peText(s.forward_pe), positiveMetric(s.forward_pe), "low"],
    ["밸류에이션", "P/B", peText(s.price_to_book), positiveMetric(s.price_to_book), "low"],
    ["밸류에이션", "실적일", earningsText(s.next_earnings_date), null, null],
    ["배당", "배당수익률", dividendYieldCell, Number.isFinite(dividendYield) ? dividendYield : null, "high"],
    ["배당", "5년 배당성장률", chartStatPercent(s.dividend_growth_5y), finiteMetric(s.dividend_growth_5y), "high"],
    ["배당", "연속 지급", dividendStreakText(s.dividend_streak_years, s.dividend_streak_floor), finiteMetric(s.dividend_streak_years), "high"],
    ["배당", "연속 증액", dividendStreakText(s.dividend_growth_streak_years), finiteMetric(s.dividend_growth_streak_years), "high"],
    ["배당", "배당성향", fractionPercentText(s.payout_ratio), finiteMetric(s.payout_ratio), null],
    ["수익성·성장", "총이익률", fractionPercentText(s.gross_margin), finiteMetric(s.gross_margin), "high"],
    ["수익성·성장", "영업이익률", fractionPercentText(s.operating_margin), finiteMetric(s.operating_margin), "high"],
    ["수익성·성장", "EBITDA 마진", fractionPercentText(s.ebitda_margin), finiteMetric(s.ebitda_margin), "high"],
    ["수익성·성장", "순이익률", fractionPercentText(s.profit_margin), finiteMetric(s.profit_margin), "high"],
    ["수익성·성장", "ROA", fractionPercentText(s.return_on_assets), finiteMetric(s.return_on_assets), "high"],
    ["수익성·성장", "ROE", fractionPercentText(s.return_on_equity), finiteMetric(s.return_on_equity), "high"],
    ["수익성·성장", "매출 (YoY)", fractionSignedPercentText(s.revenue_growth), finiteMetric(s.revenue_growth), "high"],
    ["수익성·성장", "이익 (YoY)", fractionSignedPercentText(s.earnings_growth), finiteMetric(s.earnings_growth), "high"],
    ["수익성·성장", "분기이익 (YoY)", fractionSignedPercentText(s.earnings_quarterly_growth), finiteMetric(s.earnings_quarterly_growth), "high"],
    ["재무·수급", "부채비율", rawPercentText(s.debt_to_equity), positiveMetric(s.debt_to_equity), "low"],
    ["재무·수급", "FCF", freeCashFlowText(s.free_cash_flow, financialCurrency), freeCashFlowUsd, "high"],
    ["재무·수급", "유통주식 비율", fractionPercentText(s.short_percent_float), finiteMetric(s.short_percent_float), "low"],
    ["재무·수급", "발행주식 비율", fractionPercentText(s.short_percent_shares), finiteMetric(s.short_percent_shares), "low"],
    ["재무·수급", "커버일", numberText(s.short_ratio, 1), finiteMetric(s.short_ratio), "low"],
    ["재무·수급", "내부자", fractionPercentText(s.insider_ownership), finiteMetric(s.insider_ownership), "high"],
    ["재무·수급", "기관", fractionPercentText(s.institutional_ownership), finiteMetric(s.institutional_ownership), "high"],
    ["기술 지표", "RSI (일)", chartStatIndicator(rsi.day, "rsi"), finiteMetric(rsi.day), "near50"],
    ["기술 지표", "RSI (주)", chartStatIndicator(rsi.week, "rsi"), finiteMetric(rsi.week), "near50"],
    ["기술 지표", "RSI (월)", chartStatIndicator(rsi.month, "rsi"), finiteMetric(rsi.month), "near50"],
    ["기술 지표", "BB (일)", chartStatIndicator(bb.day, "bb"), finiteMetric(bb.day), "near50"],
    ["기술 지표", "BB (주)", chartStatIndicator(bb.week, "bb"), finiteMetric(bb.week), "near50"],
    ["기술 지표", "BB (월)", chartStatIndicator(bb.month, "bb"), finiteMetric(bb.month), "near50"],
    ["기간 수익률", "1주", chartStatPercent(perf.one_week), finiteMetric(perf.one_week), "high"],
    ["기간 수익률", "1개월", chartStatPercent(perf.one_month), finiteMetric(perf.one_month), "high"],
    ["기간 수익률", "3개월", chartStatPercent(perf.three_month, 0), finiteMetric(perf.three_month), "high"],
    ["기간 수익률", "6개월", chartStatPercent(perf.six_month, 0), finiteMetric(perf.six_month), "high"],
    ["기간 수익률", "YTD", chartStatPercent(perf.ytd, 0), finiteMetric(perf.ytd), "high"],
    ["기간 수익률", "1년", chartStatPercent(perf.one_year, 0), finiteMetric(perf.one_year), "high"],
    ["기간 수익률", "3년", chartStatPercent(priceReturnCagr(perf.three_year, 3), 1), priceReturnCagr(perf.three_year, 3), "high"],
    ["기간 수익률", "5년", chartStatPercent(priceReturnCagr(perf.five_year, 5), 1), priceReturnCagr(perf.five_year, 5), "high"],
    ["기간 수익률", "10년", chartStatPercent(priceReturnCagr(perf.ten_year, 10), 1), priceReturnCagr(perf.ten_year, 10), "high"],
    ["추세·위험", "추세 수익률", chartStatPercent(s.trend_return), finiteMetric(s.trend_return), "high"],
    ["추세·위험", "추세 이탈폭", trendDeviationText(s.trend_deviation), finiteMetric(s.trend_deviation), "low"],
    ["추세·위험", "추세 강도", trendStrengthText(s.trend_strength), finiteMetric(s.trend_strength), "high"],
    ["추세·위험", "추세 R²", s.trend_r2 == null ? "-" : Number(s.trend_r2).toFixed(2), finiteMetric(s.trend_r2), "high"],
    ["추세·위험", "10년 추세 수익률", chartStatPercent(s.trend10_return), finiteMetric(s.trend10_return), "high"],
    ["추세·위험", "10년 추세 이탈폭", trendDeviationText(s.trend10_deviation), finiteMetric(s.trend10_deviation), "low"],
    ["추세·위험", "10년 추세 강도", trendStrengthText(s.trend10_strength), finiteMetric(s.trend10_strength), "high"],
    ["추세·위험", "52주 고점 대비", chartStatPercent(s.drawdown_52w), finiteMetric(s.drawdown_52w), "high"],
    ["추세·위험", "변동성 손익비", riskRewardScoreText(s.risk_reward_score), finiteMetric(s.risk_reward_score), "high"],
    ["추세·위험", "β", betaText(s.beta), finiteMetric(s.beta), "lowAbs"],
    ["추세·위험", "β″", betaText(s.beta_adj), finiteMetric(s.beta_adj), "lowAbs"],
  ];
}

// 값 없음은 null — Number(null)은 0이라 β가 없는 종목이 비교 보드에서 'lowAbs' 최고 표시를 가져갔다.
function finiteMetric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// 지표판 항목을 열로 나눈다 — 묶음 제목이 열의 마지막 칸에 홀로 남지 않게, 그 자리는 비우고 제목을 다음 열로 넘긴다.
// size는 열 높이(행 수), columns는 열마다 들어갈 항목(빈 자리는 호출부가 채운다).
function splitStatColumns(items, columnCount) {
  for (let size = Math.max(1, Math.ceil(items.length / columnCount)); size <= items.length + 1; size += 1) {
    const columns = [[]];
    for (const entry of items) {
      let column = columns[columns.length - 1];
      if (column.length === size || (entry.head && column.length === size - 1)) {
        column = [];
        columns.push(column);
      }
      column.push(entry);
    }
    if (columns.length <= columnCount) {
      while (columns.length < columnCount) columns.push([]);
      return { size, columns };
    }
  }
  return { size: items.length, columns: [items, ...Array.from({ length: columnCount - 1 }, () => [])] };
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
  // 산식 설명이 있는 지표는 행 전체에 툴팁을 단다(헤더가 없는 패널이라 값 옆에 붙인다).
  const metricTitles = { "β": BETA_TOOLTIP, "β″": BETA_ADJ_TOOLTIP };
  const row = ([, label, value], mobileOrder = 0, edge = "") => `
    <div class="cstat-row${edge}" style="--mobile-order:${mobileOrder}"${
      metricTitles[label] ? ` title="${esc(metricTitles[label])}"` : ""}>
      <span class="cstat-k">${esc(label)}</span>
      <span class="cstat-v">${value ?? ""}</span>
    </div>
  `;
  // 묶음이 바뀌는 자리에 제목 줄을 끼운다. 지표 순서는 그대로다.
  const items = [];
  rows.forEach((item, index) => {
    if (index === 0 || rows[index - 1][0] !== item[0]) items.push({ head: item[0] });
    items.push({ item });
  });
  const head = (name, order, cls = "") => `
    <div class="cstat-row cstat-head${cls}" style="--mobile-order:${order}"><span class="cstat-h">${esc(name)}</span></div>
  `;
  // PC는 4열 가로 우선 격자에 열 우선 순서로 채우고, 2열 배치(모바일·레일)는 같은 순서를 --mobile-order로 따른다.
  // 2열 순번은 2배로 띄워 둔다 — 그 사이에 2열 전용 빈 칸(.m-filler)을 끼울 자리다.
  const pc = splitStatColumns(items, 4);
  const mobile = splitStatColumns(items, 2);
  const orderOf = new Map(items.map((entry, index) => [entry, index * 2]));
  const statCells = [];
  for (let rowIndex = 0; rowIndex < pc.size; rowIndex += 1) {
    pc.columns.forEach((column, columnIndex) => {
      const entry = column[rowIndex];
      const edge = `${columnIndex === pc.columns.length - 1 ? " pc-col-end" : ""}${rowIndex === pc.size - 1 ? " pc-row-end" : ""}`;
      if (!entry) statCells.push(`<div class="cstat-row empty${edge}"><span class="cstat-k"></span><span class="cstat-v"></span></div>`);
      else if (entry.head) statCells.push(head(entry.head, orderOf.get(entry), edge));
      else statCells.push(row(entry.item, orderOf.get(entry), edge));
    });
  }
  // 2열에서 왼쪽 열이 제목 앞에서 끊겼으면 그 자리를, 오른쪽 열이 짧으면 끝을 빈 칸으로 채운다(선이 끊기지 않게).
  const mobileFillers = [];
  const leftGap = mobile.size - mobile.columns[0].length;
  for (let i = 0; i < leftGap; i += 1) mobileFillers.push(mobile.columns[0].length * 2 - 1);
  const rightGap = mobile.size - mobile.columns[1].length;
  for (let i = 0; i < rightGap; i += 1) mobileFillers.push(items.length * 2 + i);
  mobileFillers.forEach(order => {
    statCells.push(`<div class="cstat-row m-filler" style="--mobile-order:${order}"><span class="cstat-k"></span><span class="cstat-v"></span></div>`);
  });

  el.innerHTML = `
    <div class="cstat-board" style="--mobile-rows:${mobile.size}">
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
  const extendedMode = usExtendedEnabled();
  const key = `${extendedMode ? "extended" : "regular"}:${unique.join(",")}`;
  if (chartStatsLoadKey === key) return;
  chartStatsLoadKey = key;
  apiFetchStats(unique, extendedMode).then(response => {
    if (usExtendedEnabled() !== extendedMode) {
      chartStatsLoadKey = "";
      return;
    }
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

function chartPctMetric(value, neutral = "0.0%", neutralCls = "flat") {
  const number = Number(value);
  if (!Number.isFinite(number)) return { text: "-", cls: "flat" };
  // 소수 한 자리로 보여주므로 0.05% 미만은 사실상 0 — 중립 라벨(ATH/ATL)로 흡수한다
  if (Math.abs(number) < 0.05) return { text: neutral, cls: neutralCls };
  const { cls, arrow } = changeDirection(number); // 0은 위에서 중립으로 걸렀다
  return { text: `${arrow} ${fmt1.format(Math.abs(number))}%`, cls };
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

// ── 차트 왼쪽 위 오버레이 끌어 옮기기(2026-11-12 사용자 지시) ──
// 종목 차트 '선택 기간' 상자와 성과 차트 수익률 상자. 위치는 움직일 수 있는 범위 안의 비율(0~1)로
// 이 브라우저에 기억해 기간·창 크기가 바뀌어도 같은 자리에 온다. 두 번 누르면 기본 자리(왼쪽 위).
const CHART_OVERLAY_POS_KEYS = {
  price: "portfolio.chart.metricOverlayPos",
  performance: "portfolio.chart.perfOverlayPos",
};

function clampUnit(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function chartOverlayPosition(kind) {
  try {
    const saved = JSON.parse(storageGet(CHART_OVERLAY_POS_KEYS[kind]) || "null");
    if (saved && typeof saved === "object") return { x: clampUnit(saved.x), y: clampUnit(saved.y) };
  } catch {
    // 깨진 값은 기본 자리로
  }
  return { x: 0, y: 0 };
}

function saveChartOverlayPosition(kind, pos) {
  storageSet(CHART_OVERLAY_POS_KEYS[kind], pos ? JSON.stringify({ x: clampUnit(pos.x), y: clampUnit(pos.y) }) : "");
}

// range(): 지금 움직일 수 있는 거리(화면 px) {w, h}. apply(pos): 비율 위치를 화면에 반영.
// enabled(): false면 끌기를 받지 않는다(모바일 성과 차트처럼 흐름 배치일 때).
function bindChartOverlayDrag(handle, kind, { range, apply, enabled = () => true }) {
  if (!handle || handle.dataset?.overlayDragBound) return;
  if (handle.dataset) handle.dataset.overlayDragBound = "1";
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !enabled()) return;
    event.preventDefault();
    event.stopPropagation();
    const start = chartOverlayPosition(kind);
    const { w, h } = range();
    const startX = event.clientX;
    const startY = event.clientY;
    let pos = start;
    try {
      handle.setPointerCapture?.(event.pointerId);   // 상자 밖으로 빨리 끌어도 놓치지 않게
    } catch {
      // 이미 끝난 포인터 등 — 캡처 없이도 끌기는 된다
    }
    handle.classList.add("dragging");
    const move = moveEvent => {
      pos = {
        x: clampUnit(start.x + (w > 0 ? (moveEvent.clientX - startX) / w : 0)),
        y: clampUnit(start.y + (h > 0 ? (moveEvent.clientY - startY) / h : 0)),
      };
      apply(pos);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.classList.remove("dragging");
      saveChartOverlayPosition(kind, pos);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  handle.addEventListener("dblclick", event => {
    if (!enabled()) return;
    event.stopPropagation();
    saveChartOverlayPosition(kind, null);
    apply({ x: 0, y: 0 });
  });
}

function chartMetricsOverlaySize(compact = false) {
  return compact ? { width: 146, height: 96 } : { width: 120, height: 76 };
}

// 종목 차트: 상자를 플롯(가격 칸) 안에서만 움직인다. room은 SVG 단위.
function renderDraggableChartMetricsOverlay(metrics, pad, plotW, plotH, compact = false) {
  const { width, height } = chartMetricsOverlaySize(compact);
  const roomW = Math.max(0, plotW - 20 - width);
  const roomH = Math.max(0, plotH - 20 - height);
  const pos = chartOverlayPosition("price");
  return `
    <g id="chartMetricDrag" class="chart-metric-drag" data-room-w="${roomW.toFixed(2)}" data-room-h="${roomH.toFixed(2)}"
      transform="translate(${(pos.x * roomW).toFixed(2)}, ${(pos.y * roomH).toFixed(2)})">
      <title>끌어서 옮기기 · 두 번 누르면 원래 자리</title>
      ${renderChartMetricsOverlay(metrics, pad.left + 10, pad.top + 10, compact)}
    </g>
  `;
}

function bindChartMetricsOverlayDrag() {
  const group = document.getElementById("chartMetricDrag");
  if (!group) return;
  const roomW = Number(group.dataset.roomW) || 0;
  const roomH = Number(group.dataset.roomH) || 0;
  bindChartOverlayDrag(group, "price", {
    range: () => {
      const ctm = group.ownerSVGElement?.getScreenCTM?.();
      return { w: roomW * (ctm?.a || 1), h: roomH * (ctm?.d || 1) };
    },
    apply: pos => group.setAttribute("transform", `translate(${(pos.x * roomW).toFixed(2)}, ${(pos.y * roomH).toFixed(2)})`),
  });
}

function renderChartMetricsOverlay(metrics, x, y, compact = false) {
  // 고정폭 숫자 + 소수 한 자리라 값 폭이 일정하다 — 라벨과 값 사이 빈 공간을 좁힌다
  const { width, height } = chartMetricsOverlaySize(compact);
  const titleY = y + (compact ? 18 : 15);
  const rowStartY = y + (compact ? 38 : 31);
  const rowGap = compact ? 17 : 13.5;
  const labelX = x + (compact ? 11 : 9);
  const valueX = x + width - (compact ? 10 : 8);
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
  const extendedMode = usExtendedEnabled();
  apiFetchStats([clean], extendedMode).then(payload => {
    if (usExtendedEnabled() !== extendedMode) return;
    statsData = { ...statsData, ...(payload.stats || {}) };
    if (chartTicker === clean && !performanceChartOpen && !chartComparePayloads.length) {
      renderChartStats(chartPayload || { ticker: clean });
    }
  }).catch(() => {});
}

(window.__loaded = window.__loaded || new Set()).add("app-chart-metrics");

// Chart statistics, comparison board, and overlay metrics.

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
  return [
    ["규모", "시총/AUM", mcap, scaleRaw, "high"],
    ["배당", "배당수익률", dividendYieldCell, Number.isFinite(dividendYield) ? dividendYield : null, "high"],
    ["배당", "5년 배당성장률", chartStatPercent(s.dividend_growth_5y), finiteMetric(s.dividend_growth_5y), "high"],
    ["배당", "연속 지급", dividendStreakText(s.dividend_streak_years, s.dividend_streak_floor), finiteMetric(s.dividend_streak_years), "high"],
    ["배당", "연속 증액", dividendStreakText(s.dividend_growth_streak_years), finiteMetric(s.dividend_growth_streak_years), "high"],
    ["배당", "배당성향", fractionPercentText(s.payout_ratio), finiteMetric(s.payout_ratio), null],
    ["밸류", "P/E (t)", peText(s.trailing_pe), positiveMetric(s.trailing_pe), "low"],
    ["밸류", "P/E (f)", peText(s.forward_pe), positiveMetric(s.forward_pe), "low"],
    ["밸류", "P/B", peText(s.price_to_book), positiveMetric(s.price_to_book), "low"],
    ["일정", "실적일", earningsText(s.next_earnings_date), null, null],
    ["수익성", "총이익률", fractionPercentText(s.gross_margin), finiteMetric(s.gross_margin), "high"],
    ["수익성", "영업이익률", fractionPercentText(s.operating_margin), finiteMetric(s.operating_margin), "high"],
    ["수익성", "EBITDA 마진", fractionPercentText(s.ebitda_margin), finiteMetric(s.ebitda_margin), "high"],
    ["수익성", "순이익률", fractionPercentText(s.profit_margin), finiteMetric(s.profit_margin), "high"],
    ["수익성", "ROA", fractionPercentText(s.return_on_assets), finiteMetric(s.return_on_assets), "high"],
    ["수익성", "ROE", fractionPercentText(s.return_on_equity), finiteMetric(s.return_on_equity), "high"],
    ["성장", "매출 (YoY)", fractionSignedPercentText(s.revenue_growth), finiteMetric(s.revenue_growth), "high"],
    ["성장", "이익 (YoY)", fractionSignedPercentText(s.earnings_growth), finiteMetric(s.earnings_growth), "high"],
    ["성장", "분기이익 (YoY)", fractionSignedPercentText(s.earnings_quarterly_growth), finiteMetric(s.earnings_quarterly_growth), "high"],
    ["재무", "부채비율", rawPercentText(s.debt_to_equity), positiveMetric(s.debt_to_equity), "low"],
    ["재무", "FCF", freeCashFlowText(s.free_cash_flow, financialCurrency), freeCashFlowUsd, "high"],
    ["공매도", "유통주식 비율", fractionPercentText(s.short_percent_float), finiteMetric(s.short_percent_float), "low"],
    ["공매도", "발행주식 비율", fractionPercentText(s.short_percent_shares), finiteMetric(s.short_percent_shares), "low"],
    ["공매도", "커버일", numberText(s.short_ratio, 1), finiteMetric(s.short_ratio), "low"],
    ["보유율", "내부자", fractionPercentText(s.insider_ownership), finiteMetric(s.insider_ownership), "high"],
    ["보유율", "기관", fractionPercentText(s.institutional_ownership), finiteMetric(s.institutional_ownership), "high"],
    ["모멘텀", "RSI (일)", chartStatIndicator(rsi.day, "rsi"), finiteMetric(rsi.day), "near50"],
    ["모멘텀", "RSI (주)", chartStatIndicator(rsi.week, "rsi"), finiteMetric(rsi.week), "near50"],
    ["모멘텀", "RSI (월)", chartStatIndicator(rsi.month, "rsi"), finiteMetric(rsi.month), "near50"],
    ["모멘텀", "BB (일)", chartStatIndicator(bb.day, "bb"), finiteMetric(bb.day), "near50"],
    ["모멘텀", "BB (주)", chartStatIndicator(bb.week, "bb"), finiteMetric(bb.week), "near50"],
    ["모멘텀", "BB (월)", chartStatIndicator(bb.month, "bb"), finiteMetric(bb.month), "near50"],
    ["성과", "1주", chartStatPercent(perf.one_week), finiteMetric(perf.one_week), "high"],
    ["성과", "1개월", chartStatPercent(perf.one_month), finiteMetric(perf.one_month), "high"],
    ["성과", "3개월", chartStatPercent(perf.three_month, 0), finiteMetric(perf.three_month), "high"],
    ["성과", "6개월", chartStatPercent(perf.six_month, 0), finiteMetric(perf.six_month), "high"],
    ["성과", "YTD", chartStatPercent(perf.ytd, 0), finiteMetric(perf.ytd), "high"],
    ["성과", "1년", chartStatPercent(perf.one_year, 0), finiteMetric(perf.one_year), "high"],
    ["성과", "3년", chartStatPercent(perf.three_year, 0), finiteMetric(perf.three_year), "high"],
    ["성과", "5년", chartStatPercent(perf.five_year, 0), finiteMetric(perf.five_year), "high"],
    ["성과", "10년", chartStatPercent(perf.ten_year, 0), finiteMetric(perf.ten_year), "high"],
    ["위험", "52주 고점 대비", chartStatPercent(s.drawdown_52w), finiteMetric(s.drawdown_52w), "high"],
    ["위험", "변동성 손익비", riskRewardScoreText(s.risk_reward_score, s.risk_reward_basis, s.risk_reward_quality), finiteMetric(s.risk_reward_score), "high"],
    ["위험", "진입 손익비", entryRewardText(s.entry_risk_reward), finiteMetric(s.entry_risk_reward), "high"],
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
      <span class="cstat-v">${value ?? ""}</span>
    </div>
  `;
  const columnCount = 4;
  const rowsPerColumn = Math.ceil(rows.length / columnCount);
  const columns = Array.from(
    { length: columnCount },
    (_, index) => rows.slice(index * rowsPerColumn, (index + 1) * rowsPerColumn)
  );
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
  const cls = number > 0 ? "up" : "down";
  const arrow = number > 0 ? "▲" : "▼";
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

function renderChartMetricsOverlay(metrics, x, y, compact = false) {
  // 고정폭 숫자 + 소수 한 자리라 값 폭이 일정하다 — 라벨과 값 사이 빈 공간을 좁힌다
  const width = compact ? 146 : 120;
  const height = compact ? 96 : 76;
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

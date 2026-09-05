// 관심목록의 순서·헤더·폭·셀 포맷을 함께 관리한다. 숨긴 열은 DOM에 만들지 않는다.
const INTEREST_COLUMN_GROUPS = {
  "momentum": "모멘텀",
  "value": "밸류",
  "profitability": "수익성",
  "growth": "성장",
  "finance": "재무",
  "dividend-policy": "배당정책",
  "short-interest": "공매도",
  "ownership": "보유율",
  "consensus": "컨센서스"
};

const INTEREST_COLUMNS = [
  { key: "logo", width: 40, label: "", headClass: "logo-col interest-leaf-head", ariaHidden: true, cellClass: "logo-cell", always: true,
    cell: (r, group) => `${logoMarkup(r)}` },
  { key: "name", width: 165, label: "<span data-interest-sort-key=\"ticker\">티커</span><span class=\"name-head-sep\">·</span><span data-interest-sort-key=\"name\">종목</span>", headClass: "name-head interest-leaf-head", always: true,
    cell: (r, group) => `<span class="ticker-text">
          <a class="ticker-link" href="${esc(chartHref(r.ticker))}" data-chart-ticker="${esc(r.ticker)}">
            <span class="asset-name">${esc(r.name)}</span>
            <span class="interest-ticker-meta">
              <span class="ticker-symbol">${esc(r.ticker)}</span>
              ${r.sector ? `<span class="sector-chip" title="${esc(sectorLabel(r.sector))}">${esc(sectorLabel(r.sector))}</span>` : ""}
            </span>
          </a>
        </span>` },
  { key: "display_change_pct", width: 85, label: "등락", headClass: "group-start interest-leaf-head", cellClass: "group-start", always: true,
    cell: (r, group) => `${changeMarkup(r)}` },
  { key: "extended_change_pct", width: 71, label: "연장", headClass: "interest-leaf-head",
    cell: (r, group) => `${extendedChangeText(r) || "-"}` },
  { key: "current_price", width: 109, label: "현재단가", headClass: "interest-leaf-head", always: true,
    cell: (r, group) => `${currentPriceMarkup(r)}` },
  { key: "market_cap_usd", width: 76, label: "시총/AUM", headClass: "group-start interest-leaf-head", cellClass: "group-start",
    cell: (r, group) => `${marketCapMarkup(r)}` },
  { key: "dividend_yield", width: 54, label: "배당율", headClass: "interest-leaf-head",
    cell: (r, group) => `${Number(r.dividend_yield) > 0
        ? `<button class="stat-yield-link" type="button" data-dividend-history="${esc(r.ticker)}">${dividendYieldText(r.dividend_yield)}</button>`
        : dividendYieldText(r.dividend_yield)}` },
  { key: "dividend_growth_5y", width: 78, label: "<span>배당성장</span><span>(5년)</span>", headClass: "indicator-head interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.dividend_growth_5y, 1)}` },
  { key: "dividend_streak_years", width: 54, label: "<span>연속</span><span>지급</span>", headClass: "indicator-head interest-leaf-head", title: "상장 이래 배당을 거른 해 없이 지급한 연속 연수(완결 연도 기준, 미국 상장만). +는 이력 한계(1962)로 실제는 더 긺",
    cell: (r, group) => `${dividendStreakText(r.dividend_streak_years, r.dividend_streak_floor)}` },
  { key: "dividend_growth_streak_years", width: 54, label: "<span>연속</span><span>증액</span>", headClass: "indicator-head interest-leaf-head", title: "연간 배당을 연속으로 늘린 연수(미국 상장만). 개별주는 StockAnalysis 공식 값, ETF는 자체 계산",
    cell: (r, group) => `${dividendStreakText(r.dividend_growth_streak_years)}` },
  { key: "drawdown_52w", width: 72, label: "52주高 대비", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.drawdown_52w, 1)}` },
  { key: "risk_reward_score", width: 58, label: "<span>변동성</span><span>손익비</span>", headClass: "indicator-head interest-leaf-head", title: "변동성 손익비 = 10 × Σ w(h) × 기간점수(h)\n기간점수(h) = clamp(연율수익(h) − 3%, −50, +100) ÷ max(변동성(h), 바닥)\n · 연율수익: KRW 환산 일간 총수익(배당 재투자)의 산술 연율\n · 변동성: 같은 기간 일간 수익률의 연율 표준편차(상승·하락 모두)\n · 바닥: 주식·ETF·지수 8% / 크립토 20% / FX·채권 3%\n · 창(비겹침): 5Y=3~5년 전 w=0.6 / 3Y=1~3년 전 w=0.3 / 1Y=최근 1년 w=0.1 — 없는 창은 비례 재분배\n라벨: 3Y=이력 3년, P=배당 매핑 실패·이력 미비",
    cell: (r, group) => `${riskRewardScoreText(r.risk_reward_score, r.risk_reward_basis, r.risk_reward_quality)}` },
  { key: "entry_risk_reward", width: 58, label: "<span>진입</span><span>손익비</span>", headClass: "indicator-head interest-leaf-head", title: "진입 손익비 = clamp(업사이드 ÷ 손절폭 × RSI계수 × 추세계수, 0, 20)\n · 업사이드 = 0.3×(일 볼린저 상단까지 %) + 0.7×min(주 볼린저 상단까지 %, 30) — 음수는 0\n · 손절폭 = max(1.5 × ATR(14) %, 1%)\n · RSI계수 = clamp(1 + (50 − 일RSI)/40 × 0.5, 0.25, 1.4) — 낮을수록 가점\n · 추세계수 = 0.25 + 0.75 × (a + b)/2\n     a = clamp((주RSI − 45)/10, 0, 1),  b = clamp((60일선 이격% + 2)/4, 0, 1)\n주봉 20개(상장 약 20주)·60일선 이력이 없으면 점수 없음(-)",
    cell: (r, group) => `${entryRewardText(r.entry_risk_reward)}` },
  { key: "beta", width: 42, label: "β", headClass: "interest-leaf-head",
    cell: (r, group) => `${betaText(r.beta)}` },
  { key: "beta_adj", width: 44, label: "β″", headClass: "interest-leaf-head",
    cell: (r, group) => `${betaText(r.beta_adj)}` },
  { key: "next_earnings_date", width: 60, label: "실적", headClass: "group-start interest-leaf-head", cellClass: "group-start",
    cell: (r, group) => `${earningsText(r.next_earnings_date)}` },
  { key: "rsi_day", width: 48, label: "<span>RSI</span><span>(일)</span>", headClass: "indicator-head group-start interest-leaf-head", group: "momentum", cellClass: "group-start",
    cell: (r, group) => `${indicatorText(r.rsi_day, "rsi")}` },
  { key: "rsi_week", width: 48, label: "<span>RSI</span><span>(주)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.rsi_week, "rsi")}` },
  { key: "rsi_month", width: 48, label: "<span>RSI</span><span>(월)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.rsi_month, "rsi")}` },
  { key: "bb_day", width: 48, label: "<span>BB</span><span>(일)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.bb_day, "bb")}` },
  { key: "bb_week", width: 48, label: "<span>BB</span><span>(주)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.bb_week, "bb")}` },
  { key: "bb_month", width: 48, label: "<span>BB</span><span>(월)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.bb_month, "bb")}` },
  { key: "trailing_pe", width: 62, label: "<span>P/E</span><span>(t)</span>", headClass: "indicator-head group-start interest-leaf-head", group: "value", cellClass: "group-start",
    cell: (r, group) => `${peText(r.trailing_pe)}` },
  { key: "forward_pe", width: 62, label: "<span>P/E</span><span>(f)</span>", headClass: "indicator-head interest-leaf-head", group: "value",
    cell: (r, group) => `${peText(r.forward_pe)}` },
  { key: "price_to_book", width: 44, label: "P/B", headClass: "interest-leaf-head", group: "value",
    cell: (r, group) => `${peText(r.price_to_book)}` },
  { key: "perf_1w", width: 64, label: "1주", headClass: "group-start interest-leaf-head", cellClass: "group-start",
    cell: (r, group) => `${signedPercentText(r.perf_1w, 1)}` },
  { key: "perf_1m", width: 64, label: "1개월", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_1m, 1)}` },
  { key: "perf_3m", width: 64, label: "3개월", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_3m, 0)}` },
  { key: "perf_6m", width: 64, label: "6개월", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_6m, 0)}` },
  { key: "perf_ytd", width: 64, label: "YTD", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_ytd, 0)}` },
  { key: "perf_1y", width: 64, label: "1년", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_1y, 0)}` },
  { key: "perf_3y", width: 64, label: "3년", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_3y, 0)}` },
  { key: "perf_5y", width: 64, label: "5년", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_5y, 0)}` },
  { key: "perf_10y", width: 64, label: "10년", headClass: "interest-leaf-head",
    cell: (r, group) => `${signedPercentText(r.perf_10y, 0)}` },
  { key: "gross_margin", width: 72, label: "<span>총이익률</span>", headClass: "indicator-head group-start interest-leaf-head", group: "profitability", ariaLabel: "매출총이익률", cellClass: "group-start",
    cell: (r, group) => `${fractionPercentText(r.gross_margin)}` },
  { key: "operating_margin", width: 72, label: "<span>영업</span><span>이익률</span>", headClass: "indicator-head interest-leaf-head", group: "profitability", ariaLabel: "영업이익률",
    cell: (r, group) => `${fractionPercentText(r.operating_margin)}` },
  { key: "ebitda_margin", width: 68, label: "<span>EBITDA</span><span>마진</span>", headClass: "indicator-head interest-leaf-head", group: "profitability",
    cell: (r, group) => `${fractionPercentText(r.ebitda_margin)}` },
  { key: "profit_margin", width: 72, label: "<span>순이익률</span>", headClass: "indicator-head interest-leaf-head", group: "profitability", ariaLabel: "순이익률",
    cell: (r, group) => `${fractionPercentText(r.profit_margin)}` },
  { key: "return_on_assets", width: 54, label: "ROA", headClass: "interest-leaf-head", group: "profitability",
    cell: (r, group) => `${fractionPercentText(r.return_on_assets)}` },
  { key: "return_on_equity", width: 54, label: "ROE", headClass: "interest-leaf-head", group: "profitability",
    cell: (r, group) => `${fractionPercentText(r.return_on_equity)}` },
  { key: "revenue_growth", width: 62, label: "<span>매출</span><span>(YoY)</span>", headClass: "indicator-head group-start interest-leaf-head", group: "growth", cellClass: "group-start",
    cell: (r, group) => `${fractionSignedPercentText(r.revenue_growth)}` },
  { key: "earnings_growth", width: 62, label: "<span>이익</span><span>(YoY)</span>", headClass: "indicator-head interest-leaf-head", group: "growth",
    cell: (r, group) => `${fractionSignedPercentText(r.earnings_growth)}` },
  { key: "earnings_quarterly_growth", width: 72, label: "<span>분기이익</span><span>(YoY)</span>", headClass: "indicator-head interest-leaf-head", group: "growth",
    cell: (r, group) => `${fractionSignedPercentText(r.earnings_quarterly_growth)}` },
  { key: "debt_to_equity", width: 70, label: "<span>부채</span><span>비율</span>", headClass: "indicator-head group-start interest-leaf-head", group: "finance", cellClass: "group-start",
    cell: (r, group) => `${rawPercentText(r.debt_to_equity)}` },
  { key: "free_cash_flow", width: 76, label: "FCF", headClass: "interest-leaf-head", group: "finance", ariaLabel: "잉여현금흐름",
    cell: (r, group) => `${freeCashFlowText(r.free_cash_flow, r.financial_currency || r.currency)}` },
  { key: "payout_ratio", width: 66, label: "<span>배당</span><span>성향</span>", headClass: "indicator-head group-start interest-leaf-head", group: "dividend-policy", cellClass: "group-start",
    cell: (r, group) => `${fractionPercentText(r.payout_ratio)}` },
  { key: "short_percent_float", width: 72, label: "<span>유통</span><span>비율</span>", headClass: "indicator-head group-start interest-leaf-head", group: "short-interest", ariaLabel: "유통주식 대비 공매도 비율", cellClass: "group-start",
    cell: (r, group) => `${fractionPercentText(r.short_percent_float)}` },
  { key: "short_percent_shares", width: 72, label: "<span>발행</span><span>비율</span>", headClass: "indicator-head interest-leaf-head", group: "short-interest", ariaLabel: "발행주식 대비 공매도 비율",
    cell: (r, group) => `${fractionPercentText(r.short_percent_shares)}` },
  { key: "short_ratio", width: 60, label: "<span>커버</span><span>일</span>", headClass: "indicator-head interest-leaf-head", group: "short-interest", ariaLabel: "공매도 상환 소요일",
    cell: (r, group) => `${numberText(r.short_ratio, 1)}` },
  { key: "insider_ownership", width: 64, label: "<span>내부자</span>", headClass: "indicator-head group-start interest-leaf-head", group: "ownership", cellClass: "group-start",
    cell: (r, group) => `${fractionPercentText(r.insider_ownership)}` },
  { key: "institutional_ownership", width: 64, label: "<span>기관</span>", headClass: "indicator-head interest-leaf-head", group: "ownership",
    cell: (r, group) => `${fractionPercentText(r.institutional_ownership)}` },
  { key: "target_price", width: 67, label: "목표가", headClass: "group-start interest-leaf-head", group: "consensus", cellClass: "group-start",
    cell: (r, group) => `${consensusPriceText(r.target_price, r.consensus_currency || r.currency)}` },
  { key: "upside_pct", width: 61, label: "업사이드", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${upsideText(r.upside_pct)}` },
  { key: "dispersion_pct", width: 54, label: "편차", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${dispersionText(r.dispersion_pct, quoteFor(r.ticker)?.dispersion_basis)}` },
  { key: "buy_strength", width: 76, label: "매수강도", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${buyStrengthMarkup(r.buy_strength)}` },
  { key: "rating_rank", width: 66, label: "투자의견", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${ratingChipMarkup(r.rating_label)}` },
  { key: "delete", width: 40, label: "", headClass: "group-start interest-leaf-head", ariaLabel: "삭제", cellClass: "group-start", always: true,
    cell: (r, group) => `${isProtectedInterestItem(r, group)
        ? ""
        : group.fixed
          ? `<button class="interest-row-delete" type="button" data-interest-unregister="${esc(r.ticker)}" aria-label="${esc(r.name)} 수집 제외" title="수집 대상에서 제외">×</button>`
          : `<button class="interest-row-delete" type="button" data-interest-main-remove="${esc(r.ticker)}" aria-label="${esc(r.name)} 삭제" title="관심목록에서 삭제">×</button>`}` },
].map((column, index) => ({
  ...column, index,
  numeric: !["logo", "name", "rating_rank", "delete"].includes(column.key),
}));
const INTEREST_TABLE_COLUMN_COUNT = INTEREST_COLUMNS.length;

let interestRenderedColumns = INTEREST_COLUMNS;

function hasInterestColumnValue(row, field) {
  if (field === "next_earnings_date") return Boolean(row[field]);
  if (field === "rating_rank") return row[field] != null;
  if (field === "dividend_yield") return Number(row[field]) > 0;
  return row[field] != null && Number.isFinite(Number(row[field]));
}

function visibleInterestColumns(rows, isIndexGroup = false) {
  return INTEREST_COLUMNS.filter(column => column.always || (
    !(isIndexGroup && column.key === "extended_change_pct")
    && rows.some(row => hasInterestColumnValue(row, column.key))
  ));
}

function interestColumnAttributes(column) {
  return `data-interest-col="${column.index}"`
    + (column.group ? ` data-interest-group="${column.group}"` : "");
}

function interestTableHead(columns) {
  const groups = new Map();
  columns.forEach(column => {
    if (column.group) groups.set(column.group, (groups.get(column.group) || 0) + 1);
  });
  const leaf = column => `<th ${column.group ? "" : 'rowspan="2"'} class="${column.headClass || ""}" ${interestColumnAttributes(column)}`
    + (!["logo", "name", "delete"].includes(column.key) ? ` data-interest-sort-key="${column.key}"` : "")
    + (column.title ? ` title="${esc(column.title)}"` : "")
    + (column.ariaLabel ? ` aria-label="${esc(column.ariaLabel)}"` : "")
    + (column.ariaHidden ? ' aria-hidden="true"' : "")
    + `>${column.label}</th>`;
  const seen = new Set();
  const top = columns.map(column => {
    if (!column.group) return leaf(column);
    if (seen.has(column.group)) return "";
    seen.add(column.group);
    return `<th colspan="${groups.get(column.group)}" class="group-start" data-interest-group-head="${column.group}">${INTEREST_COLUMN_GROUPS[column.group]}</th>`;
  }).join("");
  return `<tr class="interest-group-head">${top}</tr><tr class="interest-col-head">${columns.filter(column => column.group).map(leaf).join("")}</tr>`;
}

function renderInterestFrame(table, columns) {
  interestRenderedColumns = columns;
  const key = columns.map(column => column.key).join(",");
  if (table.dataset.columnKey === key) return;
  table.dataset.columnKey = key;
  table.querySelector("colgroup").innerHTML = columns.map(column =>
    `<col style="width:${column.key === "name" ? "var(--ticker-name-width, 165px)" : `${column.width}px`}">`
  ).join("");
  table.querySelector("thead").innerHTML = interestTableHead(columns);
}

function interestRowCells(row, group, columns = interestRenderedColumns) {
  return columns.map(column => `<td class="${column.cellClass || ""}${column.numeric ? " numeric-cell" : ""}" ${interestColumnAttributes(column)}>${column.cell(row, group)}</td>`).join("");
}

function interestEmptyRow(message, columns = interestRenderedColumns) {
  return `<tr class="interest-empty-row">${columns.map(column =>
    `<td ${interestColumnAttributes(column)}${column.key === "name" ? ' class="interest-empty-cell"' : ""}>${column.key === "name" ? esc(message) : ""}</td>`
  ).join("")}</tr>`;
}

(window.__loaded = window.__loaded || new Set()).add("app-interest-columns");

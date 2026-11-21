// 관심목록의 순서·헤더·폭·셀 포맷을 함께 관리한다. 숨긴 열은 DOM에 만들지 않는다.
// 열 순서는 계좌표와 같다(2026-11-20 사용자 지시): 등락·연장·현재단가 → 52주·손익비·β → 모멘텀 → 밸류 → 배당 → 수익률 → 추세 → 시총·실적 → 수익성…컨센서스.
// 폭(2026-11-09 재조정): 전 관심그룹 값의 최장폭+좌우 여백 10px(묶음 경계는 +3~4). fixed 레이아웃이라
// 폭보다 긴 값은 잘리므로 줄일 때는 전 그룹 실측으로 확인한다. 극단값 열(매출 성장 등)은 넓히지 않았다.
const INTEREST_COLUMN_GROUPS = {
  "momentum": "모멘텀",
  "value": "밸류",
  "dividend": "배당",
  "trend": "추세 5년",
  "trend10": "추세 10년",
  "profitability": "수익성",
  "growth": "성장",
  "finance": "재무",
  "short-interest": "공매도",
  "ownership": "보유율",
  "consensus": "컨센서스"
};

const INTEREST_COLUMNS = [
  { key: "logo", width: 40, label: "", headClass: "logo-col interest-leaf-head", ariaHidden: true, cellClass: "logo-cell", always: true,
    cell: (r, group) => `${companyProfileLogo(r)}` },
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
  { key: "extended_change_pct", width: 62, label: "연장", headClass: "interest-leaf-head",
    cell: (r, group) => `${extendedChangeText(r) || "-"}` },
  { key: "current_price", width: 88, label: "현재단가", headClass: "interest-leaf-head", always: true,
    cell: (r, group) => `${currentPriceMarkup(r)}` },

  { key: "drawdown_52w", width: 56, label: "<span>52주高</span><span>대비</span>", headClass: "indicator-head group-start interest-leaf-head", cellClass: "group-start", ariaLabel: "52주 고점 대비",
    cell: (r, group) => `${signedPercentText(r.drawdown_52w, 1)}` },
  { key: "risk_reward_score", width: 46, label: "<span>변동성</span><span>손익비</span>", headClass: "indicator-head interest-leaf-head", title: "변동성 손익비 = 10 × Σ w(h) × 기간점수(h)\n기간점수(h) = clamp((연율수익(h) − 3%) ÷ max(변동성(h), 바닥), −2, +2)\n · 연율수익: KRW 환산 일간 총수익(배당 재투자)의 산술 연율\n · 변동성: 같은 기간 일간 수익률의 연율 표준편차(상승·하락 모두)\n · 바닥: 주식·ETF·지수 8% / 크립토 20% / FX·채권 3%\n · 창(비겹침): 5Y=3~5년 전 w=0.4 / 3Y=1~3년 전 w=0.3 / 1Y=최근 1년 w=0.3 — 없는 창은 0점(이력 1년이면 최대 30%만 반영)",
    cell: (r, group) => `${riskRewardScoreText(r.risk_reward_score)}` },
  { key: "beta", width: 46, label: "β", headClass: "interest-leaf-head", title: BETA_TOOLTIP,
    cell: (r, group) => `${betaText(r.beta)}` },
  { key: "beta_adj", width: 48, label: "β″", headClass: "interest-leaf-head", title: BETA_ADJ_TOOLTIP,
    cell: (r, group) => `${betaText(r.beta_adj)}` },

  { key: "rsi_day", width: 36, label: "<span>RSI</span><span>(일)</span>", headClass: "indicator-head group-start interest-leaf-head", group: "momentum", cellClass: "group-start",
    cell: (r, group) => `${indicatorText(r.rsi_day, "rsi")}` },
  { key: "rsi_week", width: 34, label: "<span>RSI</span><span>(주)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.rsi_week, "rsi")}` },
  { key: "rsi_month", width: 34, label: "<span>RSI</span><span>(월)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.rsi_month, "rsi")}` },
  { key: "bb_day", width: 38, label: "<span>BB</span><span>(일)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.bb_day, "bb")}` },
  { key: "bb_week", width: 38, label: "<span>BB</span><span>(주)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.bb_week, "bb")}` },
  { key: "bb_month", width: 38, label: "<span>BB</span><span>(월)</span>", headClass: "indicator-head interest-leaf-head", group: "momentum",
    cell: (r, group) => `${indicatorText(r.bb_month, "bb")}` },
  ...[20, 50, 200].map(period => ({
    key: `ma${period}_pct`, width: period === 200 ? 70 : 60, label: `<span>이격</span><span>(${period}일)</span>`,
    headClass: "indicator-head interest-leaf-head", group: "momentum",
    title: `${period}거래일 단순이동평균선 이격률 = (현재가 ÷ 이동평균 − 1) × 100. 위면 양수, 아래면 음수. 이력이 부족하면 표시하지 않습니다.`,
    cell: r => signedPercentText(r[`ma${period}_pct`], 1),
  })),
  { key: "trailing_pe", width: 62, label: "<span>P/E</span><span>(t)</span>", headClass: "indicator-head group-start interest-leaf-head", group: "value", cellClass: "group-start",
    cell: (r, group) => `${peText(r.trailing_pe)}` },
  { key: "forward_pe", width: 50, label: "<span>P/E</span><span>(f)</span>", headClass: "indicator-head interest-leaf-head", group: "value",
    cell: (r, group) => `${peText(r.forward_pe)}` },
  { key: "price_to_book", width: 48, label: "P/B", headClass: "interest-leaf-head", group: "value",
    cell: (r, group) => `${peText(r.price_to_book)}` },
  { key: "ev_to_ebitda", width: 58, label: "<span>EV/</span><span>EBITDA</span>", headClass: "indicator-head interest-leaf-head", group: "value", ariaLabel: "EV/EBITDA", title: "기업가치(시총+순부채) ÷ EBITDA",
    cell: (r, group) => `${peText(r.ev_to_ebitda)}` },
  { key: "price_to_sales", width: 46, label: "P/S", headClass: "interest-leaf-head", group: "value", title: "시총 ÷ 최근 12개월 매출",
    cell: (r, group) => `${peText(r.price_to_sales)}` },
  { key: "peg_ratio", width: 46, label: "PEG", headClass: "interest-leaf-head", group: "value", title: "P/E ÷ 이익 성장률(야후 trailing PEG)",
    cell: (r, group) => `${ratioText(r.peg_ratio)}` },
  { key: "dividend_yield", width: 56, label: "배당율", headClass: "group-start interest-leaf-head", group: "dividend", cellClass: "group-start",
    cell: (r, group) => dividendYieldMarkup(r) },
  { key: "dividend_growth_5y", width: 66, label: "<span>성장</span><span>(5년)</span>", headClass: "indicator-head interest-leaf-head", group: "dividend", ariaLabel: "배당성장(5년)",
    cell: (r, group) => `${signedPercentText(r.dividend_growth_5y, 1)}` },
  { key: "dividend_streak_years", width: 42, label: "<span>연속</span><span>지급</span>", headClass: "indicator-head interest-leaf-head", group: "dividend", title: "상장 이래 배당을 거른 해 없이 지급한 연속 연수(완결 연도 기준, 미국 상장만). +는 이력 한계(1962)로 실제는 더 긺",
    cell: (r, group) => `${dividendStreakText(r.dividend_streak_years, r.dividend_streak_floor)}` },
  { key: "dividend_growth_streak_years", width: 40, label: "<span>연속</span><span>증액</span>", headClass: "indicator-head interest-leaf-head", group: "dividend", title: "연간 배당을 연속으로 늘린 연수(미국 상장만). 개별주는 StockAnalysis 공식 값, ETF는 자체 계산",
    cell: (r, group) => `${dividendStreakText(r.dividend_growth_streak_years)}` },
  { key: "payout_ratio", width: 58, label: "성향", headClass: "interest-leaf-head", group: "dividend", ariaLabel: "배당성향",
    cell: (r, group) => `${fractionPercentText(r.payout_ratio)}` },
  { key: "perf_1w", width: 62, label: "1주", headClass: "group-start interest-leaf-head", cellClass: "group-start",
    cell: (r, group) => `${perfText(r, "perf_1w", 1)}` },
  { key: "perf_1m", width: 58, label: "1개월", headClass: "interest-leaf-head",
    cell: (r, group) => `${perfText(r, "perf_1m", 1)}` },
  { key: "perf_3m", width: 58, label: "3개월", headClass: "interest-leaf-head",
    cell: (r, group) => `${perfText(r, "perf_3m", 0)}` },
  { key: "perf_6m", width: 58, label: "6개월", headClass: "interest-leaf-head",
    cell: (r, group) => `${perfText(r, "perf_6m", 0)}` },
  { key: "perf_ytd", width: 58, label: "YTD", headClass: "interest-leaf-head",
    cell: (r, group) => `${perfText(r, "perf_ytd", 0)}` },
  { key: "perf_1y", width: 58, label: "1년", headClass: "interest-leaf-head",
    cell: (r, group) => `${perfText(r, "perf_1y", 0)}` },
  { key: "perf_3y", width: 64, label: "3년", headClass: "interest-leaf-head", ariaLabel: "3년 연평균 복리수익률",
    cell: (r, group) => `${perfText(r, "perf_3y", 1)}` },
  { key: "perf_5y", width: 64, label: "5년", headClass: "interest-leaf-head", ariaLabel: "5년 연평균 복리수익률",
    cell: (r, group) => `${perfText(r, "perf_5y", 1)}` },
  { key: "perf_10y", width: 62, label: "10년", headClass: "interest-leaf-head", ariaLabel: "10년 연평균 복리수익률",
    cell: (r, group) => `${perfText(r, "perf_10y", 1)}` },
  { key: "trend_return", width: 64, label: "수익률", headClass: "group-start interest-leaf-head", group: "trend", cellClass: "group-start", ariaLabel: "추세 수익률", title: "추세 수익률 = 최근 5년(1,260거래일) 배당 재투자 가격의 로그값에 직선을 맞춘 기울기의 연율 환산\n기간 수익률(CAGR)은 시작·끝 두 점만 보지만 이 값은 경로 전체를 반영해 막판 급등에 덜 흔들린다\n5년 중 가운데 3년의 비중이 크고(약 80%) 최근 6개월은 거의 반영하지 않는다\n이력이 5년보다 짧으면 있는 만큼(최소 1년)으로 계산",
    cell: (r, group) => `${trendReturnText(r.trend_return)}` },
  { key: "trend_deviation", width: 60, label: "이탈폭", headClass: "interest-leaf-head", group: "trend", ariaLabel: "추세 이탈폭", title: "추세 이탈폭 = 최근 5년 배당 재투자 가격이 추세 직선에서 벗어난 폭의 표준편차(잔차 표준편차, 로그 기준 %)\n작을수록 직선처럼 꾸준하다. 가격이 많이 올랐는지와 무관하게 흔들림의 크기만 본다\n이력이 5년보다 짧으면 5년 기준으로 환산한다(× √(1260 ÷ 실제 일수)) — 짧은 이력이 꾸준해 보이지 않게\n예: ±47%(PLTR)는 큰 등락, ±8%(SPY)는 직선에 가까움",
    cell: (r, group) => `${trendDeviationText(r.trend_deviation)}` },
  { key: "trend_strength", width: 48, label: "강도", headClass: "interest-leaf-head", group: "trend", ariaLabel: "추세 강도", title: "추세 강도 = ln(1 + 추세 수익률) ÷ 추세 이탈폭\n높을수록 흔들림에 비해 많이 올랐다. 분자는 연속복리 수익률이라 급등 종목도 복리로 부풀지 않는다\n예: 추세 수익률 +50%, 이탈폭 ±20% → 40.5 ÷ 20 = 2.03",
    cell: (r, group) => `${trendStrengthText(r.trend_strength)}` },
  { key: "trend10_return", width: 64, label: "수익률", headClass: "group-start interest-leaf-head", group: "trend10", cellClass: "group-start", ariaLabel: "10년 추세 수익률", title: "10년 추세 수익률 = 최근 10년 배당 재투자 가격의 로그값에 직선을 맞춘 기울기의 연율 환산(5년 추세와 같은 산식, 창만 10년)\n5년 추세가 좋아도 그 전 몇 년을 횡보했으면 여기서 낮아진다 — 오래 꾸준히 올랐는지 보는 값\n이력이 10년보다 짧으면 비워 둔다",
    cell: (r, group) => `${trendReturnText(r.trend10_return)}` },
  { key: "trend10_deviation", width: 60, label: "이탈폭", headClass: "interest-leaf-head", group: "trend10", ariaLabel: "10년 추세 이탈폭", title: "10년 추세 이탈폭 = 최근 10년 배당 재투자 가격이 추세 직선에서 벗어난 폭의 표준편차(잔차 표준편차, 로그 기준 %)\n작을수록 10년 내내 직선처럼 꾸준했다. 창이 길어 5년 이탈폭보다 큰 편이라 10년끼리만 비교한다\n예: CAH ±29%(2016~2020 횡보 뒤 급등), COST ±10%",
    cell: (r, group) => `${trendDeviationText(r.trend10_deviation)}` },
  { key: "trend10_strength", width: 48, label: "강도", headClass: "interest-leaf-head", group: "trend10", ariaLabel: "10년 추세 강도", title: "10년 추세 강도 = ln(1 + 10년 추세 수익률) ÷ 10년 추세 이탈폭\n5년 강도는 높은데 10년 강도가 낮으면 최근에만 좋았던 종목이다\n예: CAH 5년 3.98 → 10년 0.55, COST 1.55 → 2.14",
    cell: (r, group) => `${trendStrengthText(r.trend10_strength)}` },
  { key: "market_cap_usd", width: 76, label: "시총/AUM", headClass: "group-start interest-leaf-head", cellClass: "group-start",
    cell: (r, group) => `${marketCapMarkup(r)}` },
  { key: "expense_ratio", width: 50, label: "보수", headClass: "interest-leaf-head", ariaLabel: "ETF 운용보수", title: "ETF 운용보수(연 %) — 미국 야후 netExpenseRatio, 한국 네이버 총보수",
    cell: (r, group) => `${expenseRatioText(r.expense_ratio)}` },
  { key: "next_earnings_date", width: 52, label: "실적", headClass: "interest-leaf-head",
    cell: (r, group) => `${earningsText(r.next_earnings_date)}` },
  { key: "gross_margin", width: 64, label: "<span>총이익률</span>", headClass: "indicator-head group-start interest-leaf-head", group: "profitability", ariaLabel: "매출총이익률", cellClass: "group-start",
    cell: (r, group) => `${fractionPercentText(r.gross_margin)}` },
  { key: "operating_margin", width: 72, label: "<span>영업</span><span>이익률</span>", headClass: "indicator-head interest-leaf-head", group: "profitability", ariaLabel: "영업이익률",
    cell: (r, group) => `${fractionPercentText(r.operating_margin)}` },
  { key: "ebitda_margin", width: 60, label: "<span>EBITDA</span><span>마진</span>", headClass: "indicator-head interest-leaf-head", group: "profitability",
    cell: (r, group) => `${fractionPercentText(r.ebitda_margin)}` },
  { key: "profit_margin", width: 60, label: "<span>순이익률</span>", headClass: "indicator-head interest-leaf-head", group: "profitability", ariaLabel: "순이익률",
    cell: (r, group) => `${fractionPercentText(r.profit_margin)}` },
  { key: "return_on_assets", width: 54, label: "ROA", headClass: "interest-leaf-head", group: "profitability",
    cell: (r, group) => `${fractionPercentText(r.return_on_assets)}` },
  { key: "return_on_equity", width: 64, label: "ROE", headClass: "interest-leaf-head", group: "profitability",
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
  { key: "current_ratio", width: 52, label: "<span>유동</span><span>비율</span>", headClass: "indicator-head interest-leaf-head", group: "finance", ariaLabel: "유동비율", title: "유동자산 ÷ 유동부채(배)",
    cell: (r, group) => `${ratioText(r.current_ratio)}` },
  { key: "net_cash", width: 76, label: "<span>순현금</span>", headClass: "indicator-head interest-leaf-head", group: "finance", ariaLabel: "순현금", title: "현금 − 총부채(재무통화, 음수면 순부채)",
    cell: (r, group) => `${freeCashFlowText(r.net_cash, r.financial_currency || r.currency)}` },
  { key: "short_percent_float", width: 52, label: "<span>유통</span><span>비율</span>", headClass: "indicator-head group-start interest-leaf-head", group: "short-interest", ariaLabel: "유통주식 대비 공매도 비율", cellClass: "group-start",
    cell: (r, group) => `${fractionPercentText(r.short_percent_float)}` },
  { key: "short_percent_shares", width: 48, label: "<span>발행</span><span>비율</span>", headClass: "indicator-head interest-leaf-head", group: "short-interest", ariaLabel: "발행주식 대비 공매도 비율",
    cell: (r, group) => `${fractionPercentText(r.short_percent_shares)}` },
  { key: "short_ratio", width: 44, label: "<span>커버</span><span>일</span>", headClass: "indicator-head interest-leaf-head", group: "short-interest", ariaLabel: "공매도 상환 소요일",
    cell: (r, group) => `${numberText(r.short_ratio, 1)}` },
  { key: "insider_ownership", width: 52, label: "<span>내부자</span>", headClass: "indicator-head group-start interest-leaf-head", group: "ownership", cellClass: "group-start",
    cell: (r, group) => `${fractionPercentText(r.insider_ownership)}` },
  { key: "institutional_ownership", width: 58, label: "<span>기관</span>", headClass: "indicator-head interest-leaf-head", group: "ownership",
    cell: (r, group) => `${fractionPercentText(r.institutional_ownership)}` },
  { key: "target_price", width: 76, label: "목표가", headClass: "group-start interest-leaf-head", group: "consensus", cellClass: "group-start",
    cell: (r, group) => `${consensusPriceText(r.target_price, r.consensus_currency || r.currency)}` },
  { key: "upside_pct", width: 61, label: "업사이드", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${upsideText(r.upside_pct)}` },
  { key: "dispersion_pct", width: 54, label: "편차", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${dispersionText(r.dispersion_pct, quoteFor(r.ticker)?.dispersion_basis)}` },
  { key: "buy_strength", width: 76, label: "매수강도", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${buyStrengthMarkup(r.buy_strength)}` },
  { key: "rating_rank", width: 72, label: "투자의견", headClass: "interest-leaf-head", group: "consensus",
    cell: (r, group) => `${ratingChipMarkup(r.rating_label)}` },
  // 맨 끝 칸: 찐관심 별 + 삭제(2026-10-30 별을 종목명 앞에서 이리로 옮김)
  // 버튼 두 개(26px×2)+칸 여백이 들어가야 해서 좁은 화면 축소(--col-scale)에서 뺀다 — 64px·축소 때 ×가 잘렸다
  { key: "delete", width: 76, noScale: true, label: "", headClass: "group-start interest-leaf-head interest-delete-col", ariaLabel: "찐관심·삭제", cellClass: "group-start interest-delete-col", always: true,
    cell: (r, group) => `<span class="row-actions">${favoriteStarMarkup(r)}${isProtectedInterestItem(r, group) || group?.favorite || group?.all
        // 찐관심 목록은 별(해제)로 빠지므로 삭제 버튼을 두지 않는다(2026-11-07)
        ? ""
        : group.fixed
          ? `<button class="interest-row-delete" type="button" data-interest-unregister="${esc(r.ticker)}" aria-label="${esc(r.name)} 수집 제외" title="수집 대상에서 제외">×</button>`
          : `<button class="interest-row-delete" type="button" data-interest-main-remove="${esc(r.ticker)}" aria-label="${esc(r.name)} 삭제" title="관심목록에서 삭제">×</button>`}</span>` },
].map((column, index) => ({
  ...column, index,
  numeric: !["logo", "name", "rating_rank", "delete"].includes(column.key),
}));
const INTEREST_TABLE_COLUMN_COUNT = INTEREST_COLUMNS.length;

let interestRenderedColumns = INTEREST_COLUMNS;

// ── 열 묶음(2026-11-20 사용자 승인, 디자인 재검토 05) — 계좌표·관심목록 공용 ─────────────────────
// 계좌표는 49열, 관심목록은 60열 남짓이라 가로 스크롤 하나로는 원하는 값을 찾기 어렵다(휴대폰은 화면의 6배).
// 도구 줄의 '열' 선택으로 종목·등락·현재가 옆에 고른 묶음만 붙여 본다. '전체'는 예전 그대로의 가로 스크롤 표.
// 묶음은 열의 데이터 키로 정한다 — 계좌표 헤더의 data-key, 관심목록 열 정의의 key가 같은 이름을 쓴다.
const COLUMN_PRESETS = [
  { key: "all", label: "전체" },
  { key: "summary", label: "요약" },
  { key: "tech", label: "기술" },
  { key: "value", label: "밸류" },
  { key: "dividend", label: "배당" },
  { key: "perf", label: "수익률" },
  { key: "trend", label: "추세·위험" },
  { key: "fund", label: "재무" },
  { key: "consensus", label: "컨센서스" },
];
// 어느 묶음에서나 보이는 열.
const COLUMN_PRESET_ALWAYS = new Set(["logo", "name", "display_change_pct", "current_price", "delete"]);
const COLUMN_PRESET_KEYS = {
  summary: ["extended_change_pct", "qty", "change_krw", "value_krw", "weight_pct", "trade"],
  tech: ["drawdown_52w", "rsi_day", "rsi_week", "rsi_month", "bb_day", "bb_week", "bb_month", "ma20_pct", "ma50_pct", "ma200_pct"],
  value: ["trailing_pe", "forward_pe", "price_to_book", "ev_to_ebitda", "price_to_sales", "peg_ratio", "market_cap_usd", "expense_ratio", "next_earnings_date"],
  dividend: ["dividend_yield", "dividend_growth_5y", "yield_on_cost", "dividend_streak_years", "dividend_growth_streak_years", "payout_ratio"],
  perf: ["perf_1w", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y", "perf_3y", "perf_5y", "perf_10y"],
  trend: ["risk_reward_score", "beta", "beta_adj", "trend_return", "trend_deviation", "trend_strength",
    "trend10_return", "trend10_deviation", "trend10_strength"],
  // 계좌표도 관심목록과 같은 재무·컨센서스 열을 가진다(2026-11-20) — 계좌표 열에는 group이 없어 키로 정한다.
  fund: ["gross_margin", "operating_margin", "ebitda_margin", "profit_margin", "return_on_assets", "return_on_equity",
    "revenue_growth", "earnings_growth", "earnings_quarterly_growth", "debt_to_equity", "free_cash_flow", "current_ratio", "net_cash",
    "short_percent_float", "short_percent_shares", "short_ratio", "insider_ownership", "institutional_ownership"],
  consensus: ["target_price", "upside_pct", "dispersion_pct", "buy_strength", "rating_rank"],
};
// 관심목록에는 수량·평가액이 없어 '요약'이 비므로 시총·52주 고점 대비·실적일을 더한다.
const COLUMN_PRESET_INTEREST_SUMMARY = ["market_cap_usd", "drawdown_52w", "next_earnings_date"];
// 관심목록 전용 묶음은 열 정의의 group으로 정한다.
const COLUMN_PRESET_INTEREST_GROUPS = {
  fund: ["profitability", "growth", "finance", "short-interest", "ownership"],
  consensus: ["consensus"],
};

function columnPresetOptions(table) {
  return COLUMN_PRESETS.filter(preset => !preset.tables || preset.tables.includes(table));
}
// 좁은 화면의 '요약'도 PC와 같은 열(등락·연장·현재단가·수량·등락금액·평가액·비중·거래) — 2026-11-21 사용자 지시로
// 현재단가·수량을 다시 보인다(예전엔 평가액을 앞당기려 뺐다).
function columnPresetCompact() {
  return Boolean(window.matchMedia?.("(max-width: 980px)")?.matches);
}
// table: "detail"(계좌표) | "interest"(관심목록). group은 관심목록 열 정의의 group.
function columnInPreset(key, preset, table = "detail", group = "") {
  if (!preset || preset === "all") return true;
  if (COLUMN_PRESET_ALWAYS.has(key)) return true;
  if (COLUMN_PRESET_KEYS[preset]?.includes(key)) return true;
  if (table !== "interest") return false;
  if (preset === "summary" && COLUMN_PRESET_INTEREST_SUMMARY.includes(key)) return true;
  return Boolean(COLUMN_PRESET_INTEREST_GROUPS[preset]?.includes(group));
}

// 고른 묶음은 표마다 이 브라우저에 기억한다. 고른 적이 없으면 좁은 화면은 '요약', PC는 '전체'.
let columnPresetChoice = null;
function columnPresetDefault() {
  return columnPresetCompact() ? "summary" : "all";
}
function activeColumnPreset(table) {
  if (!columnPresetChoice) {
    try { columnPresetChoice = JSON.parse(storageGet(detailStorage.columnPreset) || "{}") || {}; } catch { columnPresetChoice = {}; }
  }
  const chosen = columnPresetChoice[table];
  return columnPresetOptions(table).some(preset => preset.key === chosen) ? chosen : columnPresetDefault();
}
// 표에 실제로 거는 묶음. PC는 걸러 내지 않고 모든 열을 그린 채 버튼으로 묶음 위치까지 가로로 옮긴다
// (2026-11-20 사용자 지시) — 그래서 PC는 늘 '전체'. 좁은 화면만 고른 묶음으로 거른다.
function effectiveColumnPreset(table, compact = columnPresetCompact()) {
  return compact ? activeColumnPreset(table) : "all";
}
// PC 버튼이 스크롤해 가는 열(묶음의 대표 열). 묶음 열이 표 곳곳에 흩어져 있어(β는 52주 옆, 추세는 맨 뒤)
// '묶음의 첫 열'로 잡으면 엉뚱한 곳으로 간다. 대표 열이 없는 표(값이 없어 숨김)면 그 묶음의 첫 보이는 열.
const COLUMN_PRESET_NAV_ANCHORS = {
  tech: "rsi_day", value: "trailing_pe", dividend: "dividend_yield", perf: "perf_1w",
  trend: "trend_return", fund: "gross_margin", consensus: "target_price",
};
// PC 버튼 묶음 — '전체'는 걸러 보기 전용이라 빠지고, '요약'이 맨 앞(왼쪽 끝)이다.
function columnPresetNavOptions(table) {
  return columnPresetOptions(table).filter(preset => preset.key !== "all");
}
function setColumnPreset(table, preset) {
  activeColumnPreset(table);   // 저장값을 먼저 읽어 둔다
  columnPresetChoice[table] = preset;
  storageSet(detailStorage.columnPreset, JSON.stringify(columnPresetChoice));
}

function hasInterestColumnValue(row, field) {
  if (field === "next_earnings_date") return Boolean(row[field]);
  if (field === "rating_rank") return row[field] != null;
  if (field === "dividend_yield") return Number(row[field]) > 0;
  return row[field] != null && Number.isFinite(Number(row[field]));
}

// 별만 남는 목록(찐관심·주요 지수·환율 — 삭제 버튼 없음)은 맨 끝 칸을 별 하나 폭으로 줄인다(2026-11-07)
const INTEREST_STAR_ONLY_WIDTH = 44;

function visibleInterestColumns(rows, isIndexGroup = false, {starOnly = false} = {}) {
  const preset = effectiveColumnPreset("interest");
  return INTEREST_COLUMNS.filter(column => column.always || (
    !(isIndexGroup && column.key === "extended_change_pct")
    && columnInPreset(column.key, preset, "interest", column.group)
    && rows.some(row => hasInterestColumnValue(row, column.key))
  )).map(column => starOnly && column.key === "delete" ? {...column, width: INTEREST_STAR_ONLY_WIDTH} : column);
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
  const key = columns.map(column => `${column.key}:${column.width}`).join(",");
  if (table.dataset.columnKey === key) return;
  table.dataset.columnKey = key;
  const columnWidth = column => column.key === "name"
    ? "var(--ticker-name-width, 165px)"
    : column.noScale ? `${column.width}px`
    // 폭의 권위는 여전히 colgroup. 좁은 화면에서 한 번에 줄일 수 있도록 --col-scale만 곱한다
    // (기본 1 = 원래 폭). 종목명 열은 내용 폭으로 이미 측정돼 있어 그대로 둔다.
    : `calc(${column.width}px * var(--col-scale, 1))`;
  table.querySelector("colgroup").innerHTML = columns
    .map(column => `<col style="width:${columnWidth(column)}">`).join("");
  // 종목명 열의 sticky 오프셋 = 로고 열 실제 폭. 폭에 배율이 걸리는데 오프셋만
  // 40px로 굳어 있으면 그 차이만큼 두 고정열 사이가 벌어지고, 그 틈으로 가로
  // 스크롤되는 데이터가 비쳐 보인다(2026-09-16 보고).
  table.style.setProperty("--interest-logo-col", columnWidth(columns[0]));
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

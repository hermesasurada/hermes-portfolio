function statsRows(rows) {
  return rows.map(row => {
    const stats = statsData[row.ticker] || {};
    const rsi = stats.rsi || {};
    const bb = stats.bollinger_pband || {};
    const perf = stats.performance || {};
    const isEtf = (row.assetClass || row.asset_class) === "etf";
    const isIndex = (row.assetClass || row.asset_class) === "index";
    const hideFundamentals = isEtf || isIndex;
    const marketCap = isEtf ? Number(stats.aum) : isIndex ? null : Number(stats.market_cap);
    return {
      ...row,
      market_cap: marketCap,
      market_cap_usd: toUsd(marketCap, row.currency),
      aum: isEtf ? stats.aum : null,
      dividend_yield: isIndex ? null : stats.dividend_yield,
      dividend_growth_5y: isIndex ? null : stats.dividend_growth_5y,
      beta: stats.beta,
      beta_adj: stats.beta_adj,
      next_earnings_date: stats.next_earnings_date || row.next_earnings_date || null,
      rsi_day: rsi.day,
      rsi_week: rsi.week,
      rsi_month: rsi.month,
      bb_day: bb.day,
      bb_week: bb.week,
      bb_month: bb.month,
      trailing_pe: hideFundamentals ? null : stats.trailing_pe,
      forward_pe: hideFundamentals ? null : stats.forward_pe,
      price_to_book: hideFundamentals ? null : stats.price_to_book,
      drawdown_52w: stats.drawdown_52w,
      perf_1m: perf.one_month,
      perf_3m: perf.three_month,
      perf_6m: perf.six_month,
      perf_ytd: perf.ytd,
      perf_1y: perf.one_year,
      perf_3y: perf.three_year,
      perf_5y: perf.five_year
    };
  });
}

function hasMissingTechnicalStats(stats) {
  if (!stats) return true;
  const rsi = stats.rsi || {};
  const bb = stats.bollinger_pband || {};
  return ["day", "week", "month"].some(key => !Number.isFinite(Number(rsi[key])) || !Number.isFinite(Number(bb[key])));
}

async function loadStatsForRows(rows) {
  const tickers = Array.from(new Set(rows.map(row => row.ticker).filter(Boolean))).sort();
  const missing = tickers.filter(ticker => !statsData[ticker] || (!statsFetchedTickers.has(ticker) && hasMissingTechnicalStats(statsData[ticker])));
  const key = missing.join(",");
  if (!missing.length || statsLoadKey === key || statsInFlight) return;
  statsLoadKey = key;
  // 관심목록은 통계가 표의 본체라 스켈레톤/에러를 tbody에 직접 그린다.
  // 세부내역은 보유 데이터가 이미 그려져 있으므로 표를 덮지 않는다(통계탭
  // 제거 후 죽은 #statsRows에 에러가 그려져 안 보이던 회귀 수정).
  const target = interestModeActive() ? document.getElementById("interestRows") : null;
  if (target && !target.children.length) target.innerHTML = skeletonRows(28);
  statsInFlight = (async () => {
    const payload = await apiFetchStats(missing);
    statsData = { ...statsData, ...(payload.stats || {}) };
    missing.forEach(ticker => statsFetchedTickers.add(ticker));
  })();
  let failed = false;
  try {
    await statsInFlight;
  } catch (err) {
    // 실패를 사용자에게 보이게 하고, 같은 key 가드에 막혀 영영 재시도
    // 못 하는 일이 없도록 리셋한다. 단 여기서 곧바로 재렌더하면
    // 렌더→재조회→실패→재렌더 무한 루프가 되므로, 재시도는 다음
    // 자연 렌더(사용자 조작·자동갱신)에 맡긴다.
    failed = true;
    statsLoadKey = "";
    const message = `통계 조회 실패: ${err.message || String(err)}`;
    if (target) target.innerHTML = `<tr><td colspan="28">${esc(message)}</td></tr>`;
    else if (window.__bootBanner) window.__bootBanner(message);
  } finally {
    statsInFlight = null;
    // 요청 중 계좌·통화 필터나 관심그룹이 바뀌었을 수 있으므로, 캡처된
    // 이전 rows가 아니라 현재 화면 기준으로 다시 그려 누락 종목을 후속 조회한다.
    if (!failed) {
      if (interestModeActive()) renderInterestMainTable();
      else renderTable();
    }
  }
}

function dividendSelectionKey() {
  if (selectionMode === "all") return "all";
  return Array.from(selectedAccounts).sort((a, b) => String(a).localeCompare(String(b), "ko-KR", { numeric: true })).join(",");
}

async function loadDividendsForSelection() {
  const key = dividendSelectionKey();
  if (dividendInFlight || dividendLoadKey === key) return;
  dividendLoadKey = key;
  const accounts = visibleAccounts();
  const allAccounts = selectionMode === "all";
  document.getElementById("dividendRows").innerHTML = skeletonRows(12);
  dividendInFlight = apiFetchDividends(accounts.map(account => account.id), allAccounts);
  try {
    dividendData = await dividendInFlight;
    renderDividendTable();
  } catch (err) {
    document.getElementById("dividendRows").innerHTML = `<tr><td colspan="12">${esc(err.message || String(err))}</td></tr>`;
  } finally {
    dividendInFlight = null;
  }
}

function renderDividendTable() {
  if (dividendLoadKey !== dividendSelectionKey() || !dividendData) {
    loadDividendsForSelection();
    return;
  }
  const rows = [...(dividendData.rows || [])];
  document.getElementById("rowCount").textContent = `${rows.length} rows`;
  const empty = `<tr><td colspan="12" class="flat">예정 배당 없음</td></tr>`;
  const dateCell = (value, estimated) => `<span class="${estimated ? "estimated-date" : "confirmed-date"}">${dividendDateText(value)}</span>`;
  const targetInitial = value => {
    const match = String(value || "").match(/[A-Za-z]/);
    return match ? match[0].toUpperCase() : "?";
  };
  const taxRateText = value => {
    const rate = Number(value);
    return Number.isFinite(rate) && rate !== 0 ? numberText(rate, 2) : "-";
  };
  const taxMoneyText = (value, currency) => {
    const tax = Number(value);
    return Number.isFinite(tax) && tax !== 0 ? dividendMoneyText(tax, currency) : "-";
  };
  const today = todayLocal();
  const payDateValue = row => {
    const value = String(row.pay_date || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  };
  const dateSort = sortState.dividend?.key === "pay_date";
  const boundaryPaidState = (sortState.dividend?.dir || 1) < 0;
  const hasPaid = rows.some(row => payDateValue(row) && payDateValue(row) <= today);
  const hasUpcoming = rows.some(row => payDateValue(row) > today);
  let todayBoundaryInserted = false;
  document.getElementById("dividendRows").innerHTML = rows.length ? groupedDividendRows(rows).map(item => {
    const collapsed = item.kind === "month" && collapsedDividendMonths.has(item.key);
    if (item.kind === "month") return `
    <tr class="dividend-month-row ${collapsed ? "collapsed" : ""}" data-month="${esc(item.key)}">
      <td colspan="12">
        <div class="dividend-month-summary">
          <button class="dividend-month-toggle" type="button" aria-expanded="${collapsed ? "false" : "true"}" aria-label="${collapsed ? "월별 배당 펼치기" : "월별 배당 접기"}"></button>
          <span>${esc(item.label)}</span>
          <strong>${dividendKrwText(item.total)}</strong>
        </div>
      </td>
    </tr>
  `;
    if (collapsedDividendMonths.has(item.monthKey)) return "";
    const paid = Boolean(payDateValue(item.row) && payDateValue(item.row) <= today);
    const showTodayBoundary = dateSort
      && hasPaid
      && hasUpcoming
      && !todayBoundaryInserted
      && paid === boundaryPaidState;
    if (showTodayBoundary) todayBoundaryInserted = true;
    const todayBoundary = showTodayBoundary ? `
      <tr class="dividend-today-row">
        <td colspan="12">
          <span class="dividend-today-marker">오늘 ${dividendDateText(today)}</span>
        </td>
      </tr>
    ` : "";
    return `
    ${todayBoundary}
    <tr class="${paid ? "dividend-paid-row" : "dividend-upcoming-row"}">
      <td>${dateCell(item.row.pay_date, item.row.pay_date_estimated)}</td>
      <td class="dividend-target" title="${esc(item.row.target || item.row.member || "-")}"><span class="dividend-target-icon" aria-label="${esc(item.row.target || item.row.member || "-")}">${esc(targetInitial(item.row.target || item.row.member))}</span></td>
      <td class="dividend-name" title="${esc(item.row.name || item.row.ticker || "-")}"><a class="ticker-link" href="${esc(chartHref(item.row.ticker))}" data-chart-ticker="${esc(item.row.ticker)}">${esc(item.row.name || item.row.ticker || "-")}</a></td>
      <td>${dividendAmountText(item.row.amount, item.row.currency)}</td>
      <td>${fmt2.format(Number(item.row.qty) || 0)}</td>
      <td>${dividendMoneyText(item.row.gross, item.row.currency)}</td>
      <td class="tax-dividend">${taxMoneyText(item.row.tax, item.row.currency)}</td>
      <td class="tax-rate">${taxRateText(item.row.tax_rate)}</td>
      <td class="net-dividend">${dividendMoneyText(item.row.net, item.row.currency)}</td>
      <td class="fx-rate">${dividendFxText(item.row.fx_rate)}</td>
      <td class="net-krw">${dividendKrwText(item.row.net_krw)}</td>
      <td class="dividend-detail-cell"><button class="ghost-btn dividend-detail-btn" type="button" data-dividend-history="${esc(item.row.ticker)}">상세</button></td>
    </tr>
  `;
  }).join("") : empty;
  document.querySelectorAll(".dividend-month-row").forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest("a")) return;
      const key = row.dataset.month;
      if (!key) return;
      if (collapsedDividendMonths.has(key)) collapsedDividendMonths.delete(key);
      else collapsedDividendMonths.add(key);
      renderDividendTable();
    });
  });
  // 티커 링크·배당이력 버튼 클릭은 app.js의 문서 위임이 처리 (개별 바인딩 금지)
  schedulePcFrozenColumns();
}

function dividendHistoryPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const cls = number > 0 ? "up" : number < 0 ? "down" : "flat";
  const arrow = number > 0 ? "▲" : number < 0 ? "▼" : "→";
  return `<span class="${cls}"><span aria-hidden="true">${arrow}</span>${fmt1.format(Math.abs(number))}%</span>`;
}

let dividendHistoryCollapseKey = "";
let collapsedDividendHistoryYears = new Set();

function initDividendHistoryCollapsedYears(payload, rows) {
  const key = `${payload.ticker || ""}:${rows.map(row => row.year).join(",")}`;
  if (dividendHistoryCollapseKey === key) return;
  dividendHistoryCollapseKey = key;
  const cutoffYear = new Date().getFullYear() - 5;
  collapsedDividendHistoryYears = new Set(
    rows
      .map(row => Number(row.year))
      .filter(year => Number.isFinite(year) && year <= cutoffYear)
      .map(String)
  );
}

function renderDividendHistory(payload) {
  const rows = payload.rows || [];
  const summary = payload.summary || {};
  const body = document.getElementById("dividendHistoryBody");
  document.getElementById("dividendHistoryName").textContent = payload.name || payload.ticker || "-";
  document.getElementById("dividendHistoryTicker").textContent = payload.ticker || "-";
  const freqLabel = payload.summary?.frequency_label;
  document.getElementById("dividendHistoryFreq").textContent = freqLabel ? `(${freqLabel})` : "";
  if (!rows.length) {
    body.innerHTML = `<div class="dividend-history-empty">${payload.start_year || 2010}년 이후 배당이력 없음</div>`;
    return;
  }
  initDividendHistoryCollapsedYears(payload, rows);
  const estimatedGrowthMark = `<small class="history-growth-basis" title="현재 귀속연도 예상 연간배당 기준">*</small>`;
  // 지급주기는 타이틀 옆 괄호로, 연환산은 표의 예상 연간배당과 중복이라 보드에서 제외
  const summaryColumns = [
    [
      [summary.latest_growth_estimated ? "예상 성장률" : "최근 성장률", `${dividendHistoryPercent(summary.latest_growth_pct)}${summary.latest_growth_estimated ? estimatedGrowthMark : ""}`],
      [
        "최근 인상",
        summary.last_raise_pct == null
          ? "-"
          : `${dividendHistoryPercent(summary.last_raise_pct)} <small>${shortDateText(summary.last_raise_date)}</small>`,
      ],
    ],
    [
      ["3년 CAGR", `${dividendHistoryPercent(summary.cagr_3y)}${summary.cagr_3y_estimated ? estimatedGrowthMark : ""}`],
      ["5년 CAGR", `${dividendHistoryPercent(summary.cagr_5y)}${summary.cagr_5y_estimated ? estimatedGrowthMark : ""}`],
    ],
  ];
  body.innerHTML = `
    <div class="dividend-history-table-wrap">
      <table class="dividend-history-table detailed">
        <thead>
          <tr>
            <th>귀속연도</th>
            <th>연간배당</th>
            <th>성장률</th>
            <th>횟수</th>
            <th>기준일</th>
            <th>지급일</th>
            <th>주당배당금</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, rowIndex) => {
            const details = (row.payments_detail && row.payments_detail.length)
              ? row.payments_detail
              : [null];
            const yearKey = String(row.year);
            const collapsed = collapsedDividendHistoryYears.has(yearKey);
            const detailCount = row.payments_detail?.length || 0;
            const toggleLabel = `${row.year}년 배당 상세 ${collapsed ? "펼치기" : "접기"}`;
            const yearCell = `
              <td class="history-year-cell" data-dividend-history-year="${esc(yearKey)}" aria-label="${esc(toggleLabel)}">
                <button class="history-year-toggle" type="button" data-dividend-history-year="${esc(yearKey)}" aria-expanded="${collapsed ? "false" : "true"}" aria-label="${esc(toggleLabel)}">
                  <span class="history-year-chevron" aria-hidden="true">${collapsed ? "›" : "⌄"}</span>
                </button>
                <span class="history-year-anchor">
                  <strong>${row.year}</strong>
                  ${row.current_ytd ? `<span class="history-ytd">YTD</span>` : ""}
                </span>
              </td>`;
            const amountCell = `
              <td class="history-annual-cell">
                <span class="history-annual-anchor history-amount-anchor">
                  <span class="history-amount">${dividendAmountText(row.amount, payload.currency)}</span>
                  ${row.estimated_amount != null && row.estimated_amount > row.amount
                    ? `<span class="history-estimate">예상 ${dividendMoneyText(row.estimated_amount, payload.currency)}</span>`
                    : ""}
                </span>
              </td>`;
            const growthCell = `<td class="history-annual-cell"><span class="history-annual-anchor">${
              row.growth_pct == null
                ? "-"
                : `${dividendHistoryPercent(row.growth_pct)}${
                    row.growth_basis === "estimate"
                      ? `<span class="history-growth-basis" title="현재 귀속연도 예상 연간배당 기준">*</span>`
                      : row.growth_basis === "first_payment"
                        ? `<span class="history-growth-basis" title="연간 미완결 — 해당 연도 최초 배당금 기준">*</span>`
                        : ""
                  }`
            }</span></td>`;
            const countCell = `<td class="history-annual-cell"><span class="history-annual-anchor">${fmt.format(Number(row.payments) || 0)}${row.expected_payments ? `/${fmt.format(row.expected_payments)}` : ""}</span></td>`;
            const emptyGroupCells = `
              <td class="history-group-empty"></td>
              <td class="history-group-empty"></td>
              <td class="history-group-empty"></td>
              <td class="history-group-empty"></td>`;
            if (collapsed) {
              return `
                <tr class="history-year-collapsed ${rowIndex > 0 ? "history-year-start" : ""}">
                  ${yearCell}${amountCell}${growthCell}${countCell}
                  <td class="history-collapsed-summary" colspan="3">${fmt.format(detailCount)}건 접힘</td>
                </tr>
              `;
            }
            const specialGroupCells = `
              <td class="history-group-empty"></td>
              <td class="history-special-note" colspan="3">특별배당</td>`;
            return details.map((detail, index) => `
              <tr class="${index === 0 && rowIndex > 0 ? "history-year-start" : ""}">
                ${index === 0
                  ? `${yearCell}${amountCell}${growthCell}${countCell}`
                  : detail?.is_special ? specialGroupCells : emptyGroupCells}
                <td class="history-detail-date">${detail ? shortDateText(detail.entitlement_date) : "-"}</td>
                <td class="history-detail-date">${detail ? shortDateText(detail.pay_date) : "-"}</td>
                <td class="history-detail-amount">${
                  index === 0 && detail?.is_special ? `<span class="history-special-note">특별</span> ` : ""
                }${detail ? dividendAmountText(detail.amount, payload.currency) : "-"}</td>
              </tr>
            `).join("");
          }).join("")}
        </tbody>
      </table>
    </div>
    <div class="chart-stats dividend-history-stats">
      <div class="cstat-board">
        ${summaryColumns.map(items => `<div class="cstat-column">${items.map(([label, value]) => `
          <div class="cstat-row">
            <span class="cstat-k">${esc(label)}</span>
            <span class="cstat-v">${value}</span>
          </div>
        `).join("")}</div>`).join("")}
      </div>
    </div>
  `;
  body.querySelector(".dividend-history-table")?.addEventListener("click", event => {
    const target = event.target.closest("[data-dividend-history-year]");
    if (!target) return;
    const year = target.dataset.dividendHistoryYear;
    if (!year) return;
    if (collapsedDividendHistoryYears.has(year)) collapsedDividendHistoryYears.delete(year);
    else collapsedDividendHistoryYears.add(year);
    renderDividendHistory(payload);
  });
}

async function openDividendHistory(ticker) {
  const modal = document.getElementById("dividendHistoryModal");
  const body = document.getElementById("dividendHistoryBody");
  document.getElementById("dividendHistoryName").textContent = "배당이력";
  document.getElementById("dividendHistoryTicker").textContent = ticker || "-";
  document.getElementById("dividendHistoryFreq").textContent = "";
  body.innerHTML = `<div class="dividend-history-empty">불러오는 중...</div>`;
  if (!modal.open) modal.showModal();   // 이미 열려 있으면 내용만 교체(showModal 재호출 시 throw 방지)
  // 모바일 뒤로가기로 닫을 수 있도록 history 항목 추가 (URL은 유지)
  if (!(history.state && history.state.dividendHistory)) {
    history.pushState({ dividendHistory: true }, "");
  }
  try {
    renderDividendHistory(await apiFetchDividendHistory(ticker));
  } catch (err) {
    body.innerHTML = `<div class="dividend-history-empty">${esc(err.message || String(err))}</div>`;
  }
}

function initDividendHistoryModal() {
  const modal = document.getElementById("dividendHistoryModal");
  if (!modal) return;
  document.getElementById("dividendHistoryClose")?.addEventListener("click", () => modal.close());
  // PC: 모달 바깥(백드롭) 클릭 시 닫기
  modal.addEventListener("click", event => {
    const card = modal.querySelector(".modal-card");
    if (!card) return;
    const r = card.getBoundingClientRect();
    const outside =
      event.clientX < r.left || event.clientX > r.right ||
      event.clientY < r.top || event.clientY > r.bottom;
    if (outside) modal.close();
  });
  // 버튼·백드롭·ESC로 닫히면 우리가 추가한 history 항목을 정리한다.
  modal.addEventListener("close", () => {
    if (history.state && history.state.dividendHistory) history.back();
  });
  // 모바일: 뒤로가기(popstate) 시 팝업 닫기
  window.addEventListener("popstate", () => {
    if (modal.open) modal.close();
  });
}

function dividendDateText(dateText) {
  if (!dateText) return "-";
  const text = String(dateText);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return "-";
  return text.slice(5, 10).replace("-", "/");
}

function dividendMonthKey(row) {
  const text = String(row.pay_date || row.ex_date || "");
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : "unknown";
}

function dividendMonthLabel(key) {
  if (key === "unknown") return "날짜 미정";
  return `${key.slice(0, 4)}년 ${Number(key.slice(5, 7))}월`;
}

function groupedDividendRows(rows) {
  const groups = new Map();
  rows.forEach(row => {
    const key = dividendMonthKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const dividendSort = sortState.dividend || {};
  const monthDir = dividendSort.key === "pay_date" ? dividendSort.dir : 1;
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b) * monthDir)
    .flatMap(([key, monthRows]) => {
      sortRows(monthRows, "dividend");
      const total = monthRows.reduce((sum, row) => {
        const value = Number(row.net_krw);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
      return [
        { kind: "month", key, label: dividendMonthLabel(key), total },
        ...monthRows.map(row => ({ kind: "row", monthKey: key, row }))
      ];
    });
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-tabs");

function statsRows(rows) {
  return rows.map(row => {
    const stats = statsData[row.ticker] || {};
    const rsi = stats.rsi || {};
    const bb = stats.bollinger_pband || {};
    const perf = stats.performance || {};
    const isEtf = (row.assetClass || row.asset_class) === "etf";
    const isIndex = (row.assetClass || row.asset_class) === "index";
    const hideFundamentals = isEtf || isIndex;
    const marketCap = hideFundamentals ? null : Number(stats.market_cap);
    return {
      ...row,
      market_cap: marketCap,
      market_cap_usd: toUsd(marketCap, row.currency),
      dividend_yield: hideFundamentals ? null : stats.dividend_yield,
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
  document.getElementById("statsRows").innerHTML = `<tr><td colspan="23">통계 loading...</td></tr>`;
  statsInFlight = (async () => {
    const payload = await apiFetchStats(missing);
    statsData = { ...statsData, ...(payload.stats || {}) };
    missing.forEach(ticker => statsFetchedTickers.add(ticker));
    renderStatsTable(rows);
  })();
  try {
    await statsInFlight;
  } catch (err) {
    document.getElementById("statsRows").innerHTML = `<tr><td colspan="23">${esc(err.message || String(err))}</td></tr>`;
  } finally {
    statsInFlight = null;
  }
}

function renderStatsTable(baseRows = null) {
  const rows = statsRows(baseRows || filteredRows());
  sortRows(rows, "stats");
  const tickers = Array.from(new Set(rows.map(row => row.ticker).filter(Boolean))).sort();
  if (tickers.some(ticker => !statsData[ticker] || (!statsFetchedTickers.has(ticker) && hasMissingTechnicalStats(statsData[ticker])))) loadStatsForRows(rows);
  if (statsInFlight && !rows.some(row => statsData[row.ticker])) return;
  document.getElementById("statsRows").innerHTML = rows.map(r => `
    <tr class="${tableRowClass(r)}">
      <td class="logo-cell">${logoMarkup(r)}</td>
      <td>
        <span class="ticker-text">
          <a class="ticker-link" href="${esc(chartHref(r.ticker))}" data-chart-ticker="${esc(r.ticker)}">
            <span class="asset-name">${r.name}</span>
            <span class="ticker-symbol">${r.ticker}</span>
          </a>
        </span>
      </td>
      <td>${marketCapMarkup(r)}</td>
      <td>${dividendYieldText(r.dividend_yield)}</td>
      <td>${signedPercentText(r.drawdown_52w, 1)}</td>
      <td>${betaText(r.beta)}</td>
      <td>${betaText(r.beta_adj)}</td>
      <td>${indicatorText(r.rsi_day, "rsi")}</td>
      <td>${indicatorText(r.rsi_week, "rsi")}</td>
      <td>${indicatorText(r.rsi_month, "rsi")}</td>
      <td>${indicatorText(r.bb_day, "bb")}</td>
      <td>${indicatorText(r.bb_week, "bb")}</td>
      <td>${indicatorText(r.bb_month, "bb")}</td>
      <td>${peText(r.trailing_pe)}</td>
      <td>${peText(r.forward_pe)}</td>
      <td>${peText(r.price_to_book)}</td>
      <td>${signedPercentText(r.perf_1m, 1)}</td>
      <td>${signedPercentText(r.perf_3m, 0)}</td>
      <td>${signedPercentText(r.perf_6m, 0)}</td>
      <td>${signedPercentText(r.perf_ytd, 0)}</td>
      <td>${signedPercentText(r.perf_1y, 0)}</td>
      <td>${signedPercentText(r.perf_3y, 0)}</td>
      <td>${signedPercentText(r.perf_5y, 0)}</td>
    </tr>
  `).join("");
  bindChartLinks();
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
  document.getElementById("dividendRows").innerHTML = `<tr><td colspan="11">배당 loading...</td></tr>`;
  dividendInFlight = apiFetchDividends(accounts.map(account => account.id), allAccounts);
  try {
    dividendData = await dividendInFlight;
    renderDividendTable();
  } catch (err) {
    document.getElementById("dividendRows").innerHTML = `<tr><td colspan="11">${esc(err.message || String(err))}</td></tr>`;
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
  const empty = `<tr><td colspan="11" class="flat">예정 배당 없음</td></tr>`;
  const dateCell = (value, estimated) => `<span class="${estimated ? "estimated-date" : "confirmed-date"}">${dividendDateText(value)}</span>`;
  document.getElementById("dividendRows").innerHTML = rows.length ? groupedDividendRows(rows).map(item => {
    const collapsed = item.kind === "month" && collapsedDividendMonths.has(item.key);
    if (item.kind === "month") return `
    <tr class="dividend-month-row ${collapsed ? "collapsed" : ""}" data-month="${esc(item.key)}">
      <td colspan="11">
        <div class="dividend-month-summary">
          <button class="dividend-month-toggle" type="button" aria-expanded="${collapsed ? "false" : "true"}" aria-label="${collapsed ? "월별 배당 펼치기" : "월별 배당 접기"}"></button>
          <span>${esc(item.label)}</span>
          <strong>${dividendKrwText(item.total)}</strong>
        </div>
      </td>
    </tr>
  `;
    if (collapsedDividendMonths.has(item.monthKey)) return "";
    return `
    <tr>
      <td>${dateCell(item.row.pay_date, item.row.pay_date_estimated)}</td>
      <td class="dividend-target">${esc(item.row.target || item.row.member || "-")}</td>
      <td class="dividend-ticker">${esc(item.row.ticker || "-")}</td>
      <td><button class="dividend-history-link" type="button" data-dividend-history="${esc(item.row.ticker)}">${esc(item.row.name || item.row.ticker || "-")}</button></td>
      <td>${dividendAmountText(item.row.amount, item.row.currency)}</td>
      <td>${fmt2.format(Number(item.row.qty) || 0)}</td>
      <td>${dividendMoneyText(item.row.gross, item.row.currency)}</td>
      <td class="tax-rate">${numberText(item.row.tax_rate, 2)}</td>
      <td class="net-dividend">${dividendMoneyText(item.row.net, item.row.currency)}</td>
      <td class="fx-rate">${dividendFxText(item.row.fx_rate)}</td>
      <td class="net-krw">${dividendKrwText(item.row.net_krw)}</td>
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
  bindDividendHistoryLinks();
  bindChartLinks();
}

function dividendHistoryPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const cls = number > 0 ? "up" : number < 0 ? "down" : "flat";
  const arrow = number > 0 ? "▲" : number < 0 ? "▼" : "→";
  return `<span class="${cls}"><span aria-hidden="true">${arrow}</span>${fmt1.format(Math.abs(number))}%</span>`;
}

function dividendHistoryEstimate(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const digits = currency === "KRW" || currency === "JPY" ? 0 : 2;
  return `${dividendCurrencyPrefix(currency)}${number.toLocaleString("ko-KR", { maximumFractionDigits: digits })}`;
}

function renderDividendHistory(payload) {
  const rows = payload.rows || [];
  const summary = payload.summary || {};
  const body = document.getElementById("dividendHistoryBody");
  document.getElementById("dividendHistoryName").textContent = payload.name || payload.ticker || "-";
  document.getElementById("dividendHistoryTicker").textContent = payload.ticker || "-";
  if (!rows.length) {
    body.innerHTML = `<div class="dividend-history-empty">${payload.start_year || 2010}년 이후 배당이력 없음</div>`;
    return;
  }
  const summaryItems = [
    ["최근 성장률", dividendHistoryPercent(summary.latest_growth_pct)],
    ["3년 CAGR", dividendHistoryPercent(summary.cagr_3y)],
    ["5년 CAGR", dividendHistoryPercent(summary.cagr_5y)],
    [`${summary.next_year || "다음해"} 예상`, dividendHistoryEstimate(summary.next_estimate, payload.currency)],
  ];
  body.innerHTML = `
    <div class="dividend-history-table-wrap">
      <table class="dividend-history-table">
        <thead>
          <tr>
            <th>연도</th>
            <th>주당배당금</th>
            <th>성장률</th>
            <th>횟수</th>
            <th>최근 일자</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td><strong>${row.year}</strong>${row.current_ytd ? `<span class="history-ytd">YTD</span>` : ""}</td>
              <td>${dividendAmountText(row.amount, payload.currency)}</td>
              <td>${row.current_ytd ? "-" : dividendHistoryPercent(row.growth_pct)}</td>
              <td>${fmt.format(Number(row.payments) || 0)}</td>
              <td>${dividendDateText(row.last_date)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="dividend-history-summary">
      ${summaryItems.map(([label, value]) => `
        <div>
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `).join("")}
    </div>
    <div class="dividend-history-note">
      연간 합계는 ${payload.start_year || 2010}년 이후 DB 원본 주당배당금 기준입니다. 현재 연도는 오늘까지의 YTD이며 액면분할은 별도 보정하지 않습니다.
    </div>
  `;
}

async function openDividendHistory(ticker) {
  const modal = document.getElementById("dividendHistoryModal");
  const body = document.getElementById("dividendHistoryBody");
  document.getElementById("dividendHistoryName").textContent = "배당이력";
  document.getElementById("dividendHistoryTicker").textContent = ticker || "-";
  body.innerHTML = `<div class="dividend-history-empty">불러오는 중...</div>`;
  modal.showModal();
  try {
    renderDividendHistory(await apiFetchDividendHistory(ticker));
  } catch (err) {
    body.innerHTML = `<div class="dividend-history-empty">${esc(err.message || String(err))}</div>`;
  }
}

function bindDividendHistoryLinks() {
  document.querySelectorAll("[data-dividend-history]").forEach(button => {
    button.addEventListener("click", () => openDividendHistory(button.dataset.dividendHistory));
  });
}

function initDividendHistoryModal() {
  const modal = document.getElementById("dividendHistoryModal");
  document.getElementById("dividendHistoryClose")?.addEventListener("click", () => modal.close());
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

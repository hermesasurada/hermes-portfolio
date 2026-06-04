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
  document.getElementById("statsRows").innerHTML = `<tr><td colspan="21">통계 loading...</td></tr>`;
  statsInFlight = (async () => {
    const payload = await apiFetchStats(missing);
    statsData = { ...statsData, ...(payload.stats || {}) };
    missing.forEach(ticker => statsFetchedTickers.add(ticker));
    renderStatsTable(rows);
  })();
  try {
    await statsInFlight;
  } catch (err) {
    document.getElementById("statsRows").innerHTML = `<tr><td colspan="21">${esc(err.message || String(err))}</td></tr>`;
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
      <td>${esc(item.row.name || item.row.ticker || "-")}</td>
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
  bindChartLinks();
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

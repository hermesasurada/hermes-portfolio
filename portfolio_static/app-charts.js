// Performance chart rendering. Classic script loaded before app.js; shares
// the global scope and resolves state/helpers at call time.

function accountPerformanceTitle(payload) {
  const accounts = payload?.accounts || [];
  if (!accounts.length) return "선택 계좌 성과";
  if (accounts.length === 1) return `${accounts[0].member} · ${accounts[0].name} 성과`;
  return `${accounts.length}개 계좌 성과`;
}

// 범례는 차트(플롯) 영역 밖 — 캔버스 위 별도 호스트에 둔다.
// 성과 화면에서는 차트 컨트롤(부드럽게·기간)을 계좌 칩 줄 끝으로 옮겨 온다(2026-11-21 사용자 지시 — 예전엔 오른쪽 위에 따로 떠 있었다).
// 범례를 다시 그리기 전에 컨트롤을 원래 자리(차트 상자 맨 앞)로 돌려놓아야 innerHTML 교체에 지워지지 않는다.
function restoreChartControlsHome() {
  const control = document.getElementById("chartBottomControls");
  const stage = document.querySelector("#chartView .chart-stage");
  if (control && stage && control.parentElement !== stage) stage.insertBefore(control, stage.firstChild);
}
function syncPerformanceLegendHost(html) {
  const host = document.getElementById("perfLegendHost");
  if (!host) return;
  restoreChartControlsHome();
  host.innerHTML = html || "";
  host.classList.toggle("hidden", !html);
  const slot = host.querySelector(".perf-controls-slot");
  const control = document.getElementById("chartBottomControls");
  if (slot && control) slot.appendChild(control);
}

// 성과 타이틀은 차트 헤드가 아니라 툴바(목록·상세 버튼 우측)에 띄운다.
function syncPerformanceTitle(text) {
  const host = document.getElementById("performanceTitle");
  if (!host) return;
  host.textContent = text || "";
  host.classList.toggle("hidden", !text);
}

// 비교 지수 메타 — 범례와 시리즈 구성이 같은 정의를 공유한다.
// 빨강=상승/파랑=하락 시맨틱과 충돌하지 않도록 중립 비교색(보라·청록·앰버)
// 계좌 선(브랜드 블루, 색상환 221°)과 서로 최소 70° 이상 떨어진 색만 쓴다 —
// 예전 보라(#7c3aed, 273°)는 블루와 붙어 얇은 선에서 구분이 안 됐다.
// 상승=빨강 관례와 겹치지 않게 순수 red 계열은 피한다.
// 순서는 S&P 500 → 나스닥 → 코스피 → 니케이(2026-09-16 사용자 지시).
// 색은 지수에 고정 — 순서를 바꿔도 같은 지수가 같은 색을 유지해야 눈이 안 헷갈린다.
const PERF_INDEX_META = [
  ["SP500", "S&P 500", "#c026d3", "S&P"],      // 292° 푸시아 — 넷째 칸은 모바일 칩의 짧은 이름
  ["NASDAQ", "나스닥", "#16a34a"],       // 142° 그린
  ["KOSPI", "코스피", "#d97706"],        // 32° 앰버
  ["NIKKEI225", "니케이", "#0891b2"],    // 192° 시안
  ["BTC", "비트코인", "#64748b"],        // 무채색 슬레이트 — 남은 색상환 자리가 계좌·지수 색과 붙어 채도 없는 색으로(2026-11-21)
];

// useTwr: 계좌 선은 평가액 변화율이 아니라 시간가중 지수(point.twr, 백엔드 체인)로 %를 그린다.
// 평가액(point.value)은 호버 금액·끝 라벨용으로 그대로 들고 간다.
// twrKey: "twr"(실제 환율) 또는 "twr_fixed"(고정환율) — 백엔드가 두 체인을 함께 실어 준다.
function normalizePerformancePoints(points, rangeKey, bounds = null, useTwr = false, twrKey = "twr") {
  const raw = (points || [])
    .filter(point => point.date && Number.isFinite(Number(point.value)))
    .map(point => ({ date: point.date, value: Number(point.value), twr: Number.isFinite(Number(point[twrKey])) ? Number(point[twrKey]) : null }));
  const startDate = bounds?.startDate || null;
  const endDate = bounds?.endDate || null;
  const filtered = startDate || endDate
    ? raw.filter(point => {
        const date = new Date(`${point.date}T00:00:00`);
        return (!startDate || date >= startDate) && (!endDate || date <= endDate);
      })
    : filterChartPoints(raw.map(point => ({ date: point.date, close: point.value, twr: point.twr })), rangeKey)
        .map(point => ({ date: point.date, value: Number(point.close), twr: point.twr }));
  if (filtered.length < 2) return [];
  const twrReady = useTwr && filtered.every(point => point.twr != null && point.twr > 0);
  const base = twrReady ? filtered[0].twr : filtered.find(point => point.value > 0)?.value;
  if (!base) return [];
  return filtered.map(point => ({
    date: point.date,
    close: ((twrReady ? point.twr : point.value) / base - 1) * 100,
    value: point.value,
    time: new Date(`${point.date}T00:00:00`).getTime(),
  }));
}

function performanceValueText(point) {
  const value = Number(point?.value);
  return Number.isFinite(value) ? krwShort(value) : "";
}

// 고정환율 선: 같은 색·점선. 원화 계좌처럼 실제 선과 겹치면(환노출 없음) 그리지 않는다.
// 금액은 기준일 환율 기준이라 실제 평가액과 비교되지 않으므로 툴팁엔 %만 싣는다.
function performanceFixedFxDiffers(rawPoints) {
  return (rawPoints || []).some(point => {
    const actual = Number(point.twr), fixed = Number(point.twr_fixed);
    return Number.isFinite(actual) && Number.isFinite(fixed) && Math.abs(actual - fixed) > 1e-6;
  });
}

function pushFixedFxSeries(series, base, rawPoints, bounds) {
  if (!performanceFixedFx || !performanceFixedFxDiffers(rawPoints)) return;
  series.push({
    key: `${base.key}-fixed`,
    base: base.key,
    name: `${base.name} · 고정환율`,
    color: base.color,
    points: normalizePerformancePoints(rawPoints, chartRange, bounds, true, "twr_fixed"),
    primary: false,
    detail: Boolean(base.detail),
    fixed: true,
    amount: false,
  });
}

// 3년 이상 기간은 주봉으로 그린다(2026-11-21 사용자 지시) — 일별 점 수백~수천 개가 선을 뭉갠다.
// 주마다 마지막 점만 남기고(첫 점=0% 기준점은 늘 남긴다), 마지막 점도 늘 남겨 끝 라벨 값이 일별과 같다.
function performanceWeeklyPoints(points) {
  if (points.length < 3) return points;
  const weekKey = time => Math.floor((time / 86400000 + 3) / 7);   // 1970-01-01은 목요일 → +3으로 월요일 시작 주
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    const next = points[i + 1];
    if (!next || weekKey(next.time) !== weekKey(point.time)) out.push(point);
  }
  return out;
}
// 단위(일/주, 2026-11-21 사용자 지시): 3년 이상은 늘 주봉, 그보다 짧으면 고른 단위(기본 일).
let performanceIntervalPreference = "day";
function performanceWeeklyForced() {
  return chartDisplayedYears() + 0.01 >= 3;
}
function performanceUsesWeekly() {
  return performanceWeeklyForced() || performanceIntervalPreference === "week";
}

function performanceSeries(payload) {
  const portfolioRaw = payload?.points || [];
  const accountSeries = payload?.account_series || [];
  const lastDate = portfolioRaw[portfolioRaw.length - 1]?.date
    || accountSeries.flatMap(item => item.points || []).map(point => point.date).sort().at(-1)
    || Object.values(payload?.indexes || {}).flatMap(item => item.points || []).map(point => point.date).sort().at(-1);
  const bounds = lastDate ? chartRangeBounds([{ date: lastDate }], chartRange) : null;
  const series = [
    {
      key: "portfolio",
      name: "선택 계좌",
      color: "var(--chart-price)",   // 데이터 선은 선택색(--brand)이 아니라 가격선 색
      points: normalizePerformancePoints(portfolioRaw, chartRange, bounds, true),
      primary: true,
      amount: true,
    },
  ];
  pushFixedFxSeries(series, series[0], portfolioRaw, bounds);
  if (performanceDetailEnabled() && accountSeries.length > 1) {
    accountSeries.forEach((account, index) => {
      const item = {
        key: `account-${account.id}`,
        name: account.name || `계좌 ${index + 1}`,
        color: chartCompareColors[(index + 1) % chartCompareColors.length],
        points: normalizePerformancePoints(account.points || [], chartRange, bounds, true),
        primary: false,
        detail: true,
        amount: true,
      };
      series.push(item);
      pushFixedFxSeries(series, item, account.points || [], bounds);
    });
  }
  PERF_INDEX_META.forEach(([key, label, color]) => {
    if (!performanceIndexes[key]) return;
    const index = payload?.indexes?.[key];
    series.push({
      key,
      name: label,
      color,
      points: normalizePerformancePoints(index?.points || [], chartRange, bounds),
      primary: false,
    });
  });
  const weekly = performanceUsesWeekly();
  return series
    .map(item => (weekly ? { ...item, points: performanceWeeklyPoints(item.points) } : item))
    .filter(item => item.points.length >= 2);
}

// 범례 = 색 표시 + 지수 on/off 한 줄. 계좌 선은 정보 칩(고정), 비교 지수는
// 끄든 켜든 항상 자리에 있고 클릭으로 토글된다(꺼진 것도 보여야 다시 켤 수 있다).
let performanceFocusKey = null;

function performanceBasisText(payload) {
  return payload?.twr_basis === "full" ? "시간가중" : payload?.twr_basis === "securities" ? "시간가중 · 증권 기준" : "수익률 기준 확인 필요";
}

// 성과 요약 띠(2026-11-20 디자인 개편): 차트 위, 범례 위에 둔다 — 예전 플롯 안 수익률 상자는 선을 가렸다.
// 왼쪽은 표시 기간의 계좌 수익률(크게), 오른쪽은 고정환율(환율 효과)과 켜 둔 비교지수 대비 초과수익(%p).
// 각 선의 최종 수익률 자체는 선 끝 라벨(이름 + %)이 맡는다. 계좌 칩으로 선을 강조하면 그 계좌 기준으로 바뀐다.
function pctPointLabel(value) {
  return pctChartLabel1(value).replace(/%$/, "%p");
}
function performanceSummaryItem(label, value, note, { color = "", dashed = false, point = false } = {}) {
  const marker = !color ? "" : dashed ? `<i class="dashed" style="color:${color}"></i>` : `<i style="background:${color}"></i>`;
  const { cls } = changeDirection(value);
  return `<div class="perf-summary-item">${marker}<span class="perf-summary-label">${esc(label)}</span>`
    + `<b class="${cls}">${esc(point ? pctPointLabel(value) : pctChartLabel1(value))}</b>`
    + (note ? `<small>${esc(note)}</small>` : "") + `</div>`;
}

function performanceSummary(payload, series = [], focusKey = null) {
  const target = (focusKey && series.find(item => item.key === focusKey && !item.fixed))
    || series.find(item => item.primary);
  const points = target?.points || [];
  if (points.length < 2) return "";
  const lastClose = item => item.points[item.points.length - 1].close;
  const last = points[points.length - 1];
  const value = last.close;
  const fixed = series.find(item => item.fixed && item.base === target.key && item.points.length >= 2);
  const indexKeys = new Set(PERF_INDEX_META.map(([key]) => key));
  const items = [];
  if (fixed) {
    items.push(performanceSummaryItem("고정환율", lastClose(fixed), `환율 효과 ${pctPointLabel(value - lastClose(fixed))}`,
      { color: fixed.color, dashed: true }));
  }
  series
    .filter(item => indexKeys.has(item.key) && item.points.length >= 2)
    .forEach(item => items.push(performanceSummaryItem(`${item.name} 대비`, value - lastClose(item),
      `지수 ${pctChartLabel1(lastClose(item))}`, { color: item.color, point: true })));
  const range = chartRanges.find(item => item.key === chartRange);
  const rangeLabel = chartRange === "custom" ? "지정 기간" : range?.label || "";
  const { cls } = changeDirection(value);
  return `<div class="perf-summary-main">`
    + `<span class="perf-summary-caption">${rangeLabel ? `${esc(rangeLabel)} ` : ""}수익률 · ${esc(target.name)}</span>`
    + `<strong class="perf-summary-value ${cls}">${esc(pctChartLabel1(value))}</strong>`
    + `<span class="perf-summary-meta">${esc(chartFullDateLabel(points[0].date))} – ${esc(chartFullDateLabel(last.date))} · ${esc(performanceBasisText(payload))}</span>`
    + `</div>`
    + (items.length ? `<div class="perf-summary-compare">${items.join("")}</div>` : "");
}

function syncPerformanceReturnSummary() {
  const host = document.getElementById?.("perfSummary");
  if (!host || !performancePayload) return;
  const html = performanceSummary(performancePayload, performanceRenderedSeries, performanceFocusKey);
  host.innerHTML = html;
  host.classList.toggle("hidden", !html);
}
let performanceRenderedSeries = [];
let performanceRenderedBox = { width: 0, height: 0 };   // 창 크기가 바뀌면 다시 그릴지 판단(app.js)

function applyPerformanceFocus() {
  document.querySelectorAll("[data-perf-focus]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.perfFocus === performanceFocusKey));
  });
  document.querySelectorAll("#chartCanvas [data-perf-series]").forEach(line => {
    const base = line.dataset.perfBase || line.dataset.perfSeries;
    line.classList.toggle("perf-dimmed", Boolean(performanceFocusKey && base !== performanceFocusKey));
    line.classList.toggle("perf-focused", base === performanceFocusKey);
  });
  syncPerformanceReturnSummary();
}

function renderPerformanceLegend(series = []) {
  const indexKeys = new Set(PERF_INDEX_META.map(([key]) => key));
  const accountChips = series
    .filter(item => !indexKeys.has(item.key) && !item.fixed)
    .map(item => `<button type="button" class="perf-legend-item perf-account-focus" data-perf-focus="${esc(item.key)}" aria-pressed="${item.key === performanceFocusKey}" title="${esc(item.name)} 선 강조 · 다시 누르면 해제"><i style="background:${item.color}"></i>${esc(item.name)}</button>`)
    .join("");
  const indexChips = PERF_INDEX_META
    .map(([key, label, color, short]) => {
      const on = !!performanceIndexes[key];
      // 꺼짐은 점까지 회색 — 색이 남아 있으면 켜진 것처럼 보인다. 모바일은 한 줄에 들도록 짧은 이름(있으면).
      const text = short
        ? `<span class="perf-chip-full">${esc(label)}</span><span class="perf-chip-short">${esc(short)}</span>`
        : esc(label);
      return `<button class="perf-legend-item perf-index-toggle${on ? " active" : ""}" type="button" data-index="${key}" aria-pressed="${on ? "true" : "false"}" aria-label="${esc(label)}" title="${esc(label)} ${on ? "숨기기" : "표시"}"><i style="background:${on ? color : "var(--chart-axis)"}"></i>${text}</button>`;
    })
    .join("");
  // 고정환율 칩: 켜짐/꺼짐 토글. 환노출이 없어 선이 생기지 않는 선택(원화 계좌만)에서는 칩을 흐리게 표시.
  const fxOn = !!performanceFixedFx;
  const fxAvailable = series.some(item => item.fixed) || !fxOn;
  const fxChip = `<button class="perf-legend-item perf-fx-toggle${fxOn ? " active" : ""}${fxAvailable ? "" : " unavailable"}" type="button" data-perf-fx="1" aria-pressed="${fxOn ? "true" : "false"}" title="${fxOn ? "고정환율 선 숨기기" : "고정환율 선 표시"} · 기준일 환율로 고정해 환율 변동을 걷어낸 시간가중 수익률(점선)"><i class="dashed" style="border-color:${fxOn ? "var(--brand)" : "var(--chart-axis)"}"></i>고정환율</button>`;
  // 고정환율 칩은 계좌 줄에 함께 둔다 — 계좌 선에 딸린 옵션이라 별도 '환율' 줄을
  // 만들면 한 줄을 통째로 쓰면서도 칩은 하나뿐이었다(2026-09-16 사용자 지시).
  return `<div class="perf-summary hidden" id="perfSummary" aria-live="polite"></div><div class="perf-legend-groups"><div class="perf-legend-section perf-account-section"><span class="perf-group-label" title="계좌 칩을 누르면 그 선을 강조">계좌</span><div class="perf-legend" role="group" aria-label="계좌 선 강조와 고정환율 표시">${accountChips || '<span class="perf-empty-label">표시할 계좌 없음</span>'}${fxChip}</div></div><div class="perf-legend-section perf-index-section"><span class="perf-group-label">비교</span><div class="perf-legend" role="group" aria-label="비교지수 표시">${indexChips}</div></div><div class="perf-legend-section perf-controls-section"><span class="perf-group-label">컨트롤</span><span class="perf-controls-slot"></span></div></div>`;
}

function bindPerformanceHover(series, geometry) {
  // 비교 차트와 동일한 HTML 오버레이 툴팁 사용(색상 이름 + %). 단, 로고·주가는 제외.
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
      const dot = document.getElementById(`perfDot-${item.key}`);
      if (!dot) return;
      const point = nearestChartPoint(item.points, targetTime);
      if (point) {
        dot.setAttribute("cx", x.toFixed(2));
        dot.setAttribute("cy", geometry.yFor(point.close).toFixed(2));
        dot.style.display = "";
      } else {
        dot.style.display = "none";
      }
    });
    const rows = series.map(item => {
      const point = nearestChartPoint(item.points, targetTime);
      if (!point) return "";
      const { cls } = changeDirection(point.close);
      const value = item.amount ? performanceValueText(point) : "";
      const nameHtml = item.fixed
        ? `<span class="ct-name perf-fixed-name" style="color:${item.color}">${esc(item.name.replace(/ · 고정환율$/, ""))}<small>고정환율</small></span>`
        : `<span class="ct-name" style="color:${item.color}">${esc(item.name)}</span>`;
      return `<div class="ct-row simple perf-tooltip-row${item.amount ? " with-value" : ""}${item.fixed ? " fixed" : ""}">${nameHtml}<span class="ct-pct ${cls}">${esc(pctChartLabel1(point.close))}</span><span class="ct-value">${esc(value)}</span></div>`;
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

function renderPerformanceChart(payload) {
  performancePayload = payload;
  const series = performanceSeries(payload);
  if (!series.some(item => item.key === performanceFocusKey)) performanceFocusKey = null;
  if (typeof syncChartBottomControls === "function") syncChartBottomControls(true);
  // syncChartLogToggle은 곧 syncChartDisplayControls라 인자가 그대로 표시 여부가 된다.
  // 예전엔 false를 넘겨 컨트롤 묶음을 통째로 숨겼지만, 이제 성과차트도 '부드럽게'를
  // 쓰므로 켜 둔다(로그·BB·일목 등 개별 버튼은 sync 안에서 성과일 때 숨긴다).
  if (typeof syncChartDisplayControls === "function") syncChartDisplayControls(true);
  const statsEl = document.getElementById("chartStats");
  if (statsEl) statsEl.innerHTML = "";   // 성과 차트엔 종목별 지표 패널 숨김
  document.getElementById("chartIcon").innerHTML = `<span class="asset-icon">%</span>`;
  document.getElementById("chartTicker").textContent = "성과";
  document.getElementById("chartName").textContent = "";
  syncPerformanceTitle(accountPerformanceTitle(payload));
  const priceSummary = document.getElementById("chartPriceSummary");
  if (priceSummary) priceSummary.innerHTML = "";
  if (typeof clearChartExternalLinks === "function") clearChartExternalLinks();

  if (!series.length || !series[0]?.points.length) {
    document.getElementById("chartMeta").textContent = `${payload?.holdings_count || 0}개 종목`;
    performanceRenderedSeries = [];
    syncPerformanceLegendHost(renderPerformanceLegend());
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">성과 차트 데이터 없음</div>`;
    renderChartRangeControls();
    bindPerformanceChartControls();
    return;
  }

  const allPoints = series.flatMap(item => item.points);
  const minTime = Math.min(...allPoints.map(point => point.time));
  const maxTime = Math.max(...allPoints.map(point => point.time));
  const values = allPoints.map(point => point.close);
  const scale = tightChartScale(values);
  const min = scale.min;
  const max = scale.max;
  const isMobileChart = Boolean(window.matchMedia?.("(max-width: 980px)")?.matches);
  syncChartRailLayout();   // 성과 화면은 레일을 쓰지 않는다(개별종목에서 넘어왔으면 풀린다)
  // 범례·요약 띠를 먼저 채운다 — 차트 높이를 '남은 화면'으로 재므로 그 위 높이가 정해져 있어야 한다.
  performanceRenderedSeries = series;
  syncPerformanceLegendHost(renderPerformanceLegend(series));
  syncPerformanceReturnSummary();
  // 넓은 화면에서 그림을 늘리지 않고 넓게 그린다(개별종목 차트와 같은 배율 상한, 2026-11-15).
  // 화면 높이에도 맞춘다(2026-11-20 개편 — 개별종목 차트와 같은 규칙): PC는 기본 높이의 0.75~1.6배.
  // 화면 아래까지 채우지 않고 100px을 남긴다(2026-11-20 사용자 지시 — 차트 영역만 줄인다).
  const canvasEl = document.getElementById("chartCanvas");
  const PERF_CHART_RESERVE = 100;
  const width = chartViewBoxWidth(canvasEl, isMobileChart, isMobileChart ? 0 : 432, PERF_CHART_RESERVE);
  const height = isMobileChart ? 864 : chartViewBoxHeight(canvasEl, width, 432, false, PERF_CHART_RESERVE);
  // 선 끝 라벨은 '이름 수익률'(2026-11-20 사용자 지시)을 두 열로 맞춘다(2026-11-21): 이름은 왼쪽 정렬, 수익률은 오른쪽 정렬.
  // 가장 긴 이름·수익률 폭만큼 오른쪽 여백을 연다. 금액은 호버 툴팁.
  const endFont = isMobileChart ? 24 : 10.5;   // CSS .perf-end-label과 같은 값(모바일은 viewBox 980을 약 0.35배로 줄여 그리므로 24 ≈ 실제 8.5px)
  const textWidth = (text, latin = 0.56) => [...String(text)].reduce((sum, ch) => sum + (/[\u3131-\uD79D]/.test(ch) ? 1 : latin) * endFont, 0);
  const endName = item => (item.fixed ? "고정환율" : item.name);
  const endNameWidth = Math.ceil(Math.max(0, ...series.map(item => textWidth(endName(item)))));
  const endValueWidth = Math.ceil(Math.max(0, ...series.map(item => textWidth(pctChartLabel1(item.points[item.points.length - 1].close), 0.62))));
  const endGap = Math.round(endFont * 0.6);
  // 모바일은 끝 라벨을 두지 않고 차트로 채운다(2026-11-21 사용자 지시) — 수익률은 위 요약 띠와 호버 툴팁에서 본다.
  const pad = isMobileChart
    ? { top: 22, right: 16, bottom: 22, left: 56 }
    : { top: 22, right: Math.min(240, Math.max(74, 7 + endNameWidth + endGap + endValueWidth + 6)), bottom: 22, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const range = max - min || 1;
  const xForTime = time => pad.left + (maxTime === minTime ? 0 : (time - minTime) / (maxTime - minTime) * plotW);
  const yFor = value => pad.top + (max - value) / range * plotH;
  const clampY = value => Math.max(pad.top + 4, Math.min(pad.top + plotH - 2, value));
  const pathFor = points => chartLinePath(points.map(point => ({ x: xForTime(point.time), y: yFor(point.close) })));
  const portfolio = series[0];
  const lastPoint = portfolio.points[portfolio.points.length - 1];
  document.getElementById("chartMeta").textContent = "";
  const tickLabel = value => `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.round(Math.abs(value))}%`;
  const yTicks = scale.ticks.map(value => ({ value, y: yFor(value) }));
  const vGrid = perfVerticalGrid(minTime, maxTime, chartRange);
  const labelEvery = Math.max(1, Math.ceil(vGrid.lines.length / 8));
  // (#3) per-line total performance shown at each line's right end, de-collided vertically
  const endLabels = isMobileChart ? [] : declutterChartLabels(series
    .map(item => {
      const lastPoint = item.points[item.points.length - 1];
      const last = lastPoint.close;
      return {
        key: item.key,
        base: item.base,
        fixed: Boolean(item.fixed),
        color: item.color,
        name: endName(item),
        close: last,
        value: "",
        y: yFor(last),
      };
    })
    , isMobileChart ? 30 : 14);
  document.getElementById("chartCanvas").innerHTML = `
    <svg class="line-chart perf-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="계좌 기간 성과 차트">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      <rect class="chart-plot-border" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      ${yTicks.map(tick => `
        <line class="chart-grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${tick.y.toFixed(2)}" y2="${tick.y.toFixed(2)}"></line>
        <text class="chart-y-label" x="${pad.left - 8}" y="${(tick.y + 4).toFixed(2)}">${esc(tickLabel(tick.value))}</text>
      `).join("")}
      ${vGrid.lines.map(time => `
        <line class="chart-grid perf-vgrid" x1="${xForTime(time).toFixed(2)}" x2="${xForTime(time).toFixed(2)}" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(2)}"></line>
      `).join("")}
      <line class="perf-zero-line" x1="${pad.left}" x2="${pad.left + plotW}" y1="${yFor(0).toFixed(2)}" y2="${yFor(0).toFixed(2)}"></line>
      ${vGrid.lines.map((time, index) => {
        if (index % labelEvery !== 0) return "";
        const x = xForTime(time);
        const anchor = x < pad.left + 18 ? "start" : x > pad.left + plotW - 18 ? "end" : "middle";
        return `<text class="chart-x-label" x="${x.toFixed(2)}" y="${height - 6}" text-anchor="${anchor}">${esc(perfGridLabel(time, vGrid.unit))}</text>`;
      }).join("")}
      ${series.map(item => `
        <path class="perf-line ${item.primary ? "primary" : item.fixed ? "fixed" : "index"}" data-perf-series="${esc(item.key)}"${item.base ? ` data-perf-base="${esc(item.base)}"` : ""} d="${pathFor(item.points)}" style="stroke:${item.color}"></path>
      `).join("")}
      ${endLabels.map(label => {
        const attrs = `data-perf-series="${esc(label.key)}"${label.base ? ` data-perf-base="${esc(label.base)}"` : ""} y="${(clampY(label.y) + endFont * 0.33).toFixed(2)}" style="fill:${label.color}"`;
        const nameX = pad.left + plotW + 7;
        return `<text class="perf-end-label perf-end-name${label.fixed ? " fixed" : ""}" ${attrs} x="${nameX.toFixed(2)}">${esc(label.name)}</text>`
          + `<text class="perf-end-label perf-end-value${label.fixed ? " fixed" : ""}" ${attrs} x="${(nameX + endNameWidth + endGap + endValueWidth).toFixed(2)}" text-anchor="end">${esc(pctChartLabel1(label.close))}</text>`;
      }).join("")}
      <rect id="chartHoverLayer" class="chart-hover-layer" x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"></rect>
      <g id="chartHoverGroup" class="chart-hover hidden">
        <line id="chartHoverLine" class="chart-hover-line" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + plotH}"></line>
        ${series.map(item => `<circle id="perfDot-${item.key}" class="perf-hover-dot" r="3.6" cx="0" cy="0" style="stroke:${item.color}"></circle>`).join("")}
      </g>
    </svg>
    <div id="compareTooltip" class="compare-tooltip hidden" aria-hidden="true"></div>
  `;
  syncPerformanceReturnSummary();
  if (typeof syncChartIntervalControl === "function") syncChartIntervalControl();   // 기간에 따라 일/주 표시가 바뀐다
  if (typeof syncChartDisplayControls === "function") syncChartDisplayControls(true);   // '부드럽게' 글자
  performanceRenderedBox = { width: document.getElementById("chartView")?.clientWidth || 0, height: window.innerHeight || 0 };
  renderChartRangeControls();
  bindPerformanceHover(series, { width, height, pad, plotW, plotH, minTime, maxTime, xForTime, yFor });
  bindPerformanceChartControls();
}

function bindPerformanceChartControls() {
  applyPerformanceFocus();
  document.querySelectorAll("[data-perf-focus]").forEach(button => {
    button.addEventListener("click", () => {
      performanceFocusKey = performanceFocusKey === button.dataset.perfFocus ? null : button.dataset.perfFocus;
      applyPerformanceFocus();
    });
  });
  document.querySelectorAll(".perf-index-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.index;
      performanceIndexes[key] = !performanceIndexes[key];
      renderPerformanceChart(performancePayload);
    });
  });
  document.querySelectorAll(".perf-fx-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      performanceFixedFx = !performanceFixedFx;
      renderPerformanceChart(performancePayload);
    });
  });
  document.querySelectorAll(".chart-range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.chartRangePopup != null || btn.dataset.chartCustom != null) {
        openChartRangeModal();
        return;
      }
      chartRange = btn.dataset.chartRange || DEFAULT_CHART_RANGE;
      reloadPerformanceChart();
    });
  });
}

function performanceRequestOptions() {
  return {
    detail: performanceDetailEnabled(),
    range: chartRange,
    start: chartRange === "custom" ? chartCustomRange.start : "",
    end: chartRange === "custom" ? chartCustomRange.end : "",
  };
}

async function reloadPerformanceChart({ skeleton = false } = {}) {
  if (!performanceChartOpen) return;
  const accounts = visibleAccounts();
  const allAccounts = selectionMode === "all";
  const token = ++performanceLoadToken;
  if (skeleton) {
    document.getElementById("chartMeta").textContent = "loading...";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  }
  const request = apiFetchAccountPerformance(
    accounts.map(account => account.id),
    allAccounts,
    performanceRequestOptions(),
  );
  performanceLoadInFlight = request;
  try {
    const payload = await request;
    if (!performanceChartOpen || token !== performanceLoadToken) return;
    renderPerformanceChart(payload);
  } catch (err) {
    if (!performanceChartOpen || token !== performanceLoadToken) return;
    document.getElementById("chartMeta").textContent = "";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">${esc(err.message || String(err))}</div>`;
  } finally {
    if (token === performanceLoadToken) performanceLoadInFlight = null;
  }
}

async function openPerformanceChart() {
  rememberListScroll();
  performanceChartOpen = true;
  syncSidebarTabs();
  discardHiddenListRowsForChart();
  syncTransactionPanel();
  chartTicker = null;
  chartPayload = null;
  syncDetailTabs();
  document.getElementById("chartIcon").innerHTML = `<span class="asset-icon">%</span>`;
  document.getElementById("chartTicker").textContent = "성과";
  document.getElementById("chartName").textContent = "";
  syncPerformanceTitle("계좌 성과");
  if (typeof clearChartExternalLinks === "function") clearChartExternalLinks();
  const perfPriceSummary = document.getElementById("chartPriceSummary");
  if (perfPriceSummary) perfPriceSummary.innerHTML = "";
  const perfRangeHost = document.getElementById("chartRangeHost");
  if (perfRangeHost) perfRangeHost.innerHTML = "";
  document.getElementById("chartMeta").textContent = "loading...";
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  await reloadPerformanceChart();
}

function priceChartRequestOptions() {
  return {
    range: chartRange,
    start: chartRange === "custom" ? chartCustomRange.start : "",
    end: chartRange === "custom" ? chartCustomRange.end : "",
  };
}

function discardHiddenListRowsForChart() {
  const holdings = document.getElementById("holdings");
  const interest = document.getElementById("interestRows");
  if (holdings) holdings.innerHTML = "";
  if (interest) interest.innerHTML = "";
}

// 차트를 열면 목록 표는 숨겨지고(display:none) 행도 비워져 스크롤이 맨 위로 돌아간다.
// 열기 직전 위치를 기억했다가 목록으로 돌아올 때 되돌린다. 차트에서 다른 차트로 넘어갈 때는
// 처음 목록 위치를 그대로 둔다.
const LIST_SCROLL_WRAP_IDS = ["detailTableWrap", "interestTableWrap", "dividendTableWrap"];
let listScrollMemory = null;

function rememberListScroll() {
  if (chartTicker || performanceChartOpen) return;
  const wrap = LIST_SCROLL_WRAP_IDS
    .map(id => document.getElementById(id))
    .find(el => el && !el.classList.contains("hidden"));
  listScrollMemory = {
    id: wrap?.id || "",
    top: wrap?.scrollTop || 0,
    left: wrap?.scrollLeft || 0,
    windowY: window.scrollY || 0,
  };
}

function restoreListScroll() {
  const memory = listScrollMemory;
  listScrollMemory = null;
  if (!memory) return;
  const wrap = memory.id ? document.getElementById(memory.id) : null;
  // 차트에 있는 동안 사이드바 탭을 바꿔 다른 표로 돌아왔으면 그 표의 위치는 건드리지 않는다.
  if (wrap && !wrap.classList.contains("hidden")) {
    wrap.scrollTop = memory.top;
    wrap.scrollLeft = memory.left;
    // 관심목록은 창 렌더링이라 맨 위 구간만 그려져 있다 — 되돌린 위치의 행을 바로 그린다.
    if (wrap.id === "interestTableWrap" && interestVirtual) renderInterestRowsWindow(true);
  }
  // 모바일은 표가 아니라 페이지가 스크롤된다.
  window.scrollTo(0, memory.windowY);
}

// 모바일(≤980px)은 페이지 전체가 스크롤된다. 개별종목을 열면 상단 요약 카드 아래의
// 툴바(목록·관심목록·거래내역…)가 화면 맨 위에 오게 맞춘다(2026-11-16 사용자 지시).
// 열 때는 스켈레톤뿐이라 문서가 짧아 끝까지 못 내려갈 수 있다 — 차트를 그린 뒤 한 번 더 맞추되,
// 그 사이 사용자가 더 내려 봤으면(목표보다 아래) 건드리지 않는다.
function chartToolbarScrollTarget() {
  if (!window.matchMedia?.("(max-width: 980px)").matches) return null;
  const toolbar = document.querySelector(".holdings-section .toolbar");
  if (!toolbar) return null;
  return Math.max(0, Math.round(toolbar.getBoundingClientRect().top + (window.scrollY || 0)));
}

function scrollChartToolbarToTop({ onlyIfAbove = false } = {}) {
  const target = chartToolbarScrollTarget();
  if (target == null) return;
  const current = window.scrollY || 0;
  if (onlyIfAbove && current >= target) return;
  if (Math.abs(current - target) > 1) window.scrollTo(0, target);
}

// 같은 종목을 기간만 바꿔 다시 부르면 티커 비교로는 옛 응답을 걸러 내지 못한다 — 요청 순번으로 마지막 것만 받는다.
let chartLoadToken = 0;
async function openChart(ticker) {
  const cleanTicker = String(ticker || "").trim().toUpperCase();
  if (!cleanTicker) return;
  // 같은 티커를 이미 로딩 중이면 재진입 무시 (연타·중복 클릭 시 fetch 중복 방지)
  if (chartTicker === cleanTicker && chartLoadInFlight) return;
  rememberListScroll();
  performanceChartOpen = false;
  syncSidebarTabs();
  performanceLoadToken += 1;
  syncPerformanceTitle("");   // 성과 → 종목 차트로 넘어갈 때 툴바 타이틀도 함께 내린다
  syncPerformanceLegendHost("");
  if (chartTicker !== cleanTicker) chartComparePayloads = [];
  chartTicker = cleanTicker;
  // 검색 팝업의 '최근 본 종목'에 올린다.
  if (typeof rememberRecentTicker === "function") rememberRecentTicker(cleanTicker);
  discardHiddenListRowsForChart();
  syncTransactionPanel();
  syncDetailTabs();
  document.getElementById("tableTitle").textContent = cleanTicker;
  renderChartIdentity({ ticker: cleanTicker, name: cleanTicker });
  const rangeHost = document.getElementById("chartRangeHost");
  if (rangeHost) rangeHost.innerHTML = "";
  document.getElementById("chartMeta").textContent = "loading...";
  document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  scrollChartToolbarToTop();
  const token = ++chartLoadToken;
  chartLoadInFlight = apiFetchChart(cleanTicker, usExtendedEnabled(), priceChartRequestOptions());
  try {
    const payload = await chartLoadInFlight;
    if (token !== chartLoadToken || chartTicker !== cleanTicker) return;
    chartPayload = payload;
    document.getElementById("tableTitle").textContent = payload.name || payload.ticker;
    renderLineChart(payload);
    scrollChartToolbarToTop({ onlyIfAbove: true });
  } catch (err) {
    if (token !== chartLoadToken || chartTicker !== cleanTicker) return;
    document.getElementById("chartMeta").textContent = "";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">${esc(err.message || String(err))}</div>`;
  } finally {
    if (token === chartLoadToken) chartLoadInFlight = null;   // 더 새 요청이 걸어 둔 표시는 지우지 않는다
  }
}

async function reloadPriceChartForMarketMode({ skeleton = false } = {}) {
  const cleanTicker = String(chartTicker || "").trim().toUpperCase();
  if (!cleanTicker || performanceChartOpen) return;
  const compareTickers = chartComparePayloads
    .map(item => String(item?.ticker || "").trim().toUpperCase())
    .filter(Boolean);
  if (skeleton) {
    document.getElementById("chartMeta").textContent = "loading...";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-skeleton"></div>`;
  }
  const options = priceChartRequestOptions();
  const token = ++chartLoadToken;
  chartLoadInFlight = apiFetchChart(cleanTicker, usExtendedEnabled(), options);
  try {
    const payloads = await Promise.all([
      chartLoadInFlight,
      ...compareTickers.map(ticker => apiFetchChart(ticker, usExtendedEnabled(), options)),
    ]);
    if (token !== chartLoadToken || chartTicker !== cleanTicker) return;
    chartPayload = payloads[0];
    chartComparePayloads = payloads.slice(1);
    document.getElementById("tableTitle").textContent = chartPayload.name || chartPayload.ticker;
    renderLineChart(chartPayload);
  } catch (err) {
    if (token !== chartLoadToken || chartTicker !== cleanTicker) return;
    document.getElementById("chartMeta").textContent = "";
    document.getElementById("chartCanvas").innerHTML = `<div class="chart-empty">${esc(err.message || String(err))}</div>`;
  } finally {
    if (token === chartLoadToken) chartLoadInFlight = null;
  }
}

function closeChart(updateHash = true) {
  chartTicker = null;
  chartLoadToken += 1;
  chartLoadInFlight = null;
  chartPayload = null;
  chartComparePayloads = [];
  performanceChartOpen = false;
  syncSidebarTabs();
  performanceLoadInFlight = null;
  performancePayload = null;
  syncPerformanceTitle("");
  syncPerformanceLegendHost("");
  if (updateHash && (location.hash.startsWith("#chart=") || location.hash === "#performance")) {
    history.pushState(null, "", location.pathname + location.search);
  }
  renderTable();
  restoreListScroll();
}

function syncChartRoute() {
  if (performanceChartFromHash()) {
    openPerformanceChart();
    return;
  }
  const ticker = chartTickerFromHash();
  if (ticker) openChart(ticker);
  else if (chartTicker || performanceChartOpen) closeChart(false);
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-charts");

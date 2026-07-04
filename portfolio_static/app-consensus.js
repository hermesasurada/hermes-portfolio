// 애널리스트 컨센서스(목표가·업사이드·편차·매수강도·투자의견) — 8767 서비스에서
// 서버 프록시(/api/quote)로 받아온다. 관심목록 컨센서스 컬럼 + 종목 상세화면
// 하단 블록이 공용으로 사용. 데이터 없거나 서비스가 죽으면 조용히 비운다.
let quoteData = {};                    // TICKER(대문자) → quote object
let quoteFetchedTickers = new Set();   // found:false 포함, 재요청 억제용
let quoteLoadKey = "";

// 컨센서스가 존재하지 않는 자산군(환율·지수·가상자산)은 조회 자체를 건너뛴다.
const CONSENSUS_SKIP_CATEGORIES = new Set(["fx", "index", "crypto"]);

// 투자의견 라벨 → 한글·정렬랭크·색상클래스(매수=상승=빨강 관례).
const RATING_META = {
  "strong buy": { label: "적극매수", rank: 5, cls: "up" },
  "buy": { label: "매수", rank: 4, cls: "up" },
  "hold": { label: "중립", rank: 3, cls: "flat" },
  "sell": { label: "매도", rank: 2, cls: "down" },
  "strong sell": { label: "적극매도", rank: 1, cls: "down" },
};

function ratingMeta(label) {
  return RATING_META[String(label || "").toLowerCase()] || { label: label || "-", rank: 0, cls: "flat" };
}

function quoteFor(ticker) {
  return quoteData[String(ticker || "").toUpperCase()] || null;
}

function consensusCandidate(row) {
  return !CONSENSUS_SKIP_CATEGORIES.has(String(row?.category || row?.assetClass || "").toLowerCase());
}

// 조회 대상 티커들의 컨센서스를 배치로 가져오고, 완료되면 rerender를 호출한다.
// (stats lazy-load와 동일 패턴: found:false도 fetched로 마킹해 반복요청 방지)
function loadQuotesForRows(tickers, rerender) {
  const wanted = Array.from(new Set((tickers || [])
    .map(ticker => String(ticker || "").toUpperCase())
    .filter(Boolean)));
  const missing = wanted.filter(ticker => !quoteFetchedTickers.has(ticker)).sort();
  if (!missing.length) return;
  const key = missing.join(",");
  if (quoteLoadKey === key) return;
  quoteLoadKey = key;
  apiFetchQuotes(missing).then(payload => {
    Object.entries(payload || {}).forEach(([ticker, quote]) => {
      quoteData[ticker.toUpperCase()] = quote;
    });
    missing.forEach(ticker => quoteFetchedTickers.add(ticker));
    quoteLoadKey = "";
    rerender?.();
  }).catch(() => {
    quoteLoadKey = "";
  });
}

// 관심목록 행에 정렬·표시용 컨센서스 필드를 병합. found 아니면 원본 그대로.
function attachConsensus(row) {
  const quote = quoteFor(row.ticker);
  if (!quote || !quote.found) return row;
  return {
    ...row,
    target_price: quote.target_price,
    upside_pct: quote.upside_pct,
    dispersion_pct: quote.dispersion_pct,
    buy_strength: quote.buy_strength,
    rating_label: quote.rating_label,
    rating_rank: ratingMeta(quote.rating_label).rank,
    consensus_currency: quote.currency,
  };
}

// ── 셀 포매터 (관심목록 컬럼 공용) ──────────────────────────────────
function consensusPriceText(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const digits = currency === "KRW" || currency === "JPY" || currency === "TWD" ? 0 : 2;
  return Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits });
}

function upsideText(value) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const number = Number(value);
  const cls = number > 0 ? "up" : number < 0 ? "down" : "flat";
  const sign = number > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${number.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%</span>`;
}

function dispersionText(value, basis) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const label = basis === "range" ? "범위폭" : "기관 편차";
  return `<span title="편차 기준: ${esc(label)}">${Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%</span>`;
}

function buyStrengthMarkup(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const pct = Math.max(0, Math.min(100, Math.round(number)));
  const cls = pct >= 60 ? "up" : pct <= 40 ? "down" : "flat";
  return `<span class="buy-meter ${cls}" title="매수강도 ${pct}/100">`
    + `<span class="buy-meter-track"><span class="buy-meter-fill" style="width:${pct}%"></span></span>`
    + `<span class="buy-meter-num">${pct}</span></span>`;
}

function ratingChipMarkup(label) {
  if (!label) return "-";
  const meta = ratingMeta(label);
  return `<span class="rating-chip ${meta.cls}">${esc(meta.label)}</span>`;
}

// ── 종목 상세화면 하단 블록 ─────────────────────────────────────────
function consensusBlockMarkup(ticker) {
  const quote = quoteFor(ticker);
  if (!quote || !quote.found) return "";   // 데이터 없으면 블록 자체를 숨김
  const currency = quote.currency;
  const rangeText = quote.tp_low != null && quote.tp_high != null
    ? `${consensusPriceText(quote.tp_low, currency)} ~ ${consensusPriceText(quote.tp_high, currency)}`
    : "-";
  const rows = [
    ["투자의견", ratingChipMarkup(quote.rating_label)],
    ["매수강도", buyStrengthMarkup(quote.buy_strength)],
    ["목표가", `<strong>${consensusPriceText(quote.target_price, currency)}</strong> <span class="consensus-unit">${esc(currency || "")}</span>`],
    ["업사이드", upsideText(quote.upside_pct)],
    ["목표가 범위", `<span class="consensus-range">${rangeText}</span>`],
    ["편차", dispersionText(quote.dispersion_pct, quote.dispersion_basis)],
    ["커버 애널", quote.n_analysts != null ? `${quote.n_analysts}명` : "-"],
    ["기준일", esc(quote.as_of || "-")],
  ];
  const cells = rows.map(([label, value]) => `
    <div class="consensus-cell">
      <span class="consensus-k">${esc(label)}</span>
      <span class="consensus-v">${value}</span>
    </div>`).join("");
  // 상세 리포트(증권사별·목표가 추이)는 8767 대시보드. localhost·Tailscale 어느
  // 호스트로 열려도 같은 호스트의 8767로 연결되도록 location.hostname 사용.
  const reportUrl = `http://${location.hostname}:8767/`;
  return `
    <div class="consensus-block">
      <div class="consensus-head">
        <span class="consensus-title">애널리스트 컨센서스</span>
        <a class="consensus-report-link" href="${esc(reportUrl)}" target="_blank" rel="noopener">리포트 상세 ↗</a>
      </div>
      <div class="consensus-grid">${cells}</div>
    </div>`;
}

// 상세화면 진입 시 단일 티커 컨센서스를 받아오고 도착하면 차트 지표를 다시 그린다.
function ensureChartQuote(ticker) {
  const clean = String(ticker || "").toUpperCase();
  if (!clean || quoteFetchedTickers.has(clean)) return;
  loadQuotesForRows([clean], () => {
    if (chartTicker === clean && !performanceChartOpen && !chartComparePayloads.length) {
      renderChartStats(chartPayload || { ticker: clean });
    }
  });
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("app-consensus");

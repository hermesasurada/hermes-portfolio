const fmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const fmt1 = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const btcQtyFmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 8 });

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function todayLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function localDateFromIso(dateText) {
  const text = String(dateText || "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const value = new Date(year, month - 1, day);
  return Number.isNaN(value.getTime()) ? null : value;
}
function earningsDisplayDate(dateText) {
  const date = localDateFromIso(dateText);
  if (!date) return null;
  const today = localDateFromIso(todayLocal());
  const daysPast = today ? Math.floor((today - date) / 86400000) : 0;
  if (daysPast < 3) return { date, estimated: false };
  const estimated = new Date(date);
  while (today && Math.floor((today - estimated) / 86400000) >= 3) {
    estimated.setMonth(estimated.getMonth() + 3);
  }
  return { date: estimated, estimated: true, source: date };
}
function monthDayText(date) {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}
function krw(v) { return krwShort(v); }
function krwShort(v) {
  if (v == null) return "-";
  const abs = Math.abs(v);
  if (abs >= 100000000) return fmt2.format(v / 100000000) + "억";
  if (abs >= 10000) return fmt.format(v / 10000) + "만";
  return fmt.format(v) + "원";
}
function money(v, cur) {
  if (v == null) return '<span class="missing">조회불가</span>';
  if (cur === "KRW") return krwShort(v);
  const prefix = cur === "USD" ? "$" : cur === "EUR" ? "€" : cur === "JPY" ? "¥" : "";
  return prefix + fmt.format(v);
}
function unitMoney(v, cur, ticker = "") {
  if (v == null) return '<span class="missing">조회불가</span>';
  if (String(ticker).toUpperCase() === "BTC") return `₩${fmt.format(Number(v) / 1000)}K`;
  if (cur === "KRW") return fmt.format(v) + "원";
  if (cur === "USD") return "$" + fmt1.format(v);
  if (cur === "EUR") return "€" + fmt1.format(v);
  if (cur === "JPY") return "¥" + fmt.format(v);
  return fmt1.format(v) + " " + cur;
}
function tradeQtyText(qty, ticker = "") {
  const n = Number(qty);
  if (!Number.isFinite(n)) return "-";
  return String(ticker).toUpperCase() === "BTC" ? btcQtyFmt.format(n) : fmt2.format(n);
}
function unitKrw(v) {
  return Number.isFinite(v) ? `${fmt.format(v)}원` : '<span class="missing">조회불가</span>';
}
// 환율 행: 시세가 곧 "원/외화 1단위" → 통화기호·KRW환산 없이 원 단위로만 표기.
function fxRateText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '<span class="missing">조회불가</span>';
  return `${(Math.abs(n) < 100 ? fmt2 : fmt1).format(n)}원`;
}
function currentPriceMarkup(row) {
  if (row.current_price == null) return '<span class="missing">조회불가</span>';
  if (row.category === "fx") return fxRateText(row.current_price);
  const local = unitMoney(row.current_price, row.currency, row.ticker);
  // KRW 종목·환산 불가 시엔 현지가 한 줄만 (이전엔 별도 컬럼이라 따로 보였음)
  if (row.currency === "KRW" || !Number.isFinite(row.current_price_krw)) return local;
  return `<span class="price-cell"><span>${local}</span><span class="krw-sub">(${unitKrw(row.current_price_krw)})</span></span>`;
}
function valueMarkup(row) {
  if (row.value == null) return '<span class="missing">조회불가</span>';
  const local = money(row.value, row.currency);
  if (row.currency === "KRW" || !Number.isFinite(row.value_krw)) return local;
  return `<span class="price-cell"><span>${local}</span><span class="krw-sub">(${krw(row.value_krw)})</span></span>`;
}
function changePercentText(pct, chip = false) {
  if (!Number.isFinite(pct)) return "-";
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "→";
  return `<span class="change-cell ${chip ? "pct-chip " : ""}${cls}"><span aria-hidden="true">${arrow}</span>${fmt2.format(Math.abs(pct))}%</span>`;
}
function changeMarkup(row) {
  return changePercentText(row.display_change_pct, true);   // 등락 컬럼은 칩 스타일
}
// 표 로딩 스켈레톤 — colspan 한 셀에 폭 다른 바를 여러 행 깔아 형태를 암시
function skeletonRows(colspan, rows = 8) {
  const widths = [62, 80, 48, 72, 55, 88, 66];
  return Array.from({ length: rows }, (_, i) =>
    `<tr class="skeleton-row"><td colspan="${colspan}"><span class="skeleton-bar" style="width:${widths[i % widths.length]}%"></span></td></tr>`
  ).join("");
}
function extendedChangeText(row) {
  return changePercentText(row.extended_change_pct);
}
function changeKrwText(v) {
  if (!Number.isFinite(v)) return "-";
  const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
  const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "→";
  return `<span class="change-cell ${cls}"><span aria-hidden="true">${arrow}</span>${krwShort(Math.abs(v))}</span>`;
}
function weightText(pct) {
  return Number.isFinite(pct) ? `${fmt2.format(pct)}%` : "-";
}
function earningsText(dateText) {
  const display = earningsDisplayDate(dateText);
  if (!display) return "-";
  const text = monthDayText(display.date);
  if (!display.estimated) return text;
  return `<span class="earnings-estimated" title="분기 예상 실적일 · 원 데이터 ${monthDayText(display.source)}">${text}</span>`;
}
function shortDateText(dateText) {
  if (!dateText) return "-";
  const text = String(dateText);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return "-";
  return text.slice(2, 10).replaceAll("-", ".");
}
function numberText(v, digits = 2) {
  return v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: digits }) : "-";
}
function signedPercentText(v, digits = 2) {
  if (v == null) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const cls = n > 0 ? "up" : n < 0 ? "down" : "flat";
  const arrow = n > 0 ? "▲" : n < 0 ? "▼" : "→";
  return `<span class="${cls}"><span aria-hidden="true">${arrow}</span>${Math.abs(n).toLocaleString("ko-KR", { maximumFractionDigits: digits })}%</span>`;
}
function dividendYieldText(v) {
  if (v == null || !Number.isFinite(Number(v)) || Number(v) === 0) return "-";
  return `${fmt2.format(Number(v))}%`;
}
function dividendCurrencyPrefix(currency) {
  return { USD: "$", EUR: "€", JPY: "¥", KRW: "₩" }[currency] || (currency ? `${currency} ` : "");
}
function dividendAmountText(v, currency) {
  if (v == null || !Number.isFinite(Number(v))) return "-";
  const digits = currency === "KRW" || currency === "JPY" ? 0 : 4;
  return `${dividendCurrencyPrefix(currency)}${Number(v).toLocaleString("ko-KR", { maximumFractionDigits: digits })}`;
}
function dividendMoneyText(v, currency) {
  if (v == null || !Number.isFinite(Number(v))) return "-";
  const digits = currency === "KRW" || currency === "JPY" ? 0 : 2;
  return `${dividendCurrencyPrefix(currency)}${Number(v).toLocaleString("ko-KR", { maximumFractionDigits: digits })}`;
}
function dividendFxText(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) : "-";
}
function dividendKrwText(v) {
  return v != null && Number.isFinite(Number(v)) ? `₩${fmt.format(Math.round(Number(v)))}` : "-";
}
function peText(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "-";
}
function betaText(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "-";
}
function indicatorToneAttr(v, kind) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const center = kind === "rsi" ? 50 : 50;
  const span = kind === "rsi" ? 20 : 50;
  const intensity = Math.max(0, Math.min(1, Math.abs(n - center) / span));
  const tone = n < center ? "var(--down)" : n > center ? "var(--up)" : "var(--muted)";
  const pct = Math.round(intensity * 100);
  const weight = intensity >= 0.72 ? 800 : intensity >= 0.36 ? 700 : 600;
  return `style="color: color-mix(in srgb, ${tone} ${pct}%, var(--muted)); font-weight: ${weight}"`;
}
function indicatorText(v, kind) {
  if (v == null || !Number.isFinite(Number(v))) return "-";
  const n = Number(v);
  return `<span class="indicator-tone" ${indicatorToneAttr(n, kind)}>${fmt.format(Math.round(n))}</span>`;
}
function fxRateForCurrency(currency) {
  return Number(data.fx?.[currency] || 1);
}
function toUsd(v, currency) {
  if (v == null) return null;
  const n = Number(v);
  const usdKrw = Number(data.fx?.USD || 0);
  if (!Number.isFinite(n) || !Number.isFinite(usdKrw) || usdKrw === 0) return null;
  if (currency === "USD") return n;
  if (currency === "KRW") return n / usdKrw;
  return n * fxRateForCurrency(currency) / usdKrw;
}
function marketCapText(v, currency) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  if (currency === "KRW") {
    const jo = Math.floor(n / 1_0000_0000_0000);
    const eok = Math.round((n - jo * 1_0000_0000_0000) / 1_0000_0000);
    if (jo > 0 && eok > 0) return `${fmt.format(jo)}조 ${fmt.format(eok)}억`;
    if (jo > 0) return `${fmt.format(jo)}조`;
    if (eok > 0) return `${fmt.format(eok)}억`;
    return krwShort(n);
  }
  const prefix = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "JPY" ? "¥" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000_000) return `${prefix}${fmt2.format(n / 1_000_000_000_000)}T`;
  if (abs >= 1_000_000_000) return `${prefix}${fmt2.format(n / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${prefix}${fmt2.format(n / 1_000_000)}M`;
  return `${prefix}${fmt.format(n)}`;
}
function marketCapMarkup(row) {
  if (row.market_cap == null || !Number.isFinite(Number(row.market_cap))) return "-";
  const local = marketCapText(row.market_cap, row.currency);
  if (row.currency === "USD") return local;
  const usd = marketCapText(row.market_cap_usd, "USD");
  return `<span class="price-cell"><span>${local}</span><span class="krw-sub">(${usd})</span></span>`;
}
function logoMarkup(row) {
  const text = row.logo?.text || row.ticker.slice(0, 2).toUpperCase();
  const url = row.logo?.url;
  // 흰색/연한 로고는 서버가 logo.dark 플래그로 표시 (detect_dark_logos.py 자동 감지)
  const darkLogo = row.logo?.dark ? " dark-logo" : "";
  if (url) {
    return `<span class="asset-icon has-image" title="${row.name}"><span class="fallback-text">${text}</span><img class="${darkLogo.trim()}" src="${url}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.classList.remove('has-image');this.remove()"></span>`;
  }
  return `<span class="asset-icon" title="${row.name}"><span class="fallback-text">${text}</span></span>`;
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("format");

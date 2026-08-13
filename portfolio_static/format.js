const fmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const fmt1 = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const lowPriceFmt = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
function krwRoundedMan(v) {
  if (v == null) return "-";
  const abs = Math.abs(v);
  if (abs >= 100000000) return fmt2.format(v / 100000000) + "억";
  return fmt.format(v / 10000) + "만";
}
function money(v, cur) {
  if (v == null) return '<span class="missing">조회불가</span>';
  if (cur === "KRW") return krwShort(v);
  const prefix = {
    USD: "$",
    EUR: "€",
    JPY: "¥",
    GBP: "£",
    CHF: "CHF ",
    CAD: "C$",
    AUD: "A$",
    SGD: "S$",
    HKD: "HK$",
    INR: "₹",
  }[cur] || "";
  return prefix + fmt.format(v);
}
function unitPriceNumberText(v, defaultFormatter = fmt1) {
  const number = Number(v);
  if (!Number.isFinite(number)) return "-";
  return (Math.abs(number) <= 100 ? lowPriceFmt : defaultFormatter).format(number);
}
function unitMoney(v, cur, ticker = "") {
  if (v == null) return '<span class="missing">조회불가</span>';
  if (String(ticker).toUpperCase() === "BTC") return `₩${fmt.format(Number(v) / 1000)}K`;
  const text = unitPriceNumberText(v, cur === "KRW" || cur === "JPY" ? fmt : fmt1);
  if (cur === "KRW") return text + "원";
  if (cur === "USD") return "$" + text;
  if (cur === "EUR") return "€" + text;
  if (cur === "JPY") return "¥" + text;
  if (cur === "GBP") return "£" + text;
  if (cur === "CHF") return "CHF " + text;
  if (cur === "CAD") return "C$" + text;
  if (cur === "AUD") return "A$" + text;
  if (cur === "SGD") return "S$" + text;
  if (cur === "HKD") return "HK$" + text;
  if (cur === "INR") return "₹" + text;
  return text + " " + cur;
}
function tradeQtyText(qty, ticker = "") {
  const n = Number(qty);
  if (!Number.isFinite(n)) return "-";
  return String(ticker).toUpperCase() === "BTC" ? btcQtyFmt.format(n) : fmt2.format(n);
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
  return unitMoney(row.current_price, row.currency, row.ticker);
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
  const change = changePercentText(row.display_change_pct, true);
  const note = row?.change_session_note;
  if (!note?.label) return change;
  const dateText = String(note.price_date || "").replaceAll("-", ".");
  const title = [dateText ? `${dateText} 기준 등락` : "직전 거래일 등락", note.reason ? `${note.reason} 휴장` : "휴장"].join(" · ");
  return `<span class="change-with-session">${change}<sup class="change-session-note" title="${esc(title)}">${esc(note.label)}</sup></span>`;
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
  const amount = Math.abs(v) < 0.5 ? "0원" : krwRoundedMan(Math.abs(v));
  return `<span class="change-cell ${cls}"><span aria-hidden="true">${arrow}</span>${amount}</span>`;
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
function fractionPercentText(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toLocaleString("ko-KR", { maximumFractionDigits: digits })}%`;
}
function fractionSignedPercentText(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? signedPercentText(n * 100, digits) : "-";
}
function rawPercentText(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${n.toLocaleString("ko-KR", { maximumFractionDigits: digits })}%`;
}
function freeCashFlowText(v, currency) {
  return marketCapText(v, currency);
}
function dividendYieldText(v) {
  if (v == null || !Number.isFinite(Number(v)) || Number(v) === 0) return "-";
  return `${fmt2.format(Number(v))}%`;
}
function dividendCurrencyPrefix(currency) {
  return {
    USD: "$",
    EUR: "€",
    JPY: "¥",
    KRW: "₩",
    GBP: "£",
    CHF: "CHF ",
    CAD: "C$",
    AUD: "A$",
    SGD: "S$",
    HKD: "HK$",
  }[currency] || (currency ? `${currency} ` : "");
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
/* 손익비 산식은 서버(portfolio_core/risk_reward.py)가 단일 진실 —
   /api/stats 응답의 score·basis(기준 기간)·quality(TR/P)를 표시만 한다.
   기본 케이스(5Y·총수익)는 라벨 생략, 폴백만 '3Y'·'5Y·P' 형태로 병기. */
function riskRewardScoreText(v, basis, quality) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const cls = n > 0 ? "up" : n < 0 ? "down" : "flat";
  const sign = n > 0 ? "+" : "";
  let mark = "";
  if (basis && (basis !== "5y" || quality === "P")) {
    const label = `${basis.toUpperCase()}${quality === "P" ? "·P" : ""}`;
    const why = basis !== "5y"
      ? `이력이 짧아 ${basis.toUpperCase()} 기준으로 산출`
      : "배당 이력 미비로 가격수익률 기준";
    mark = ` <small class="history-growth-basis" title="${why}${quality === "P" ? " (P=가격 폴백)" : ""}">${label}</small>`;
  }
  return `<span class="${cls}">${sign}${n.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${mark}</span>`;
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
// GICS 섹터 한글 라벨 (yfinance info.sector 명칭 기준)
const SECTOR_LABELS = {
  "Technology": "기술",
  "Financial Services": "금융",
  "Healthcare": "헬스케어",
  "Consumer Cyclical": "경기소비재",
  "Consumer Defensive": "필수소비재",
  "Industrials": "산업재",
  "Energy": "에너지",
  "Utilities": "유틸리티",
  "Real Estate": "부동산",
  "Basic Materials": "소재",
  "Communication Services": "통신",
};
function sectorLabel(sector) {
  const key = String(sector || "").trim();
  if (!key) return "";
  return SECTOR_LABELS[key] || key;
}

function marketCapText(v, currency) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  if (currency === "KRW") {
    const jo = n / 1_0000_0000_0000;
    // 조 단위는 소수 1자리 반올림·콤마 없이 짧게 — "1,312조 7,978억" → "1312.8조"
    if (jo >= 1) {
      // toFixed는 FP 오차로 1.95→"1.9"가 되므로 Math.round 기반 반올림
      const rounded = Math.round(jo * 10) / 10;
      const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
      return `${text}조`;
    }
    const eok = Math.round(n / 1_0000_0000);
    if (eok > 0) return `${fmt.format(eok)}억`;
    return krwShort(n);
  }
  const prefix = {
    USD: "$",
    EUR: "€",
    JPY: "¥",
    GBP: "£",
    CHF: "CHF ",
    CAD: "C$",
    AUD: "A$",
    SGD: "S$",
    HKD: "HK$",
  }[currency] || "";
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

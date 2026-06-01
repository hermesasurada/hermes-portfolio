const fmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const fmt1 = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function todayLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
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
function unitMoney(v, cur) {
  if (v == null) return '<span class="missing">조회불가</span>';
  if (cur === "KRW") return fmt.format(v) + "원";
  if (cur === "USD") return "$" + fmt1.format(v);
  if (cur === "EUR") return "€" + fmt1.format(v);
  if (cur === "JPY") return "¥" + fmt.format(v);
  return fmt1.format(v) + " " + cur;
}
function unitKrw(v) {
  return Number.isFinite(v) ? `${fmt.format(v)}원` : '<span class="missing">조회불가</span>';
}
function currentPriceMarkup(row) {
  if (row.current_price == null || !Number.isFinite(row.current_price_krw)) return '<span class="missing">조회불가</span>';
  const local = unitMoney(row.current_price, row.currency);
  if (row.currency === "KRW") return local;
  return `<span class="price-cell"><span>${local}</span><span class="krw-sub">(${unitKrw(row.current_price_krw)})</span></span>`;
}
function valueMarkup(row) {
  if (row.value == null || !Number.isFinite(row.value_krw)) return '<span class="missing">조회불가</span>';
  const local = money(row.value, row.currency);
  if (row.currency === "KRW") return local;
  return `<span class="price-cell"><span>${local}</span><span class="krw-sub">(${krw(row.value_krw)})</span></span>`;
}
function localCurrentPriceText(row) {
  return row.current_price == null ? '<span class="missing">조회불가</span>' : unitMoney(row.current_price, row.currency);
}
function krwCurrentPriceText(row) {
  return Number.isFinite(row.current_price_krw) ? unitKrw(row.current_price_krw) : '<span class="missing">조회불가</span>';
}
function localValueText(row) {
  return row.value == null ? '<span class="missing">조회불가</span>' : money(row.value, row.currency);
}
function krwValueText(row) {
  return Number.isFinite(row.value_krw) ? krw(row.value_krw) : '<span class="missing">조회불가</span>';
}
function changeText(v, pct) {
  if (v == null || pct == null) return "-";
  const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
  const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "→";
  return `<span class="change-cell ${cls}"><span aria-hidden="true">${arrow}</span>${fmt2.format(Math.abs(pct))}%</span>`;
}
function changePercentText(pct) {
  if (!Number.isFinite(pct)) return "-";
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "→";
  return `<span class="change-cell ${cls}"><span aria-hidden="true">${arrow}</span>${fmt2.format(Math.abs(pct))}%</span>`;
}
function pctChangeText(pct, label = "") {
  if (!Number.isFinite(pct)) return "";
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "→";
  return `<span class="${cls}">${label}${arrow}${fmt2.format(Math.abs(pct))}%</span>`;
}
function changeMarkup(row) {
  return changePercentText(row.display_change_pct);
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
  if (!dateText) return "-";
  const text = String(dateText);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return "-";
  return text.slice(5, 10).replace("-", "/");
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
function dividendAmountText(v, currency) {
  if (v == null || !Number.isFinite(Number(v))) return "-";
  const digits = currency === "KRW" || currency === "JPY" ? 0 : 4;
  return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: digits });
}
function dividendMoneyText(v, currency) {
  if (v == null || !Number.isFinite(Number(v))) return "-";
  const digits = currency === "KRW" || currency === "JPY" ? 0 : 2;
  return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: digits });
}
function dividendFxText(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) : "-";
}
function dividendManText(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) : "-";
}
function intText(v) {
  return v != null && Number.isFinite(Number(v)) ? fmt.format(Math.round(Number(v))) : "-";
}
function peText(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "-";
}
function indicatorText(v, kind) {
  if (v == null || !Number.isFinite(Number(v))) return "-";
  const n = Number(v);
  let cls = "flat";
  if (kind === "rsi") {
    cls = n >= 70 ? "up" : n <= 30 ? "down" : "flat";
  } else {
    cls = n >= 100 ? "up" : n <= 0 ? "down" : "flat";
  }
  return `<span class="${cls}">${fmt.format(Math.round(n))}</span>`;
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
  const darkLogo = ["PLTR", "ASML", "DIS"].includes(row.ticker) ? " dark-logo" : "";
  if (url) {
    return `<span class="asset-icon has-image" title="${row.name}"><span class="fallback-text">${text}</span><img class="${darkLogo.trim()}" src="${url}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.classList.remove('has-image');this.remove()"></span>`;
  }
  return `<span class="asset-icon" title="${row.name}"><span class="fallback-text">${text}</span></span>`;
}

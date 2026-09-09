// One lazy request per ticker (5-minute cache); no addition to initial stats payload.
const companyProfileCache = new Map();
let companyProfileAnchor = null;
let companyProfileRequest = 0;

function companyProfileButton(ticker, name) {
  return `<button class="company-info-btn" type="button" data-company-profile="${esc(ticker)}"
    aria-label="${esc(name || ticker)} 소개" aria-haspopup="dialog" aria-expanded="false" aria-controls="companyProfilePopover">
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="6" r="1" fill="currentColor"/></svg>
  </button>`;
}

function closeCompanyProfile(restoreFocus = false) {
  const panel = document.getElementById("companyProfilePopover");
  const anchor = companyProfileAnchor;
  companyProfileRequest += 1;
  companyProfileAnchor = null;
  anchor?.setAttribute("aria-expanded", "false");
  if (panel.matches(":popover-open")) panel.hidePopover();
  if (restoreFocus && anchor?.isConnected) anchor.focus();
}

function positionCompanyProfile() {
  const panel = document.getElementById("companyProfilePopover");
  if (!companyProfileAnchor?.isConnected) return closeCompanyProfile();
  const rect = companyProfileAnchor.getBoundingClientRect();
  const gap = 10;
  const width = Math.min(460, window.innerWidth - gap * 2);
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap))}px`;
  const height = panel.getBoundingClientRect().height;
  const below = rect.bottom + 8;
  panel.style.top = `${Math.max(gap, Math.min(below + height <= window.innerHeight - gap ? below : rect.top - height - 8, window.innerHeight - height - gap))}px`;
}

function renderCompanyProfile(profile) {
  const panel = document.getElementById("companyProfilePopover");
  panel.querySelector(".company-profile-title").textContent = profile.name || profile.ticker;
  const content = panel.querySelector(".company-profile-content");
  content.replaceChildren();
  const add = (tag, text, className) => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    content.append(el);
    return el;
  };
  if (profile.status !== "ready") {
    add("p", "최근 사업자료를 확인해 소개문 준비 중 · 기존 수집 소개문은 사용하지 않음", "company-profile-muted");
    return;
  }
  const kind = {company: "기업", etf: "ETF", asset: "자산", index: "지수", fx: "환율"}[profile.kind] || "종목";
  add("div", `${profile.ticker} · ${kind}`, "company-profile-meta");
  for (const paragraph of profile.paragraphs) add("p", paragraph);
  const details = add("details", "", "company-profile-sources");
  const summary = document.createElement("summary");
  summary.textContent = `출처 ${profile.sources.length}개 · 검토 ${profile.reviewed_at}`;
  details.append(summary);
  const basis = document.createElement("p");
  basis.textContent = `자료 기준: ${profile.basis}`;
  details.append(basis);
  for (const source of profile.sources) {
    let url;
    try { url = new URL(source.url); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    const link = document.createElement("a");
    link.href = url.href;
    link.textContent = source.title;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    details.append(link);
  }
  details.addEventListener("toggle", positionCompanyProfile);
}

async function toggleCompanyProfile(button) {
  if (companyProfileAnchor === button) return closeCompanyProfile(true);
  closeCompanyProfile();
  companyProfileAnchor = button;
  const request = ++companyProfileRequest;
  const ticker = button.dataset.companyProfile;
  const panel = document.getElementById("companyProfilePopover");
  panel.querySelector(".company-profile-title").textContent = ticker;
  panel.querySelector(".company-profile-content").textContent = "소개 불러오는 중…";
  button.setAttribute("aria-expanded", "true");
  panel.showPopover();
  positionCompanyProfile();
  panel.querySelector("[data-company-profile-close]").focus({preventScroll: true});
  try {
    const cached = companyProfileCache.get(ticker);
    const profile = cached && Date.now() - cached.at < 300000
      ? cached.data : await fetchJson(`/api/company-profile?ticker=${encodeURIComponent(ticker)}`);
    if (profile.status === "ready") companyProfileCache.set(ticker, {at: Date.now(), data: profile});
    if (request !== companyProfileRequest) return;
    renderCompanyProfile(profile);
    positionCompanyProfile();
  } catch {
    if (request !== companyProfileRequest) return;
    panel.querySelector(".company-profile-content").textContent = "소개를 불러오지 못함 · 버튼을 다시 눌러 재시도";
    positionCompanyProfile();
  }
}

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && companyProfileAnchor) {
    event.preventDefault();
    closeCompanyProfile(true);
  }
});
window.addEventListener("resize", () => { if (companyProfileAnchor) closeCompanyProfile(); });
document.addEventListener("scroll", event => {
  if (companyProfileAnchor && !document.getElementById("companyProfilePopover").contains(event.target)) closeCompanyProfile();
}, true);
(window.__loaded = window.__loaded || new Set()).add("app-company-profile");

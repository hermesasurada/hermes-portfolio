function setTradeSide(side) {
  const value = side === "SELL" ? "SELL" : "BUY";
  document.getElementById("tradeSide").value = value;
  document.querySelectorAll(".trade-side-toggle .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.side === value);
    btn.setAttribute("aria-pressed", String(btn.dataset.side === value));
  });
}

function initTradeSideToggle() {
  document.querySelectorAll(".trade-side-toggle .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => setTradeSide(btn.dataset.side));
  });
  setTradeSide(document.getElementById("tradeSide").value);
}

function setTradeApply(enabled) {
  const input = document.getElementById("tradeApply");
  input.checked = Boolean(enabled);
  document.querySelectorAll(".trade-apply-toggle .seg-btn").forEach(btn => {
    const on = (btn.dataset.apply === "1") === input.checked;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
}

function initTradeApplyToggle() {
  document.querySelectorAll(".trade-apply-toggle .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => setTradeApply(btn.dataset.apply === "1"));
  });
  setTradeApply(document.getElementById("tradeApply").checked);
}

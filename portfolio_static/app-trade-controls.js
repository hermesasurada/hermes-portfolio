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
  const button = document.getElementById("tradeApplyToggle");
  input.checked = Boolean(enabled);
  button.classList.toggle("active", input.checked);
  button.setAttribute("aria-pressed", String(input.checked));
  button.textContent = input.checked ? "반영" : "미반영";
}

function initTradeApplyToggle() {
  const input = document.getElementById("tradeApply");
  const button = document.getElementById("tradeApplyToggle");
  button.addEventListener("click", () => setTradeApply(!input.checked));
  setTradeApply(input.checked);
}

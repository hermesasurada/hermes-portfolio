# Portfolio project instructions

## Ownership and deployment

- Application source lives in this repository. Runtime databases and logos live under `~/.hermes/data/`; do not move generated data into Git.
- After verified source changes, commit only task-related files and push `origin main` without asking again.
- Static frontend changes are served with `no-store` and need only a refresh. Python backend changes require `launchctl kickstart -k gui/$(id -u)/com.yhandhs.portfolio-web`.
- Verify the live service at `http://localhost:8765`, not through its Tailscale address.

## UI invariants

- Korean market colors are mandatory: gains are red (`--up`) and losses are blue (`--down`).
- Keep the current cool-blue light/dark theme and use CSS color tokens. Do not restore the old cream/sepia theme without an explicit request.
- Table vertical scrollbars stay hidden and horizontal scrollbars remain visible. Set `::-webkit-scrollbar { width: 0; height: 8px; }`; do not add standard `scrollbar-width` or `scrollbar-color` rules that disable the WebKit styling.
- Use the single delegated document handler in `app.js` for ticker and dividend actions. Do not bind listeners again after each render.
- `sortState`, `sortRows`, and `scheduleAutoRefresh` are the single authorities for sorting and periodic refresh behavior.
- Transaction APIs return the selected account's full history. Filter in the frontend, paginate at 20 rows, and calculate reconstructed balances from the unfiltered ledger.
- Preserve every JavaScript load marker and the boot error check in `index.html`.

## Data invariants

- `daily_prices.close` is the raw, dividend-unadjusted market close. Performance and technical indicators use price returns.
- Split repair uses recorded `stock_splits` ratios and adjusts only the contiguous old-scale segment. Spike cleanup removes temporary spikes only; it must preserve real crashes and splits.
- Use `prices.fx_rates()` as the single FX mapping source.
- Collection scripts must hold `collector_lock`, and database access must use `with connect() as conn:` so connections are closed.
- Ledger mutations and `account_value_snapshots` rebuilds belong in one `BEGIN IMMEDIATE` transaction and on the same connection. Reads must not rebuild snapshots.
- Portfolio performance is time-weighted return. Cash flows and trade cash must remain in every account series so deposits and purchases are not counted as investment gains.
- The analyst consensus block depends on the local `analyst-reports` service through the same-origin `/api/quote` proxy. Failure of that service may hide consensus data but must not break the portfolio dashboard.

`CLAUDE.md` contains historical repair details. Consult it only when working on those specific records; the stable rules above are authoritative for normal development.

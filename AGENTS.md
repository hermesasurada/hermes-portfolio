# Portfolio project instructions

## Ownership and deployment

- Application source lives in this repository. Runtime databases and logos live under `~/.hermes/data/`; do not move generated data into Git.
- After verified source changes, commit only task-related files and push `origin main` without asking again.
- Static frontend changes are served with `no-store` and need only a refresh. Python backend changes require `launchctl kickstart -k gui/$(id -u)/com.yhandhs.portfolio-web`.
- Verify the live service at `http://localhost:8765`, not through its Tailscale address.

## UI invariants

- Korean market colors are mandatory: gains are red (`--up`) and losses are blue (`--down`).
- Keep the user-approved white/slate light/dark theme (September 2026) and use CSS color tokens. Blue indicates interaction/selection; no blue glow or cream/sepia background. Use local Pretendard and Roboto Mono fonts.
- Table vertical scrollbars stay hidden and horizontal scrollbars remain visible. Set `::-webkit-scrollbar { width: 0; height: 8px; }`; do not add standard `scrollbar-width` or `scrollbar-color` rules that disable the WebKit styling.
- Use the single delegated document handler in `app.js` for ticker and dividend actions. Do not bind listeners again after each render.
- `sortState`, `sortRows`, and `scheduleAutoRefresh` are the single authorities for sorting and periodic refresh behavior.
- Account/watchlist extended-column sorting uses extended percentage change when available (including zero), otherwise regular-session percentage change, regardless of market. Rows missing both sort last in either direction. Do not fabricate extended quote display values or sort by currency-denominated prices.
- Transaction APIs return the selected account's full history. Filter in the frontend, paginate at 20 rows, and calculate reconstructed balances from the unfiltered ledger.
- Mobile transaction headers keep title, name filter, hidden-history toggle and expand/collapse button on one row; hide the account-scope badge and redundant filter caption only on mobile. Keep all filter and ledger behavior intact.
- Desktop transaction headers also keep action buttons on one row. Scope the title area's flexible width to this panel so shared full-width toolbar rules cannot squeeze the action group.
- Account holdings lists must not inject market-index rows or expose an index toggle. Index watchlists, hero ticker pages and chart benchmarks remain supported independently.
- Account holdings lists end with market cap/AUM, earnings date (`실적일`), then trade action; keep header/cell order and column widths aligned.
- Account and watchlist lists show SMA20/50/200 percentage distance immediately after monthly BB, using the API's price-mode-adjusted indicators. Missing distances sort last; all-empty watchlist columns remain hidden.
- Preserve every JavaScript load marker and the boot error check in `index.html`.
- Keep the experimental trade-timing column compact (76px) in both lists: short labels 매수/매도/주의/관찰/대기/돌파, with any R/ATR value on a second line. Preserve the experimental header and detailed rule tooltips.
- Logos in account/watchlist lists and the individual chart open locally authored Korean introductions; keep ticker/name chart links separate and do not restore a standalone info icon. The compact popover uses a translucent gray background in both themes, preserving full text and expandable sources. Use concise noun-style endings (no `~니다`), roughly twice the September 2026 sample length, with sources, source period and review date. Prioritize current holdings before extending coverage. Runtime catalog is `~/.hermes/data/company_profiles.json`; never fetch/generate introductions during page reads or fabricate content for pending tickers.
- Chart controls stay in one normal-flow row above the plot on desktop and mobile; do not restore overlay offsets or reserve control height inside the plot. Performance legends separate accounts (click to emphasize, not hide) from benchmark visibility toggles. Show actual plotted portfolio dates and the backend's TWR basis, not a new return calculation.
- Calendar view honors saved grid/list choice; only a first-time mobile user defaults to list. Mobile calendar grids retain readable text and horizontal scrolling. Preserve event type/region/holdings filters and earnings-first, market-cap-descending ordering. Regression checks: `node tests/test_analysis_views.js`.

## Data invariants

- Preserve the existing entry risk/reward column and formula. Account/watchlist lists place the separate experimental `trade_timing` reference immediately to its right. Buy requires rising SMA50, price above SMA50 and optional SMA200, an SMA20 upward cross within three bars still held, and R≥1.5. R uses prior-20-bar high and min(prior-10-bar low−0.5ATR, price−1.5ATR). Sell requires price below SMA20, ≥3ATR off the prior-20-bar high, and prior-low break; ≥2ATR below SMA20 is caution. ATR14 uses up to 61 prior OHLC bars. Same/new-session selected-price recalculation must preserve these prior-bar anchors. Missing OHLC/history and leveraged/inverse/index/FX items stay absent, never neutral-imputed. This is unvalidated price-only reference, not a trade recommendation or probability; keep R/ATR units and provisional-session caveats visible. Sort by state, never compare unlike units.

- Entry risk/reward uses daily SMA50 (±2% ramp) and optional SMA200 (±5% ramp), matching chart periods. Trend strength weights weekly RSI/SMA50/SMA200 at 40/40/20; without SMA200, weekly RSI and SMA50 each receive 50%. All other required inputs still gate missing scores. Keep live, extended-price, chart-history and transaction-score paths on this same formula.

- β″ uses up to 252 common trading-day returns: Korean-listed stocks/ETFs (`.KS`, `.KQ`) use KODEX 200TR (`278530.KS`); other instruments retain S&P 500. Missing Korean benchmark history must not fall back to S&P 500. Keep the first β field's existing provider/calculation behavior unchanged.

- Individual-chart SMA overlays use 20/50/200 trading-day closes from full history before range trimming. Weekly/monthly bars carry the last daily SMA; they never reinterpret the periods as weeks/months. Live-price overlays follow the existing extended-session selection; incomplete windows stay absent.
- Ichimoku, unlike the daily SMAs, follows the selected day/week/month unit: 9/26/52 bars with 26-bar displacement. Compute from full history before display-window trimming, as of each daily point (no future days within an unfinished week/month). Missing weekly/monthly windows must not fall back to daily Ichimoku.
- Draw the next 26 bars of Ichimoku leading spans from observed data only, with repeated vertical-line fills (red/blue), never synthetic future prices. Reserve their axis space and scale regardless of visibility.
- Changing the transaction ticker replaces the unit price with that ticker's current selected-session quote (missing quotes clear the previous price). Submitting or refreshing names must preserve a manually edited execution price.
- The cash-flow matrix opens a separate entry dialog: account/date/deposit-or-withdrawal/amount in KRW ten-thousands/optional note. Persist exact KRW amounts, prevent double submits, refresh the selected year after saving, and retain atomic snapshot rebuilds. Display rounding never changes stored amounts.
- SMA period buttons live inside the chart control row and toggle each line independently, with per-period local preferences. Preserve the old master-toggle preference when initializing missing per-period settings.
- Keep BB and Ichimoku controls adjacent, followed by the 20/50/200 SMA controls.
- Desktop chart controls show group captions (이동평균선, 단위, 기간, 거래) and Buy/Sell labels; mobile hides captions and retains compact B/S labels.
- Stock-chart price-axis bounds always include every available SMA, BB, Ichimoku value and eligible trade marker in the selected range, regardless of visibility toggles. Toggling overlays/markers must not move the price line; missing values remain excluded.
- Header branding follows the sibling services' local Pretendard, compact logo/title style; no header FX strip. The persisted hero carousel cycles portfolio → indexes → FX (USD/KRW, EUR/KRW, JPY/KRW per 1 currency unit), with all pages sharing stable height and FX rates sourced from the existing data.fx mapping.
- `daily_prices.close` is the raw, dividend-unadjusted market close. Performance and technical indicators use price returns.
- Split repair uses recorded `stock_splits` ratios and adjusts only the contiguous old-scale segment. Spike cleanup removes temporary spikes only; it must preserve real crashes and splits.
- Use `prices.fx_rates()` as the single FX mapping source.
- Collection scripts must hold `collector_lock`, and database access must use `with connect() as conn:` so connections are closed.
- Ledger mutations and `account_value_snapshots` rebuilds belong in one `BEGIN IMMEDIATE` transaction and on the same connection. Reads must not rebuild snapshots.
- Portfolio performance is time-weighted return. Cash flows and trade cash must remain in every account series so deposits and purchases are not counted as investment gains.
- The analyst consensus block depends on the local `analyst-reports` service through the same-origin `/api/quote` proxy. Failure of that service may hide consensus data but must not break the portfolio dashboard.

`CLAUDE.md` contains historical repair details. Consult it only when working on those specific records; the stable rules above are authoritative for normal development.

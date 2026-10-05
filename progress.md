# KuruGrid — Progress Log

> Companion to `PLAN.md` (Steps 1–8). Updated as work lands.
> Owner policy: `AGENTS.md`, `dependencies.md`, `.opencode/agents/*.md`.
>
> **2026-10-05 reconciliation (agent1).** This file previously claimed "all
> steps complete / audit passed" while its own footnote recorded 3 BLOCKER and
> 3 MAJOR open findings. Both cannot be true. The blockers are now genuinely
> closed and `changes.md` §3 carries the before/after for each, so this log has
> been rewritten to describe the tree as it actually stands.
>
> **Sources of truth, in order:** the filesystem → `changes.md` → this file.
> `.opencode/agents/agent1.md` §3 still carries the 10-step build plan. The step
> history below is kept for provenance only and is **not** a status table.

---

## Status: build green, all BLOCKERs and MAJORs closed

Gates, re-verified 2026-10-05: `npm run typecheck` clean · `npm run lint` clean
· `npm run build` succeeds and emits `out/` (`output: "export"`). Structural
audit greps clean: no `Promise.all(`, no `await` inside a loop, no `: any`, no
`localStorage`, no `suppressHydrationWarning`.

The 2026-10-04 audit returned **3 BLOCKER + 3 MAJOR + 5 MINOR**. All six
BLOCKER/MAJOR findings are now closed:

| # | Finding | Resolution |
| - | ------- | ---------- |
| BLOCKER 1 | live deploy threw before broadcasting — `decimalsFromPrecision` applied `log10` to *token* decimals, so `log10(6) = 0.778` rejected every real market | split into `decimalsFromPrecision` (powers of ten) and `decimalsFromCount` (already a count) |
| BLOCKER 2 | mark price was **ETH/USDT** from Binance, applied to a MON/USDC grid — every leg became a bid and `calculateGridOrders` threw | `lib/marketFeed.ts` **deleted**; the mark is now read from the on-chain Kuru orderbook via `lib/marketBook.ts` |
| BLOCKER 3 | a simulated batch rendered as `LIVE` (the badge read the toggle, not `BatchResult.dryRun`) | badge reads `batch.dryRun`, plus a distinct violet "simulated (SDK unavailable)" notice |
| MAJOR 1 | required MON inventory disagreed with the broadcast (`666.6` vs `666.6667`) | one `notionalPerLevelSlice()` used by both the preview and the build; verified across 5 configs |
| MAJOR 2 | `TELEMETRY_TIMEOUT_MS` declared but never applied — a hung node froze the latency badge forever | `pingRpcLatency` races the call against the timeout |
| MAJOR 3 | live throughput fell back to an invented `legs x 1000` when the burst rounded to 0 ms | `Math.max(1, ...)` denominator, identical to the dry-run path |

**Still open** — none blocking a demo, all recorded in `bugs.md`:

1. `tickSize` / `minSize` / `maxSize` are fetched from the market contract but
   never applied; a leg off the tick grid or under the minimum reverts
   on-chain. This is the most significant remaining gap.
2. `FILL_WATCH_ABI` is hand-written rather than taken from the SDK, so a
   signature drift would fail silently — fills would simply never be reported.
3. No automated test suite, by architect decision (§6 decision 4). Grid
   arithmetic is verified with throwaway harnesses.
4. Two defects in `lib/wallet/store.ts`, recorded under `bugs.md` O6.

## Build plan steps

The original 8-step plan. All eight were delivered; the column below is
provenance, not current status.

| Step | Deliverable | Status |
| ---- | ----------- | ------ |
| 1 | Dependency pins in `package.json` | Done |
| 2 | `npm install` verified | Done |
| 3 | `app/globals.css` + `app/layout.tsx` | Done |
| 4 | `components/OrderLadder.tsx` | Done |
| 5 | `components/ConfigPanel.tsx` | Done |
| 6 | `app/page.tsx` (composition root) | Done |
| 7 | `README.md` | Done |
| 8 | `typecheck` / `build` + verifier audit | Done — audit re-run 2026-10-05: 0 BLOCKER / 0 MAJOR |


---

## Step 1 — Dependency pins corrected

`package.json` now matches `dependencies.md` exactly:

| Package | Was | Now |
| ------- | --- | --- |
| `next` | `^14.2.15` | `^14.2.35` |
| `ethers` | `5.7.2` | `~5.7.2` (tilde = "5.7.x, never 6") |
| `lucide-react` | `^0.454.0` | `^1.52.0` |
| `@types/canvas-confetti` | `^1.6.4` | `^1.9.0` |

Everything else untouched (`tailwindcss` v3, `typescript` 5.x, `@types/react` 18.x — intentional).

## Step 2 — Install verified

`npm install` → 218 packages audited, clean. Installed versions confirmed:

```
next 14.2.35 · react 18.3.1 · react-dom 18.3.1 · ethers 5.7.2
@kuru-labs/kuru-sdk 0.0.95 · lucide-react 1.52.0 · canvas-confetti 1.9.4
typescript 5.9.3 · tailwindcss 3.4.19 · postcss 8.5.28 · autoprefixer 10.6.1
@types/react 18.3.31 · @types/node 20.19.43 · @types/canvas-confetti 1.9.0
```

Pre-flight checks passed:

- SDK runtime exports confirmed: `ParamFetcher`, `GTC` both present in `@kuru-labs/kuru-sdk@0.0.95`.
- All planned lucide icons exist in v1.52.0: `ExternalLink`, `LayoutGrid`, `Wallet`, `Wallet2`, `Radio`, `Activity`, `Zap`, `Globe`, `Gauge`, `ArrowUpRight`, `ArrowDownRight`, `Layers`, `CircleDot`, `AlertTriangle`, `CheckCircle2`, `XCircle`, `Loader2`, `RefreshCw`, `Info`, `Sparkles`, `Box`, `Terminal`, `Crosshair`, `TrendingUp`.

Note: `npm audit` reports 13 vulnerabilities (8 high / 5 critical) in transitive deps —
typical for the ethers v5 / CJS toolchain; **do not** `npm audit fix --force`
(it would bump majors and break the pinned ethers v5 constraint).

## Step 3 — App shell created

- `app/globals.css` — three `@tailwind` directives, `color-scheme: dark`,
  `html`/`body` base via `@apply bg-zinc-950 text-zinc-200`, `::selection` rule.
  No custom CSS beyond Tailwind.
- `app/layout.tsx` — server component, `Metadata` from `APP_NAME`/`APP_TAGLINE`,
  `className="dark"` on `<html>` (anti-white-flash), renders `children` only,
  no `'use client'`.

---

## Design decisions locked in for Steps 4–6

Recorded so the remaining files are written once, consistently:

1. **Mark price = midpoint of the configured bounds** — `(lower + upper) / 2`,
   derived in `page.tsx`. No live price feed exists in the dependency list,
   and a derived mark is pure + SSR-safe (no hydration mismatch). The ladder
   labels it "mark".
   > ⚠ **REVERSED 2026-10-04 without sign-off.** `lib/marketFeed.ts` was added
   > and `app/page.tsx:89-90` now prefers `ticker.price` over the midpoint. The
   > feed returns **ETH/USDC**, not MON/USDC, so this decision is currently
   > broken — see BLOCKER 2. Either revert to the midpoint or source a real MON
   > mark from the configured Kuru market; `agent1.md` §6.1 must be amended
   > either way, and only `agent1` may amend it.
2. **Preview regeneration** — `useEffect` on `[config, markPrice, validation.valid]`
   seeds `orders` via `calculateGridOrders` (status `READY`); skipped while a
   deploy is in flight (guarded by a `deployingRef`, not the `deploying` state,
   to avoid the effect clobbering in-flight `PLACING` rows).
3. **Confetti fires in the deploy handler's success branch**
   (`result.successCount > 0`), never in an effect — immune to
   `StrictMode` double-invoke by construction.
4. **Telemetry poll** — `setInterval(pingRpcLatency, TELEMETRY_POLL_MS)` with an
   in-flight guard (no overlapping pings) and a cleanup that `clearInterval`s.
   Failures keep the last good sample (`console.warn`, never an empty catch).
5. **Wallet listeners** — `accountsChanged` / `chainChanged` subscribed via
   `window.ethereum.on?` with `removeListener?` cleanup. Chain hex normalised
   with `parseInt(raw, 16)` (no ethers import needed in the component).
6. **Deploy button precedence** — `deploying` (`Broadcasting x/y…`) →
   `!address` (`Connect Wallet First`, disabled) → wrong chain
   (`Switch to Monad Testnet`, actionable) → `!validation.valid` (disabled) →
   default (`Deploy Parallel Grid` / `Deploy Another Grid` after a batch).
7. **Simulation mode** — a `dryRun` checkbox in the config panel. When on,
   the wallet gate is bypassed (the dry-run path never touches the chain), so
   judges can demo instantly without a funded wallet. The telemetry card
   badges the run `SIMULATED`.
8. **Market-address guard** — deploy with `isUnsetMarketAddress(DEFAULT_MARKET_ADDRESS)`
   fails fast with the `.env` remediation *before* any SDK load (live mode only).
9. **Deploy catch path** — any `KuruGridError` resets rows still `PLACING` to
   `FAILED` (no orphaned `Broadcasting` pills) and clears `batch`.

## Architecture (as built)

```
app/layout.tsx          server component — shell + metadata
app/page.tsx            'use client' — composition root, ALL state
  ├── components/ConfigPanel.tsx   presentational (controlled inputs, telemetry, deploy button)
  ├── components/OrderLadder.tsx   presentational (depth ladder, mark divider, status pills)
  ├── lib/gridEngine.ts            PURE arithmetic (imports only ./constants)
  ├── lib/kuruClient.ts            wallet + SDK boundary (dynamic import() only)
  └── lib/marketFeed.ts            live ticker, read-only fetch (⚠ see BLOCKER 2)
lib/constants.ts        single source of truth for types + constants
```

Invariants to hold: SDK imported only in `kuruClient.ts`; `gridEngine.ts` stays
pure; batch is `.map()` → `Promise.allSettled` (never `Promise.all`, never
`await` in a loop).

## Verification gates

```bash
npm run typecheck   # ✅ zero errors
npm run lint        # ✅ no warnings
npm run build       # ✅ static export to out/
```

The gates pass. **The verifier audit did not** — see below. A green build is not
a green audit; these are different questions.

---

## Verifier audit — 2026-10-04 (historical; all BLOCKER/MAJOR closed by 2026-10-05)

Adversarial pass over `lib/`, `app/`, `components/` against `verifier.md` V1–V4.
**3 BLOCKER, 3 MAJOR, 5 MINOR.** The build gates above were green throughout, so
none of these would have been caught without reading the code.

### BLOCKER 1 — live deploy threw before broadcasting (FIXED, W1)

`lib/kuruClient.ts:485-486` passed `quoteAssetDecimals` / `baseAssetDecimals`
through `decimalsFromPrecision`, which computes `Math.log10(n)` and throws unless
the result is an integer. That is correct for `pricePrecision` (10^8 → 8) but not
for token decimals: `log10(6) = 0.778` and `log10(18) = 1.255`. USDC is 6 decimals
and MON is 18, so **every live deploy died** at this line with
`"unreadable quoteAssetDecimals (6)"` — a `MARKET_NOT_FOUND` message blaming the
market address for what was a units bug. Zero orders placed.

Fixed by splitting the helper: `decimalsFromPrecision` (powers of ten, unchanged
behaviour) and a new `decimalsFromCount` (already a count, no logarithm), plus
`safeToNumber` so an out-of-range `BigNumber` becomes a `KuruGridError` instead of
a raw ethers overflow throw. Verified with a scratch harness asserting both
helpers against 1e8/1e6/1e2 precisions, 6/18/0/36 decimals, and the rejection
cases — 14/14 pass.

### BLOCKER 2 — the mark price is ETH, not MON (CLOSED 2026-10-05)

`app/page.tsx:89-90`:

```ts
const markPrice = ticker !== null ? ticker.price : (config.lowerBound + config.upperBound) / 2;
```

`lib/marketFeed.ts:41` fetches Binance `symbol=ETHUSDT` (CoinGecko `ids=ethereum`
as fallback) — so `ticker.price` is the **ETH/USDC** price, on the order of
thousands. The grid is MON/USDC bounded `$0.045–$0.055`. Consequences:

- Every level is far below the mark, so **all 12 legs classify as buys** and the
  bid/ask split the ladder exists to show collapses.
- `calculateGridOrders` throws `GridConfigError("currentPrice", "…outside the
  configured range")`, which the preview effect catches and renders as
  **"Could not build the grid"** in the error banner.
- Broadcast orders would be priced off an ETH reference, which is not the mark
  price of the configured MON/USDC range.

The "otherwise the midpoint" fallback only holds until the first successful poll
(3 s). This also reverses locked decision 1 below and contradicts `agent1.md` §6.1
("There is no live mark feed"). **A real MON price, if wanted, must come from the
configured Kuru market — never from a different asset's ticker.**

### BLOCKER 3 — a simulated batch renders as `LIVE` (CLOSED 2026-10-05)

`components/ConfigPanel.tsx:317` reads the toggle, not the run:

```tsx
value={dryRun ? "SIMULATED" : "LIVE"}
```

`BatchResult.dryRun` exists and is never read. When the SDK fails to import,
`kuruClient` falls back to `runDryRun()` and returns `dryRun: true` while the
toggle is off — so the telemetry card shows `LIVE` beside a fabricated
`durationMs` and throughput. This is precisely the case `agent1.md` §3 flagged:
*"A `console.warn` is not a disclosure."* Badge must read `batch.dryRun`, with a
visible notice when the run was simulated but the toggle was off.

### MAJOR — required MON inventory disagrees with the broadcast (CLOSED)

`lib/gridEngine.ts:116` rounds the notional slice to 2 dp before dividing by the
mark; `lib/gridEngine.ts:266` uses `normalise(totalCapital / gridCount)` unrounded.
Reproduced: `cfg(0.045,0.055,3,100)` preview `666.6` vs actual `666.6667`;
`cfg(0.1,0.9,7,100)` `85.74` vs `85.7142`; `cfg(0.045,0.055,12,1000)` `9999.6` vs
`10000.0002`. The panel tells the operator to fund one number; the chain needs
another. Only 2-dp-friendly configs (the seeded `120`/`12`) agree — which is why
the step-2 gate passed.

### MAJOR — `TELEMETRY_TIMEOUT_MS` is documented but never used (CLOSED)

`lib/constants.ts` declares it as a "hard ceiling … so a hung node cannot wedge
the UI". Nothing reads it; `pingRpcLatency` has no timeout, so the `inFlight`
guard latches and the header latency badge silently freezes on a stale value.

### MAJOR — throughput falls back to an invented number (CLOSED)

`lib/kuruClient.ts:668`: `durationMs > 0 ? … : working.length * 1000` prints
`12000 legs/s` for 12 legs when the burst rounds to 0 ms. `runDryRun` guards this
correctly with `Math.max(1, …)`; the live path does not. V4 requires the reported
figure be derived from the real measurement.

### MINOR

- `lib/kuruClient.ts:668` region — `Math.random()` in the dry-run mock (`:1` grep
  list; `crypto.getRandomValues` was specified).
- `WalletConnection` declared twice with incompatible shapes —
  `lib/constants.ts:351` (`address`, `chainId`) and `lib/kuruClient.ts:132`
  (`provider`, `address`). `app/page.tsx` imports the latter; the former is dead.
- `ensureAllowance` (`lib/kuruClient.ts:360`) reads inverted —
  `if (!allowance.lt(required)) return;` is correct but should be
  `allowance.gte(required)` for legibility.
- `marketParams.minSize` / `maxSize` / `tickSize` are fetched and never used, so a
  leg below `minSize` or off `tickSize` reverts on-chain.
- `ensureAllowance` hand-rolls an ERC-20 ABI while the SDK ships
  `approveToken` / `getAllowance` (`dist/utils/approve.d.ts`). Note `approveToken`
  returns a tx **hash**, not a receipt, so it does not verify `status === 1`.

### Checked and clean

`noUncheckedIndexedAccess` is on and every indexed access is guarded · zero `any`
outside commented SDK/EIP-1193 boundaries · no `Promise.all(` · **no `await` inside
any loop** — the burst is `.map()` then `allSettled` · no top-level `window` /
`document` / `localStorage` · no `suppressHydrationWarning` · `gridEngine.ts` is
genuinely pure (imports only `./constants`, no clock, no randomness, no I/O) ·
`wallet_addEthereumChain` fires only on `4902` · `4001` is never retried ·
`[ { chainId } ]` is never `[undefined]` · chain comparison goes through
`BigNumber.from(...).toNumber()` · `receipt.status === 1` is checked before a leg
is called placed · `onUpdate` always receives a fresh array and never mutates the
caller's.

**Failure path traced end to end:** wrong network + rejected switch prompt →
`KuruGridError('USER_REJECTED')` → rose banner reads "You rejected the network
switch." No row flips, no confetti, throughput stays `—`. Honest.

**Success path traced end to end:** this is where BLOCKER 1 lived — the burst was
unreachable. It is reachable now; BLOCKER 2 still prevents a coherent ladder.

---

## Run script

Created `run.sh` — executable one-liner for install + build + dev:

```bash
./run.sh
```

(Uses slow-network install flags from AGENTS.md §9.)

---

## Audit closure notes — 2026-10-05

The findings above are preserved verbatim as written on 2026-10-04. Each was
closed in a later session; the authoritative before/after is `changes.md` §3.

- **BLOCKER 2** — resolved by *deleting the premise*, not by patching it.
  `lib/marketFeed.ts` was removed outright and the mark is now read from the
  configured Kuru orderbook on-chain (`lib/marketBook.ts`). This also removed an
  external HTTP dependency from the demo, so a CORS-blocked or offline judging
  network can no longer break the mark price.
- **BLOCKER 3** — `ConfigPanel` now prefers `batch.dryRun` over the toggle, and
  renders a distinct violet notice when a run was simulated with the toggle off.
  A `console.warn` is not disclosure.
- **MAJOR (inventory)** — one `notionalPerLevelSlice()` helper now feeds both the
  preview and the build. Verified with a scratch harness over five
  configurations; `cfg(0.045,0.055,3,100)` reads 666.6 in both places now.
- **MAJOR (timeout)** — `Promise.race` against `TELEMETRY_TIMEOUT_MS`.
- **MAJOR (throughput)** — `Math.max(1, ...)` denominator, so the figure is
  always derived from the measurement and never from an invented constant.

Two items from the MINOR list remain genuinely open and are now tracked in
`bugs.md`: `tickSize`/`minSize`/`maxSize` are fetched and never applied, and
`FILL_WATCH_ABI` is hand-written rather than sourced from the SDK.

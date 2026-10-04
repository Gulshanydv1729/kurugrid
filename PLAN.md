# KuruGrid — Implementation Plan (Phase 2)

**Status:** plan only. No code in this document has been written.
**Scope:** the remaining ~40% of KuruGrid. `lib/constants.ts` and `lib/gridEngine.ts` are already complete.
**Companion doc:** `dependencies.md` (dependency manifest + ban list).

---

## Objective

Complete KuruGrid to the point where `npm run build` succeeds and the app deploys
a full arithmetic grid ladder onto the Kuru CLOB on Monad Testnet from a single
click, broadcasting every leg in one parallel burst.

Concretely, four deliverables remain:

1. `lib/kuruClient.ts` — the wallet + SDK boundary.
2. `app/` + `components/` — the terminal UI.
3. `README.md` — the bounty submission doc.
4. Verification — typecheck, build, and a review pass against `verifier.md`.

**Explicitly out of scope** (per `AGENTS.md` §4.1–4.2, `pitch.md`): any backend, any
database, any persistence, any cancel/rebalance logic, mainnet support, and any
wallet-connector library.

---

## Current State

### Files that exist

```
/home/gux/monad
├── AGENTS.md                       ✅ 179 lines — operating contract
├── dependencies.md                 ✅ this phase
├── PLAN.md                         ✅ this file
├── .env.example                    ✅ documents NEXT_PUBLIC_KURU_MARKET_ADDRESS
├── .gitignore                      ✅
├── package.json                    ⚠️  see Risks R1 (version bumps pending)
├── tsconfig.json                   ✅ strict + noUncheckedIndexedAccess
├── next.config.mjs                 ✅ minimal
├── postcss.config.mjs              ✅
├── next-env.d.ts                   ✅
├── tailwind.config.ts              ✅ palette + keyframes defined
├── .opencode/agents/
│   ├── architect.md                ✅
│   ├── web3.md                     ✅
│   ├── frontend.md                 ✅
│   ├── verifier.md                 ✅
│   └── pitch.md                    ✅
├── lib/
│   ├── constants.ts                ✅ 302 lines — complete
│   └── gridEngine.ts               ✅ 390 lines — complete
```

**`app/` and `components/` do not exist yet. `lib/kuruClient.ts` does not exist yet.
`README.md` does not exist yet. `node_modules` is not installed.**

### What `lib/constants.ts` already provides

Every type and constant the remaining work needs is already exported, so
`kuruClient.ts` and the components will import from here and nowhere else:

- `MONAD_TESTNET`, `MONAD_EXPLORER_TX_BASE`, `explorerTxUrl()`, `TELEMETRY_RPC_URL`
- `DEFAULT_MARKET_ADDRESS`, `MARKET_LABEL`, `ZERO_ADDRESS`, `isUnsetMarketAddress()`
- `MAX_GRID_COUNT` (20), `MIN_GRID_COUNT` (2), `PRICE_DECIMALS` (8), `SIZE_DECIMALS` (4)
- `GridOrder`, `GridOrderStatus`, `GridSummary` (in engine)
- `Eip1193Provider`, `Window.ethereum` global augmentation
- `KuruGridError` (with `WalletErrorCode`), `GridConfigError`
- `NetworkCheckResult`, `BatchResult`, `PlaceOrdersOptions`, `OrderUpdateCallback`, `TelemetrySample`
- `ORDER_STATUS_META`, `APP_NAME`, `APP_TAGLINE`

> **Note:** `BatchResult` already carries `durationMs`, `successCount`,
> `failureCount`, `totalCount`, `throughput`, `dryRun`. The spec-required
> `durationMs` + `successCount` are a subset. `kuruClient.ts` must populate all six.

### What `lib/gridEngine.ts` already provides (pure, unit-testable)

- `calculateGridOrders(currentPrice, lowerBound, upperBound, gridCount, totalCapital, options?)`
  — validates, generates an **arithmetic** ladder, assigns sides with
  `isBuy = price < currentPrice` (**strictly** below), sizes legs from an equal
  notional slice, returns **sorted descending by price**. Throws `GridConfigError`.
- `validateGridConfig(lowerBound, upperBound, gridCount, totalCapital, currentPrice?)`
  — per-field errors + `stepPrice` + `notionalPerLevel` + `buyLegs`/`sellLegs` +
  `requiredMonInventory`. Drives live UI validation.
- `generateGridLevels`, `summarizeGrid`, `roundTo`, `formatPrice`, `formatSize`
- `GridEngineOptions`, `GridValidationResult`, `GridSummary`

**Purity is verified by inspection:** the only import is `./constants`. No
`window`, no `Date`, no `Math.random`, no I/O.

---

## Proposed Architecture

### The layering (already fixed by `architect.md` §A1)

```
app/page.tsx                 'use client'  ── owns wallet + grid + ladder state
  ├── components/ConfigPanel.tsx      presentational, controlled inputs
  ├── components/OrderLadder.tsx      presentational, depth ladder
  ├── lib/gridEngine.ts               PURE arithmetic
  └── lib/kuruClient.ts               wallet + SDK boundary
        └── @kuru-labs/kuru-sdk       dynamic import() only
```

Two invariants the verifier will check:

- **The SDK is imported in exactly one file.** A component importing
  `@kuru-labs/kuru-sdk` is a layering *and* bundle-size violation.
- **`lib/gridEngine.ts` stays pure.** It is done and must not grow an import.

### State ownership in `app/page.tsx`

`page.tsx` is the composition root and the only stateful module. It holds:

| State | Type | Updated by |
| --- | --- | --- |
| `address` | `string \| null` | connect / disconnect / `accountsChanged` |
| `chainId` | `number \| null` | `checkAndSwitchNetwork()`, `chainChanged` |
| `config` | `{ lower, upper, count, capital }` | inputs |
| `orders` | `GridOrder[]` | `calculateGridOrders` (reset) → `onUpdate` (live) |
| `batch` | `BatchResult \| null` | deploy completion |
| `deploying` | `boolean` | deploy handler |
| `telemetry` | `TelemetrySample \| null` | RPC poll effect |
| `error` | `string \| null` | any `KuruGridError` |

Derived, via `useMemo`: `validation = validateGridConfig(...)`,
`summary = summarizeGrid(orders)`. Never recompute in render.

`app/page.tsx` contains **no** grid math and **no** wallet code — it calls the two
library functions and renders results.

### How the preview stays honest

`orders` is seeded by `calculateGridOrders` (status `READY`) the moment config
changes, so the ladder is populated and clickable *before* any wallet is
connected. The moment a deploy starts, each row is written back with its real
`status`/`txHash`/`error`. The preview and the broadcast come from the same
`GridOrder[]` shape, so what the judge previews is what gets sent.

---

## Implementation Steps

Each step depends on the ones above it. Do not reorder.

### Step 1 — Correct the dependency pins

**File:** `package.json`
**Why first:** everything after it must typecheck against these versions.

- `next`: `^14.2.15` → `^14.2.35` (14.2.15 predates published 14.x security patches)
- `lucide-react`: `^0.454.0` → `^1.52.0` (caret on `0.x` strands us pre-1.0)
- `ethers`: `5.7.2` → `~5.7.2` (tilde = "5.7.x, never 6"; see `dependencies.md` §4)

Leave everything else. Do not touch `tailwindcss` (v3 is intentional) and do not
upgrade `typescript` or `@types/react` (both would break the React 18 pairing).

### Step 2 — `lib/kuruClient.ts`

**Owner:** `web3`. **Depends on:** Step 1, and existing `lib/constants.ts`.
**This is the highest-risk file in the project and the one that carries the bounty claim.**

Verified against the real published SDK — I extracted `@kuru-labs/kuru-sdk@0.0.95`
from npm and read its `.d.ts` and compiled `dist/`. Facts that must be honoured:

| Fact | Consequence in our code |
| --- | --- |
| `GTC.placeLimit(signerOrProvider, marketAddress, marketParams, order: LIMIT)` → `ContractReceipt` | — |
| `LIMIT.price` and `LIMIT.size` are **strings**; the SDK does `clipToDecimals(order.price, …)` → `String.split('.')` | Pass **`price.toFixed(PRICE_DECIMALS)`**. Passing a number throws `value.split is not a function`. The SDK's own README examples pass numbers — **the README is stale, the types are right.** |
| Decimals come from `log10BigNumber(marketParams.pricePrecision)` | Derive via a guarded helper; reject `precision <= 1` rather than letting the SDK throw `Log10 of zero is undefined`. |
| `placeLimit` does **not** call ERC-20 `approveToken` | We must approve USDC (buys) and MON (sells) ourselves, or every leg reverts. |
| `placeLimit` internally does `transaction.wait(1)` | Duration measurement must tolerate a long confirmation tail. |
| `addBuyOrder`/`addSellOrder` resolve on a mined receipt even when reverted | Count success **only** when `receipt.status === 1`. |
| SDK is **CommonJS**, `main: dist/index.js`, no `module` field | Must be a dynamic `import()`. |

Exports:

```ts
// 1. Wallet plumbing
export function getInjectedProvider(): Eip1193Provider | null   // typeof window guard
export async function getChainId(): Promise<number>
export async function checkAndSwitchNetwork(): Promise<NetworkCheckResult>

// 2. Market access
export async function loadMarketParams(marketAddress: string): Promise<MarketParamsLike>
export function resolveMarketAddress(): string                 // env -> default, guarded

// 3. Preconditions
export async function ensureApprovals(signer, marketAddress, orders): Promise<void>

// 4. The batch
export async function placeParallelKuruOrders(
  provider, marketAddress, orders, onUpdate, options?
): Promise<BatchResult>
```

`checkAndSwitchNetwork()` algorithm (from `web3.md`):

1. `typeof window === "undefined"` → `KuruGridError("NO_WALLET")`
2. `window.ethereum` absent → `KuruGridError("NO_WALLET")`
3. read `eth_chainId`; normalise via `BigNumber.from(x).toNumber()` (case-insensitive —
   `0x279F` and `0x279f` are both legal)
4. equal → `{ ok: true, chainId, switched: false }`
5. `wallet_switchEthereumChain` with params `[{ chainId: "0x279f" }]`
   — **never `[undefined]`**, which is a `TypeError` inside the wallet
6. catch `4902` (chain not added) → `wallet_addEthereumChain({ chainId, chainName,
   nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls, blockExplorerUrls })`
   — `4902` is the **only** trigger for add
7. any other error → rethrow. `4001` → `KuruGridError("USER_REJECTED", "You rejected
   the network switch in your wallet.")`. **Never auto-retry a 4001.**

`placeParallelKuruOrders()` algorithm:

```
0. dryRun, or zero address -> simulated path (see below)
1. resolve signer; load marketParams          (1 tx-less eth_call)
   -> MARKET_NOT_FOUND if unset or getMarketParams throws  (HARD FAIL, never mock)
2. ensureApprovals(signer, marketAddress, orders)  <- awaited BEFORE the burst
   (approvals share a nonce; parallelising them races)
3. t0 = performance.now()
4. const settled = await Promise.allSettled(
     orders.map(async (o) => {
       onUpdate(patch(o.id, { status: "PLACING" }));
       return GTC.placeLimit(signer, marketAddress, params, {
         price: o.price.toFixed(PRICE_DECIMALS),
         size:  o.size.toFixed(SIZE_DECIMALS),
         isBuy: o.isBuy,
         postOnly: options.postOnly ?? true,
       });
     })
   )
5. durationMs = Math.round(performance.now() - t0)
6. walk `settled`; status === 1 -> CONFIRMED + txHash ; else FAILED + message
7. return { durationMs, successCount, failureCount, totalCount,
            throughput: totalCount / (durationMs/1000), dryRun }
```

The load-bearing detail is **`.map()` before the `allSettled`** — the array is
built synchronously so every leg starts in the same tick. Building it lazily
serialises it. `Promise.all` is banned: one rejection would abort the batch and
orphan the rest (`AGENTS.md` §4.3).

**Mock fallback — permitted only when** `options.dryRun === true`, **or** the SDK
module failed to `import()`, **or** the user explicitly opted into offline mode.
It resolves after a small randomised delay, emits a syntactically valid
non-existent tx hash, and sets `dryRun: true` so the UI badges the run `SIMULATED`.

**Mock fallback — forbidden when** the user rejected a signature (4001), when
`getMarketParams` failed, or when an individual leg reverted. A mock that hides a
real failure is worse than no mock, because it makes a broken demo look like a
working one in front of judges (`AGENTS.md` §7.4, `web3.md`, `pitch.md`).

### Step 3 — `app/globals.css` + `app/layout.tsx`

**Owner:** `frontend`. Depends on Step 1.

- `globals.css`: three `@tailwind` directives, `color-scheme: dark`,
  `body { @apply bg-zinc-950 text-zinc-200 }`, and a `::selection` rule.
  No custom CSS beyond Tailwind directives — the palette is tokens, not stylesheets.
- `layout.tsx`: server component. Metadata from `APP_NAME`/`APP_TAGLINE`, a
  `<title>`, and a dark `className` on `<html>` to prevent a white flash before
  hydration. Imports `./globals.css`. Renders `children` only — **no client
  directive here.**

### Step 4 — `components/OrderLadder.tsx`

**Owner:** `frontend`. Depends on Step 3. Pure presentational — props only, no wallet
code, no SDK.

Props: `{ orders: readonly GridOrder[]; summary: GridSummary; markPrice: number;
isDeploying: boolean }`.

Per `frontend.md`: descending rows (already guaranteed by the engine — **do not
re-sort here**), `font-mono tabular-nums` on every number, side-coloured price
(`text-emerald-400` bid / `text-rose-400` ask), `BID`/`ASK` badge, status pill
driven by `ORDER_STATUS_META` (so the mapping lives in `constants.ts`, not in JSX),
a depth bar scaled to `max(notional)` via `bg-emerald-500/5` / `bg-rose-500/5` with
`pointer-events-none`, and a dashed mark-price divider at the best bid/best ask
boundary.

Explorer link (`lucide-react` `ExternalLink`) renders **only** when `txHash` is
non-null: `href={explorerTxUrl(txHash)}`, `target="_blank"`,
`rel="noopener noreferrer"`. No link for a failed leg — a dead `#` is worse than
none; put the raw `error` in a `title` tooltip and render it as truncated
`text-[11px] text-rose-400/80`.

Empty state: `lucide-react` `LayoutGrid` in `zinc-800` + "No grid deployed" +
"Configure bounds and capital on the left, then broadcast the ladder in one
parallel burst."

### Step 5 — `components/ConfigPanel.tsx`

**Owner:** `frontend`. Depends on Step 3.

Controlled inputs writing into `page.tsx` state via a `config` +
`onConfigChange` prop pair.

- Lower Bound / Upper Bound / Capital: number inputs, `step="0.0001"`, `min="0"`
- Grid Count: `<input type="range">`, `min={MIN_GRID_COUNT}`, `max={MAX_GRID_COUNT}`,
  integer readout in `font-mono`, and the derived step price beneath
  (`validateGridConfig(...).stepPrice`)
- Inline `rose` messages from `validation.errors[field]`, keyed by the
  `GridConfigError["field"]` union
- **Required MON inventory** surfaced from `validation.requiredMonInventory` — the
  sell legs need base inventory up front, and hiding that guarantees a failed demo
- Deploy button state machine (5 states) per `frontend.md`
- Telemetry card: `latency`, `legs` (`successCount/total`), `throughput` (legs/sec —
  the number that makes Monad's parallelism land), `mode` (`LIVE` / `SIMULATED`)

### Step 6 — `app/page.tsx`

**Owner:** `frontend`. Depends on Steps 2, 4, 5. The composition root.

- `'use client'` at the top — it owns wallet state.
- `useState` for the state table in *Proposed Architecture*; `useMemo` for
  `validation` and `summary`.
- Connect handler: `getInjectedProvider()` → `eth_requestAccounts` → `checkAndSwitchNetwork()`
  → `setAddress`. Every `4001` becomes a `rose` inline message, never a crash.
- Deploy handler: guard wallet + chain + `validation.valid` →
  `setOrders(calculateGridOrders(...))` → `placeParallelKuruOrders(...)` →
  `setBatch(result)`. **Guarded `catch`** that sets `error` from `KuruGridError`
  and resets any row still in `PLACING` to `FAILED` — no orphaned
  `Broadcasting` pill.
- Confetti, fired **once**, only when `result.successCount > 0`, keyed on a
  monotonically increasing `batchId` so `React.StrictMode`'s dev double-invoke
  cannot fire it twice:
  ```ts
  confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 },
             colors: ["#8b5cf6", "#10b981", "#f43f5e"] });
  ```
- Telemetry effect: `setInterval` measuring `performance.now()` around
  `provider.getBlockNumber()` on `TELEMETRY_RPC_URL`. **Must return a cleanup
  function that `clearInterval`s** — a leaked interval burns RPC quota mid-demo.
- Subscribe to `accountsChanged` / `chainChanged`, and **remove the listeners on
  cleanup**.
- Layout: sticky header (`APP_NAME`, `• Monad Testnet 10143` badge, Connect button
  with shortened address), then `lg:grid-cols-[380px_1fr]`, stacked on mobile.

### Step 7 — `README.md`

**Owner:** `pitch`. Depends on all of the above, because it must describe what
actually got built.

Sections per `pitch.md`: positioning → **Why Monad?** (the before/after
arithmetic: ~12 sequential block times ≈ 24s on a sequential EVM vs. one parallel
burst on Monad) → What it does → Quick start (including the mandatory
`NEXT_PUBLIC_KURU_MARKET_ADDRESS` step) → Architecture (ASCII diagram + the
`Promise.allSettled` snippet + why `allSettled` and not `all`) → Telemetry →
**Known limitations** (testnet-only, no persistence, no cancel/rebalance, funding
preconditions, deployment-specific market address) → Bounty ($5,000 Kuru track,
Metropolis Hackathon) → License.

**Every latency/throughput figure must be a measured value or be omitted.** Never
invent a number (`pitch.md`). If no live reading is available at write time, the
README describes how to read the metric rather than asserting a value.

### Step 8 — Verification

**Owner:** `verifier`. Depends on everything.

```bash
npm install
npm run typecheck    # zero errors — non-negotiable
npm run lint
npm run build
```

Then the audit described in `.opencode/agents/verifier.md`:
- **V1 types** — `noUncheckedIndexedAccess` respected; `any` only at EIP-1193/SDK
  boundaries with a comment; no laundering `as` casts.
- **V2 SSR** — grep `window.`, `document.`, `localStorage`, `performance`,
  `Math.random`, `Date.now`. All inside effects/handlers. No globals at module
  scope in `kuruClient.ts`. No hydration mismatch from render-time randomness.
- **V3 wallet errors** — `4001` handled at all six call sites, never retried;
  `4902` is the only `wallet_addEthereumChain` trigger; no bare `.then()` without
  `.catch()`; mock cannot mask a real failure.
- **V4 parallelism** — no `await` inside a `for`; `.map()` before `allSettled`;
  displayed throughput derived from the real `durationMs`.
- **Purity** — `lib/gridEngine.ts` imports only `./constants`.

---

## Testing

There is **no test framework installed** and adding one is not justified for a
hackathon build (`pitch.md`, `architect.md` §A3). The gates are `typecheck`,
`lint`, and `build`, plus manual verification:

### Manual test matrix — grid engine (deterministic, easy to check by hand)

| # | Input | Expected |
| --- | --- | --- |
| 1 | mark 5.00, 0.04–0.06, 10 legs, 100 USDC | 10 levels, step exactly 0.002, sum of notionals = 100 |
| 2 | same | **Descending order**; index 0 is the highest sell |
| 3 | same | Every level with `price < 5` is `isBuy: true`; every level `>= 5` is `isBuy: false` |
| 4 | mark exactly on a level | That level is **`isBuy: false`** (strictly-below rule) |
| 5 | mark 0.01 with range 0.04–0.06 | **Throws** `GridConfigError` — mark outside range |
| 6 | `upper === lower` | Throws `GridConfigError` on `upperBound` |
| 7 | `gridCount = 1` / `0` / `21` / `4.5` | Throws `GridConfigError` on `gridCount` |
| 8 | `capital = 0`, `lower = 0` | Throws on the right field |
| 9 | range 0.1–0.3, 10 legs | No level prints `0.30000000000000004` (the float guard) |
| 10 | marks 4.99 / 5.00 / 5.01 | Only the mark changes; level prices must not |

### Manual test matrix — wallet + batch

| # | Scenario | Expected |
| --- | --- | --- |
| 11 | No MetaMask | "Install MetaMask" message. No crash. |
| 12 | Wallet on mainnet | Prompts switch to Monad Testnet (10143). |
| 13 | **User rejects the switch (4001)** | Friendly "You rejected…" message. **No auto-retry.** No confetti. |
| 14 | Chain not added (4902) | `wallet_addEthereumChain` fires with full `nativeCurrency`/`rpcUrls`/`blockExplorerUrls`. |
| 15 | `NEXT_PUBLIC_KURU_MARKET_ADDRESS` unset | Fails fast with the `.env` remediation. **Zero broadcasts.** |
| 16 | Wrong market address | `getMarketParams` throws → `MARKET_NOT_FOUND`. **Never falls through to the mock.** |
| 17 | Deploy 12 legs | All 12 rows leave `Preview` in the same tick; throughput > 1 leg/sec. |
| 18 | Reject **one** signature mid-batch | That row → `FAILED`; the other 11 stay `PLACING`→`CONFIRMED`. Batch still resolves. |
| 19 | Insufficient MON for sell legs | Sell rows fail on-chain with the revert reason visible; buys unaffected. |
| 20 | `dryRun` | All rows → `Placed`, `mode` badge reads `SIMULATED`, confetti fires once. |
| 21 | RPC ping effect over 60s | Latency updates; `setInterval` cleared on unmount (no runaway requests). |
| 22 | Refresh mid-deploy | Rows reset to `READY`. No stuck `Broadcasting` pills. |

---

## Risks

| ID | Risk | Sev | Mitigation |
| --- | --- | --- | --- |
| **R1** | `package.json` pins are unverified-by-build; `next@^14.2.15` and `lucide-react@^0.454.0` are stale | Med | Step 1 corrects both. `dependencies.md` §3 records the reasoning. |
| **R2** | **`DEFAULT_MARKET_ADDRESS` is not resolvable.** I searched the npm registry, the Kuru SDK tarball (`src/`, `examples/`, `dist/`), `api.kuru.io`, and the docs site — `docs.kuru.trade` does not resolve and the API endpoints 404. Kuru has **no canonical registry**. | **High** | Zero-address sentinel + `isUnsetMarketAddress()` already ship in `constants.ts`. `kuruClient.ts` fails fast with the `.env` remediation. Must be called out in `.env.example` and README. **The operator must supply it.** |
| **R3** | SDK README passes `price`/`size` as **numbers**; the SDK does `String.split('.')` | **High** | Verified from `dist/market/gtc.js`. Pass `.toFixed(PRICE_DECIMALS)` strings. Documented in `web3.md`. |
| **R4** | `placeLimit` does not handle ERC-20 approval → silent reverts | **High** | `ensureApprovals()` awaited **before** the burst. Buys→USDC, sells→MON. |
| **R5** | A mined-but-reverted receipt resolves successfully → false emerald | **High** | Count success only on `receipt.status === 1`. |
| **R6** | SDK is CJS + pulls `axios`/`cross-fetch`; inflates client bundle | Low | Dynamic `import()` inside `kuruClient.ts`. |
| **R7** | MetaMask signature queue becomes unusable past ~20 legs | Med | `MAX_GRID_COUNT = 20` is a **wallet** limit, documented as such. Loom script uses 10–14. |
| **R8** | MetaMask **nonce collisions** under a true simultaneous burst | Med | Real and not fully controllable client-side. Mitigate by surfacing per-leg errors honestly. Consider auto-incrementing `txOptions.nonce` in `ensureApprovals`. **Must be tested live.** |
| **R9** | Float drift renders `0.30000000000000004` in the ladder | Low | `roundTo` with `Number.EPSILON` + `normalise` via `toPrecision(15)`. Test #9. |
| **R10** | `window.ethereum` at module scope breaks the SSR pass | Med | `getInjectedProvider()` with `typeof window === "undefined"` guard. Grep in Step 8. |
| **R11** | React `StrictMode` double-invokes effects → double confetti | Low | Key the confetti effect on `batchId`, not a boolean. |
| **R12** | `log10BigNumber` throws on `pricePrecision = 1` | Med | Guarded decimals helper; clear error. (`dependencies.md` §6.) |
| **R13** | Render-time `Date.now()`/`Math.random()` → hydration mismatch | Low | No time/random in render. Confetti only. |
| **R14** | README overclaims a latency figure | **High** | `pitch.md` honesty checklist. Omit unmeasured numbers. |
| **R15** | `lucide-react` v1 dropped an icon name I plan to use | Low | Substitute a different icon. **Never** `@ts-ignore`. |

---

## Files To Change

**Modify (1)**

| File | Change |
| --- | --- |
| `package.json` | Three version corrections (Step 1). |

**Create (7)**

| File | Owner | Purpose |
| --- | --- | --- |
| `lib/kuruClient.ts` | web3 | Wallet, market params, approvals, parallel batch, mock fallback. |
| `app/globals.css` | frontend | Tailwind directives + dark base. |
| `app/layout.tsx` | frontend | Root layout, metadata, `class="dark"`. |
| `app/page.tsx` | frontend | Client composition root + all state. |
| `components/OrderLadder.tsx` | frontend | Depth ladder. |
| `components/ConfigPanel.tsx` | frontend | Config form + telemetry + deploy button. |
| `README.md` | pitch | Bounty submission doc. |

**Create at verification time (1, git-ignored)**

`node_modules/`, `.next/`, `tsconfig.tsbuildinfo`.

**Not to be created:** any API route, server action, ORM, DB client, or test
framework.

---

## Execution Order

| # | Step | Blocks | Risk if done wrong |
| --- | --- | --- | --- |
| 1 | Correct dependency pins | 2–8 | Types resolve against the wrong majors |
| 2 | **`lib/kuruClient.ts`** | 6 | *The bounty claim lives here.* Sequential, mocked, or allowance-less = broken demo |
| 3 | `globals.css` + `layout.tsx` | 4–6 | Styling and metadata |
| 4 | `OrderLadder.tsx` | 6 | No visual proof of the claim |
| 5 | `ConfigPanel.tsx` | 6 | No input, no grid |
| 6 | **`app/page.tsx`** | 7, 8 | Nothing composes together |
| 7 | `README.md` | 8 | Submission judged on prose |
| 8 | Install + typecheck + lint + build + verifier audit | — | Ships broken |

**Critical path: 1 → 2 → 6 → 8.** Steps 3–5 are independent of each other and can
be done in any order once Step 3 lands.

**Suggested sequencing rationale:** Step 2 is the long pole and the only step with
external unknowns (R2–R5, R8). Do it first, in isolation, where it can be tested
against a real wallet before any UI is layered on top. Building the UI first means
a UI that has to be rewritten once the batch semantics settle.

---

## Open Questions

Answers needed before or during Step 2. Flagged rather than assumed:

1. **Which Kuru MON/USDC orderbook address on Monad Testnet?** (R2) Blocks any
   real on-chain run. Dry-run works without it.
2. **Does the operator's wallet hold both USDC and MON?** Sell legs need base
   inventory up front. If only USDC, the demo must be buy-only or the sell legs
   must be funded from a faucet.
3. **Is 10–14 legs the right demo size?** (R7, R8) `MAX_GRID_COUNT = 20` is the
   ceiling; the Loom script targets 12. Confirm before recording.
4. **Pre-approved or auto-approve?** Auto-approve in-app costs one extra signature
   but removes a demo failure mode. Recommendation: auto-approve.

---

*Plan ends. No code from Steps 1–8 has been written.*

# KuruGrid — Changes & Function Reference

> **Snapshot: 2026-10-05 20:25.** Describes the working tree at that moment.
>
> ⚠️ A second agent session was **still editing `lib/kuruClient.ts` as this file
> was written** (mtime 20:23, adding the `-32603` locked-wallet branch). Treat
> §4 as the authoritative source and this document as the map; where they
> disagree, `lib/` wins.

---

## 1. What the app is

A single-page, client-only terminal that deploys an arithmetic grid ladder onto
the **Kuru CLOB** on **Monad Testnet** in one parallel burst. Zero backend,
zero database. The product claim is that a dozen limit orders go live in one
gesture, and the telemetry card measures it.

---

## 2. File map

| File | Owner | Lines | Role |
| --- | --- | --- | --- |
| `lib/constants.ts` | architect | 523 | Single source of truth. Network, market, limits, types, error classes. Imports nothing. |
| `lib/gridEngine.ts` | web3 | 495 | **Pure** grid arithmetic. Imports only `./constants`. |
| `lib/kuruClient.ts` | web3 | 1021 | Wallet (EIP-1193) + Kuru SDK boundary. The only file importing `ethers`. |
| `lib/marketBook.ts` | web3 | 112 | Reads the real Kuru L2 orderbook → mark price. |
| `lib/liveChannel.ts` | web3 | 104 | Optional WebSocket `newHeads` feed. |
| `lib/wallet/types.ts` | web3 | 22 | Wallet type surface. No React, no runtime deps. **New.** |
| `lib/wallet/store.ts` | web3 | 143 | Observable store. No React, no module-scope `window`. **New.** |
| `lib/wallet/useWallet.ts` | web3 | 22 | The only React binding. **New.** |
| `lib/wallet/index.ts` | web3 | 17 | The only public entry point. **New.** |
| `app/layout.tsx` | frontend | 30 | Server component: shell + metadata. |
| `app/globals.css` | frontend | 23 | Tailwind directives, dark canvas, tabular numerals. |
| `app/page.tsx` | frontend | 800 | Composition root. Owns grid + order state. |
| `components/ConfigPanel.tsx` | frontend | 526 | Config inputs, telemetry card, deploy button. |
| `components/OrderLadder.tsx` | frontend | 217 | Depth ladder with mark divider. |
| `components/ExecutionTimeline.tsx` | frontend | 53 | Per-leg lifecycle list. |
| `components/ActivityFeed.tsx` | frontend | 53 | Rolling event log. |
| `components/Landing.tsx` | frontend | 160 | Hero (thesis + 3 CTAs), 3 pillars, 4-step how-it-works, trust strip. Presentational only. |
| `components/ConnectButton.tsx` | frontend | — | Connect button; consumes `useWallet()` directly. **New.** |

Deleted: `lib/marketFeed.ts` (106 lines) — see §3.1.

---

## 3. Change log

### 3.0 MAJOR — the LIVE path moved from Monad Testnet to Monad **Mainnet**

Implemented `PLAN-mainnet-migration.md`. **The live path now broadcasts real
orders against the real Kuru MON/USDC orderbook on chain 143.** Simulation mode,
the UI, and the zero-backend architecture are unchanged.

**The bug this actually fixed.** `lib/constants.ts` pinned chain 10143 while
`.env.local` had been pointed at a mainnet QuickNode URL for some time. So the
provider was talking to mainnet through an app that believed it was on testnet:
the `getTelemetryProvider` network argument was 10143, the wallet-switch target
was `0x279f`, and every explorer link resolved to `testnet.monadexplorer.com`.
Reads went to one chain while the UI asserted another. That is not a cosmetic
mismatch — it is the class of bug where nothing ever looks broken and every
on-chain assertion can silently disagree with reality.

**Verified on-chain before committing the change** (read-only, no signatures):

| Check | Result |
| --- | --- |
| `eth_chainId` on both RPCs | `0x8f` (143) |
| `eth_getCode` on `0x065C9d28…C394` | 141 bytes — a deployed orderbook |
| `getMarketParams` | base native MON (18dp), quote `0x754704…f603` (6dp) |
| `getL2OrderBook` | two-sided, ~25 levels a side, mid ≈ $0.0308 |
| `decimals()` on the quote token | `USDC`, 6dp — the address is the real token |
| `estimateGas` on a legal leg | `Insufficient Balance` (size check passed) |
| `estimateGas` on a 193 MON leg | **`Size Error`** |
| `estimateGas` on a 200 MON leg | `Insufficient Balance` — boundary is inclusive |

That last row matters: it is the difference between a ladder that reverts on
every leg and one that works, decided by one comparison. It is also the proof
that the pre-deploy gate below is calibrated against the contract rather than
against an assumption.

**What the real market turned out to be.** `minSize` is **200 MON**,
`sizePrecision` is **1e10**, `tickSize` is **$0.000001**, and both fee fields
are 0. The 1e10 size precision matters because the app's own `SIZE_DECIMALS` is
4 — every constraint is derived on-chain, never assumed, but it is worth
recording that four plausible-looking constants were all wrong.

#### 3.0.1 Two networks, one selection point

`MONAD_MAINNET` added; `ACTIVE_NETWORK` selects it. `MONAD_TESTNET` is retained
but no longer reachable from the UI, so a faucet path survives for debugging
without any risk of a testnet orderbook being broadcast on mainnet. Every
consumer — `kuruClient`, `marketBook`, `page`, `ConfigPanel`, the explorer base,
the `CHAIN_NOT_ADDED` copy — reads `ACTIVE_NETWORK` rather than a literal.

Two RPCs, both probed: `https://rpc.monad.xyz` and
`https://rpc-mainnet.monadinfra.com`. The plan proposed `monad-mainnet.drpc.org`
as the fallback; it returns `code 35 — chain is not available on free plan`, so
it was not committed. One working fallback beats two plausible ones.

#### 3.0.2 `MaxUint256` → exact-amount approval *(the real-money fix)*

`ensureAllowance` approved `MaxUint256`, with a comment justifying it as a
testnet convenience and an explicit warning not to copy it to mainnet. On
mainnet that warning is the requirement, so the code changed:

```ts
const tx = await token.approve(spender, required);   // was MaxUint256
```

An unlimited approval is a standing permission for the orderbook to move any
amount of the operator's USDC or MON, for as long as the contract lives,
persisting across sessions with no UI ever showing it. `required` is computed
from the same orders that are about to be signed, so the allowance cannot exceed
what the batch can consume. The cost is one extra signature when a second,
larger grid is deployed. That is the correct trade with real funds.

#### 3.0.3 Pre-deploy conformance check

`placeParallelKuruOrders` already snapped prices to the tick grid and marked
out-of-bounds legs `FAILED` inside the burst. That is honest but it is
discovered *after* the operator has paid for twenty signatures. Added the
predictive half:

- `fetchMarketConstraints()` in `kuruClient.ts` — reads tick/min/max/precisions
  on-chain. One `eth_call` batch, cached for the session (these are deployment
  parameters, so polling them on a timer would spend RPC calls to re-derive a
  constant).
- `checkGridAgainstMarket()` in `gridEngine.ts` — pure, integer comparisons in
  raw precision units.
- `minimumCapitalForMarket()` — tells the operator *how much* to add, not just
  that something is wrong.
- `ConfigPanel` renders an amber notice above the deploy button with the first
  reason, the affected count, and the capital floor; the deploy button is
  disabled on a fatal violation. Simulation is exempt — a mock book imposes no
  constraints, and the no-wallet demo must not die for an unrelated reason.

**Deviation from the plan, deliberate.** The plan said "block live deploy when
violations exist". Implemented as: block when a violation is **fatal**, disclose
when it is not. The rationale is in 3.0.4.

#### 3.0.4 A tick snap is not a violation *(caught by the harness)*

The first version of the gate folded both failure modes into one list, and the
scratch harness immediately showed the app's own default config blocked: **8 of
12 legs "rejected"**, every one of them over the tick grid.

The market's tick is $0.000001 (6 dp). `PRICE_DECIMALS` is 8, so an evenly
spaced ladder lands off-tick on most levels *by construction* — and the
broadcast path already snaps them, deterministically, by at most half a tick.
Blocking there would have refused to deploy a grid the chain would have
happily accepted, over a **$3.3e-8** difference per leg.

So the type now carries `fatal`:

| Finding | `fatal` | Behaviour |
| --- | --- | --- |
| size below `minSize` | yes | block live deploy, name the leg |
| size above `maxSize` | yes | block live deploy, name the leg |
| price off the tick grid | **no** | count in `snaps`, disclose in a neutral note |

`conformance.ok` is `violations.every(v => !v.fatal)`. The panel counts only
fatal findings, so it never says "8 orders rejected" when the chain would have
accepted 11 and nudged 7 prices. This is also why the plan's blanket "block"
was narrowed: the broadcast path already handles a *partially* conforming
ladder leg by leg, and refusing 17 good legs because 3 are undersized would be a
regression in capability, not a safety win.

#### 3.0.5 Seed config retargeted

`DEFAULT_GRID_CONFIG` was `0.045–0.055`, a testnet band. On mainnet the mark is
~$0.031, so that range sits entirely *above* it: `markInRange` would be `false`
from the first render and the operator opens the app to a one-sided all-ask
ladder plus a warning banner. Now `0.0286–0.0336` (±8% around the real mark, and
wider than `SYNC_BAND_PCT`'s ±4% so the seed survives a few days of drift). At
$120 / 12 levels the slice is $10 ≈ 322 MON a leg, comfortably over the 200 MON
minimum.

#### 3.0.6 Copy and docs

`layout.tsx`, `package.json`, `README.md`, `.env.example`, `.env.local`, and
`AGENTS.md` §1/§3/§5/§7 all repointed. `AGENTS.md` §3 gains a **§3.1 Mainnet
rules** subsection covering the four constraints that did not exist under
testnet — no `MaxUint256`, constraints read not assumed, conformance checked
before the signature, tick snaps non-fatal. §5's file map was also missing
`tradeFeed.ts`, `useBackgroundPoll.ts`, `PriceSparkline.tsx` and
`StaleBadge.tsx`; added.

The QuickNode key stays in the git-ignored `.env.local` and appears in no
tracked file — verified with `git grep`.

#### 3.0.7 Deviation worth recording: the plan's `drpc.org` fallback

§9 of the plan asked for open question 1 to be resolved by probing. Probing
answered it in the negative, and the plan's value was replaced rather than
committed. See 3.0.1.

---

### 3.1 BLOCKER — the mark price was ETH, not MON *(fixed)*

**Was:** `lib/marketFeed.ts` polled Binance `symbol=ETHUSDT` (CoinGecko
`ids=ethereum` fallback) and `app/page.tsx` used `ticker.price` as the mark.

**Why it broke everything:** the grid trades MON/USDC bounded `$0.045–$0.055`.
An ETH price is on the order of thousands, so *every* level fell below the mark,
all 12 legs classified as buys, the bid/ask split the ladder exists to show
collapsed, and `calculateGridOrders` threw
`"Reference price is outside the configured range"` — rendering as
**"Could not build the grid"**.

**Now:** the mark is the **midpoint of the real Kuru L2 orderbook** for the
configured market, read via `OrderBook.getL2OrderBook` in the new
`lib/marketBook.ts`. This is the price of the exact contract the grid broadcasts
to. It also removes an external HTTP dependency (Binance/CoinGecko) from the
demo entirely, which kills the CORS/offline flake risk during judging.

`lib/marketFeed.ts` deleted. `page.tsx` now:

```ts
const markPrice = book !== null ? book.mid : (config.lowerBound + config.upperBound) / 2;
```

One expression, so the preview and the broadcast cannot diverge.

### 3.2 MAJOR — the preview lied about how much to fund *(fixed)*

**Was:** `validateGridConfig` rounded the notional slice to 2 dp;
`calculateGridOrders` used `normalise(totalCapital / gridCount)` unrounded.
Reproduced: `cfg(0.045,0.055,3,100)` previewed **666.6** while the chain needed
**666.6667**. The panel told the operator to fund one number and the orders
asked for another.

**Now:** one exported helper, `notionalPerLevelSlice()`, used by both.

| config | preview | broadcast |
| --- | --- | --- |
| `cfg(0.045,0.055,3,100)` | 666.6 | 666.6 *(was 666.6667)* |
| `cfg(0.1,0.9,7,100)` | 85.74 | 85.74 *(was 85.7142)* |
| `cfg(0.045,0.055,12,1000)` | 9999.6 | 9999.6 *(was 10000.0002)* |
| `cfg(0.045,0.055,12,120)` | 1200 | 1200 |
| `cfg(0.05,0.06,20,50)` | 454.545 | 454.545 |

### 3.3 Out-of-range mark is no longer an error *(fixed)*

`calculateGridOrders` threw when the mark fell outside `[lower, upper]`. With a
*real, moving* mark that fires constantly and blanks the ladder. It now builds
the honest all-bid or all-ask ladder and reports `markInRange: false` via
`validateGridConfig`. A mark of `$0` is still rejected — sell legs divide by it.

### 3.4 BLOCKER — a simulated batch rendered as `LIVE` *(fixed)*

**Was:** `ConfigPanel` read the *toggle*, not the run:
`value={dryRun ? "SIMULATED" : "LIVE"}`. `BatchResult.dryRun` existed and was
never read. When the SDK fails to import, `kuruClient` falls back to
`runDryRun()` and returns `dryRun: true` **with the toggle off** — so the card
showed `LIVE` beside a fabricated duration and throughput.

**Now:** the badge prefers `batch.dryRun` when a batch exists, and a violet
notice appears when a run was simulated with the toggle off:

> This run was simulated (SDK unavailable) — the figures above are not from the chain.

### 3.5 MAJOR — `TELEMETRY_TIMEOUT_MS` was never applied *(fixed)*

`pingRpcLatency` had no timeout, so the `inFlight` guard latched on a hung node
and the header latency badge froze on a stale value indefinitely. Now races the
ethers call against the timeout via `Promise.race`.

### 3.6 MAJOR — invented throughput *(fixed)*

`durationMs > 0 ? … : working.length * 1000` printed `12000 legs/s` for 12 legs
when the burst rounded to 0 ms. Now `Math.max(1, …)` in the denominator, exactly
as `runDryRun` already did. Both figures are derived from the real measurement.

### 3.7 New — fill watcher

A resting order is filled by a *later* taker transaction, so the placement
receipt cannot tell you. Added:

- `GridOrder.orderId`, parsed from the `OrderCreated` event in the placement
  receipt (`extractOrderId`).
- `GridOrderStatus` gained `"FILLED"`, plus `ORDER_STATUS_META.FILLED` (teal).
- `watchOrderFills()` polls `getLogs` for the `Trade` topic on the market
  contract, correlates against the pending order ids, and flips
  `CONFIRMED → FILLED`.
- `summarizeGrid` now counts `FILLED` as a success alongside `CONFIRMED`.

### 3.8 New — live block feed

`lib/liveChannel.ts` opens a WebSocket and subscribes to `newHeads`. Optional by
design: when `NEXT_PUBLIC_MONAD_WSS_URL` is unset it is a no-op returning
`() => {}`, and the app keeps polling. Reconnects with exponential backoff
capped at 30 s. A dropped socket downgrades the badge to `POLLING` — never an
error.

### 3.9 New — adaptive grid sizing

`computeVolatility` / `adaptiveHalfWidthPct` / `adaptiveBounds` map the stdev of
mid log-returns to a suggested half-width, clamped to ±2 %…±8 %. A 20-sample
rolling window lives in `midHistoryRef`. `ConfigPanel` offers *Apply adaptive
bounds*.

### 3.10 New — one-click demo grid

`handleLoadDemo()` sets simulation mode and a tight 6-level ±1 % grid at $60,
so a judge with no wallet and no configured market sees a full burst instantly.

### 3.11 New — execution timeline & activity feed

`ExecutionTimeline` mirrors the ladder as a lifecycle list (Ready → Pending →
Confirmed/Filled/Failed). `ActivityFeed` is a 50-item ring buffer of block and
batch events, newest first, capped in `pushActivity`.

### 3.15 New — login gate before the terminal

`Landing` doubles as a full-page login screen (`fullPage` centers it in
`min-h-[calc(100vh-3.5rem)]`). `app/page.tsx` renders it while
`address === null && !dryRun`, and the market banner + charts + grid only
after a wallet connect or the no-wallet demo. The *Skip to the terminal*
anchor is hidden in login mode (nothing to scroll to); a failed connect
arrives as `authError` and renders rose under the CTAs. Header gains
*Sign out* (`wallet.disconnect()` + `dryRun=false` + cleared batch/orders),
returning to login. "Login" is wallet-connect only — no credentials, no
backend, no session. Verified in static output: login copy prerendered,
zero terminal strings (`Lower Bound`, `Deploy Parallel Grid`, …) present.

### 3.14 New — full landing surface (in-page, no route)

`components/Landing.tsx` grew from a one-paragraph banner to the full landing
surface, per `LANDING-PLAN.md`: hero row (thesis kept verbatim + *"One page, no
backend, keys in your wallet"* + `ConnectButton` / demo / *Skip to the
terminal* anchor), three pillar cards (`Layers`, `Timer`, `Gauge` — verified
against lucide-react 1.52.0), 4-step how-it-works, and a one-line trust strip
naming `NEXT_PUBLIC_KURU_MARKET_ADDRESS`. `app/page.tsx` wraps the grid in
`<div id="terminal" className="scroll-mt-20">`; the anchor scrolls via a
click-handler `scrollIntoView`, so the server pass stays DOM-free. Deliberately
**not** a `/landing` route: a standalone page buries the demo behind a click.

Gates, 2026-10-05: `typecheck` clean, `lint` clean, `next build` green
(`out/` emitted), `npx serve out` smoke test — all landing copy prerendered in
the static HTML, anchor present, no `0x…40` address bytes in view-source.
Verifier V1–V4: no `any`, `document` only inside the click handler, no wallet
imports in `Landing`, `Promise.allSettled` burst intact, zero `await` in the
four `kuruClient.ts` loops.

Side fix required by the gates: `tsconfig.json` now excludes `paper2agent/`.
That directory is sibling research-framework scaffolding — nothing in `app/`,
`components/` or `lib/` imports from it, and its `pipeline.ts` calls ~10
helpers defined nowhere (16 pre-existing errors). Scoping, not weakening: the
gates judge the app.

### 3.13 New — wallet module + landing page

**`lib/wallet/`** extracts every wallet concern out of `app/page.tsx` into a
standalone module. It was not only tidying: the address used to live in **two**
places at once — React state *and* a ref carrying the provider — and they could
disagree. When `checkAndSwitchNetwork` threw mid-connect, `handleConnect` never
reached `setAddress`, so the UI showed "not connected" while `walletRef.current`
kept a live provider that three call sites went on reading. One immutable
snapshot, replaced wholesale on every transition, with a single `disconnect()`
that clears `account` and `provider` together, makes that unrepresentable.

Layering is deliberate:

- `types.ts` — no React, no runtime imports.
- `store.ts` — no React, `window` only inside functions. A plain observable, so
  a scratch harness can drive it with no DOM and no renderer. That matters: the
  repo has no test runner, so testability-by-construction is the only testing
  story available.
- `useWallet.ts` — the only file importing React. A thin `useSyncExternalStore`.
- `index.ts` — the only public entry point, so `subscribe`/`getSnapshot` stay
  plumbing rather than becoming app API.

`lib/wallet` depends *downward* on `lib/kuruClient`, which stays the single
sanctioned `ethers` boundary. Chain-event subscription also moved out of the
component tree: bound in `connect()`, torn down in `disconnect()`, rather than
living for the whole session.

The load-bearing detail: **`getSnapshot()` must return a stable reference between
transitions.** `useSyncExternalStore` compares with `Object.is`, so building a
fresh object per call re-renders forever. `getServerSnapshot()` returns a frozen
disconnected snapshot so SSR and the first client render agree.

**`components/Landing.tsx` + `components/ConnectButton.tsx`** — the connect
button is extracted so it reads `useWallet()` itself instead of having
`address` / `connecting` threaded down as props. `Landing` carries the thesis,
the three Monad pillars, and — critically — the *run-the-demo-without-a-wallet*
entry point, which must never end up behind a connect gate.

> **Two open defects in the shipped `store.ts`**, both confined to that one file:
> (1) `onAccountsChanged` with an empty account list emits `DISCONNECTED` but does
> not call `detachChainEvents()`, so the listeners stay bound, `subscribeChainEvents()`
> later early-returns on its `detachChainEvents !== null` guard, and a reconnect
> silently gets no listeners — account switches stop updating the UI.
> (2) The `connect()` catch spreads `...snapshot`, so a *failed reconnect* keeps
> the previous `account` / `provider` alongside `status: "error"` — exactly the
> stale-provider invariant the module was created to eliminate. Tracked under
> `bugs.md` O6.

### 3.12 Error-handling and efficiency cleanup
- Dead duplicate `WalletConnection` (`{address, chainId}`) deleted from
  `constants.ts`. One definition remains, in `kuruClient.ts` (`{provider,
  address}`), which is what `page.tsx` imports.
- `EIP1193_ERROR.INTERNAL` (`-32603`) was **declared but never handled**. A
  locked wallet returns it on `eth_chainId`; it now maps to *"The wallet is
  locked. Unlock it to read the chain id."* — actionable, where the old
  *"broken provider"* was not.
- Local `extractCode` removed. `isUserRejection` now goes through the canonical
  `eip1193CodeOf`; the local copy had already drifted from it once.
- `connectWallet` no longer calls `provider.getSigner().getAddress()` —
  `eth_requestAccounts` already returned that address, and the signer was
  re-deriving it over an extra `eth_accounts` round-trip on every connect.
- `getTelemetryProvider()` memoised into a module singleton; it was constructing
  a fresh `JsonRpcProvider` every 5 s.
- `ensureAllowance` reads `allowance.gte(required)` rather than
  `!allowance.lt(required)`, and the `MaxUint256` approval now carries an
  explicit *do not copy to mainnet* warning.
- `Sync to Market` tightened from ±15 % to `SYNC_BAND_PCT` (±4 %). A 30 % band
  produced a chasm with a handful of levels in it; that is not a grid.
- `.env.example` documents `NEXT_PUBLIC_MONAD_WSS_URL`.

---

## 4. Function reference

### `lib/constants.ts` — no imports, bottom of the graph

**Network**
- `MONAD_TESTNET: NetworkConfig` — chain 10143 / `0x279f`, MON 18dp,
  `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadexplorer.com`.
- `explorerTxUrl(txHash): string` — builds the explorer link for one tx.
- `TELEMETRY_RPC_URL` — read-only RPC, `NEXT_PUBLIC_MONAD_RPC_URL` overridable.
- `TELEMETRY_WSS_URL: string | null` — **`null` when unset**, which is what
  makes the live channel optional.

**Market**
- `DEFAULT_MARKET_ADDRESS` — from `NEXT_PUBLIC_KURU_MARKET_ADDRESS`, else the
  zero address. There is no canonical Kuru registry, so this must be configured.
- `isUnsetMarketAddress(address): boolean` — absent, empty, unparsable, or
  `0x0…0`. Detected **before** any SDK load so a wrong address fails fast
  instead of firing doomed transactions.
- `ZERO_ADDRESS`, `MARKET_LABEL` (`"MON / USDC"`).

**Limits & precision**
- `MIN_GRID_COUNT` 2 · `MAX_GRID_COUNT` **20** (a *wallet* limit — every leg is
  a signature MetaMask must queue; not a protocol limit).
- `PRICE_DECIMALS` 8 · `SIZE_DECIMALS` 4 · `NOTIONAL_DECIMALS` 2.

**Timing**
- `TELEMETRY_TIMEOUT_MS` 4000 · `TELEMETRY_POLL_MS` 5000 ·
  `MARKET_BOOK_POLL_MS` 10000 · `MARKET_STATUS_POLL_MS` 15000 ·
  `SYNC_BAND_PCT` 0.04.

**Types**
- `GridConfig` · `DEFAULT_GRID_CONFIG` (`0.045–0.055`, 12 levels, $120).
- `GridOrderStatus` = `READY | PLACING | CONFIRMED | FILLED | FAILED`.
- `GridOrder` — `id, price, size, notional, isBuy, levelIndex, status, txHash,
  error, orderId`.
- `KuruBookSnapshot` — `bestBid, bestAsk, mid, blockNumber, bidDepth, askDepth,
  fetchedAt`.
- `BatchResult` — `durationMs, successCount, failureCount, totalCount,
  throughput, dryRun`.
- `PlaceOrdersOptions` — `dryRun?`, `postOnly?`.
- `TelemetrySample` · `MarketStatusReport` · `NetworkCheckResult` ·
  `OrderUpdateCallback`.
- `ORDER_STATUS_META: Record<GridOrderStatus, {label, dot, pill, text}>` — the
  status→colour map lives here, never re-declared in JSX.

**Errors**
- `KuruGridError extends Error` — `code: WalletErrorCode`, `cause` preserved.
  Every user-facing failure is one of these, so no raw ethers blob is rendered.
- `toKuruGridError(error, fallbackMessage)` — normalises anything. Maps EIP-1193
  `4001` → *"You rejected the request in your wallet."* There is deliberately no
  retry anywhere near it: a user closing a MetaMask popup is not an app failure.
- `eip1193CodeOf(error): number | null` — digs `code` out of an `Error`, a bare
  `{code, message}`, or a nested `.error.code`.
- `EIP1193_ERROR` — `USER_REJECTED: 4001`, `CHAIN_NOT_ADDED: 4902`,
  `INTERNAL: -32603`. Frozen const, not an enum.
- `GridConfigError extends Error` — `field` lets the UI highlight the input.

### `lib/gridEngine.ts` — pure: no I/O, no clock, no randomness

| Function | What it does |
| --- | --- |
| `roundTo(v, decimals)` | Rounds with a `Number.EPSILON` nudge. Load-bearing: without it `roundTo(1.005, 2)` returns `1`. |
| `notionalPerLevelSlice(capital, count)` | **The one true USDC slice per level.** Preview and broadcast both round through this. |
| `validateGridConfig(lo, hi, count, capital, mark?)` | Validates without building. Returns `valid`, per-field `errors`, `stepPrice`, `notionalPerLevel`, `requiredMonInventory`, `buyLegs`, `sellLegs`, `markInRange`. Also rejects capital so small the slice rounds to `$0.00`. |
| `generateGridLevels(lo, hi, count)` | Evenly spaced prices. **Arithmetic** grid — constant *dollar* spacing, so every level carries equal risk. |
| `calculateGridOrders(mark, lo, hi, count, capital, opts?)` | Builds the ladder. `price < mark` → bid, else ask. Buy size `= slice / price`, sell size `= slice / mark`. Returns **descending by price** — highest ask on top. |
| `summarizeGrid(orders)` | Aggregates counts, notionals, `requiredMon`, `bestBid`, `bestAsk`. `CONFIRMED` and `FILLED` both count as success. |
| `computeVolatility(prices)` | Stdev of log returns — scale-free. `0` for <2 samples. |
| `adaptiveHalfWidthPct(vol)` | Vol → half-width, clamped ±2 %…±8 %. |
| `adaptiveBounds(mark, vol)` | Suggested `[lower, upper]` around the mark. |
| `formatPrice(v)` / `formatSize(v)` | Display formatters; `"—"` for non-finite. |

Private: `normalise` (15-significant-digit float cleanup),
`assertFinite`.

### `lib/kuruClient.ts` — the only file importing `ethers`

| Function | What it does |
| --- | --- |
| `connectWallet(): Promise<WalletConnection>` | `eth_requestAccounts` → ethers `Web3Provider`. Click handler only, never render. |
| `checkAndSwitchNetwork(): Promise<NetworkCheckResult>` | `eth_chainId` → already on Monad? done → `eth_requestAccounts` → `wallet_switchEthereumChain` → **only** on `4902` fall through to `wallet_addEthereumChain` → re-verify. |
| `getTelemetryProvider()` | Read-only `JsonRpcProvider` for pings and dry runs. Memoised singleton. |
| `pingRpcLatency(): Promise<TelemetrySample>` | One `eth_blockNumber` round-trip, raced against `TELEMETRY_TIMEOUT_MS`. |
| `checkMarketStatus(addr, provider)` | Deployed-code check + `getMarketParams`. `LIVE` or `DEGRADED` — never a fake success. |
| `placeParallelKuruOrders(provider, addr, orders, onUpdate, opts?)` | **The burst.** See below. |
| `watchOrderFills(provider, addr, ids, onFilled, intervalMs?)` | Polls the `Trade` log topic, correlates order ids, calls `onFilled`, self-stops when all ids are seen. Returns a stop function. |

Private: `isUserRejection`, `messageOf`, `normaliseChainId`, `safeToNumber`,
`decimalsFromPrecision`, `decimalsFromCount`, `ensureAllowance`,
`ensureApprovals`, `extractOrderId`, `runDryRun`.

**The burst — the load-bearing code in this repo:**

```ts
await Promise.allSettled(
  working.map(async (order, index) => { /* … placeLimit … */ }),
);
```

`.map()` builds the array before anything is awaited, so every leg is fired in
the same tick. `allSettled`, **never `all`**: one rejected signature must mark
exactly one row `FAILED` and leave the other 11 live. A mined-but-reverted
receipt still *resolves*, so success is `receipt.status === 1` — never a resolved
promise.

Order of operations: SDK dynamic `import()` → resolve signer →
`getMarketParams` (**fails loud, never mocks**) → derive decimals →
`ensureApprovals` (**sequential, before** the burst — parallel would race the
nonce) → burst.

`decimalsFromPrecision` vs `decimalsFromCount` are two functions on purpose.
Precisions are powers of ten so `log10` gives the decimals. Token decimals are
*already counts* (USDC 6, MON 18); `Math.log10(6) = 0.778` is not an integer, and
running them through the precision helper rejected every real market — which
killed the live deploy before it broadcast anything.

### `lib/marketBook.ts` — the honest mark

`fetchMarketBook(provider, marketAddress): Promise<KuruBookSnapshot>`

`getMarketParams` → `OrderBook.getL2OrderBook` → `bestBid = max(bids)`,
`bestAsk = min(asks)`, `mid = (bestBid + bestAsk) / 2`. One-sided books
degrade to the available side. Computed from max/min rather than trusting the
SDK's sort order. Empty book throws — it never returns a fabricated mid.

### `lib/liveChannel.ts`

`startLiveChannel(events): () => void` — `onHead`, `onOpen`, `onClose`,
`onError`. Returns a cleanup that nulls `onclose` before closing so teardown
cannot trigger a reconnect.

### `app/page.tsx` — composition root

State: `config, orders, address, chainId, batch, telemetry, error, dryRun,
connecting, deploying, book, tickDir, marketReport, feedState, liveBlock,
activity`.
Refs: `walletRef, deployingRef, midHistoryRef, stopFillWatchRef, activitySeqRef`.

Five effects: preview regeneration (skipped while deploying, guarded by
`deployingRef` not state, so in-flight `PLACING` rows survive) · telemetry poll
· orderbook poll · live channel · market status · wallet listeners (with
`removeListener` cleanup).

Handlers: `handleConnect` · `handleDeploy` · `handleSyncToMarket` (±4 %) ·
`handleLoadDemo` · `handleApplyAdaptive` · `pushActivity` · `cancelFillWatch`.

Confetti fires **in the handler**, on `successCount > 0` — not in an effect, so
`StrictMode` cannot double it.

### Components

`ConfigPanel` — 5 inputs, derived funding preconditions, the deploy button state
machine (`Connect Wallet First` → `Switch to Monad Testnet` → `Deploy` →
`Broadcasting n/n…` → `Deploy Another Grid`), and the telemetry card. Private:
`Field`, `NumberField` (keeps a text mirror while focused so `0.0` isn't eaten
mid-keystroke), `TelemetryRow`.

`OrderLadder` — depth bars, `BID`/`ASK` badges, status pills from
`ORDER_STATUS_META`, explorer link only when `txHash !== null`, dashed mark
divider at the bid/ask boundary, never-blank empty state. Private: `LadderRow`.

`ExecutionTimeline` · `ActivityFeed` — presentational, parent owns the state.

---

## 5. Data flow

```
Monad orderbook ──> marketBook.fetchMarketBook ──> book.mid
                                                     │
                                                     v
                        gridEngine.calculateGridOrders ──> orders[] (READY)
                                                     │
                          ConfigPanel (config) ──────┤
                                                     v
page.handleDeploy ──> kuruClient.placeParallelKuruOrders
                          ├─ import(SDK) ─> getMarketParams (fail loud)
                          ├─ ensureApprovals   (sequential precondition)
                          └─ .map() ─> Promise.allSettled   ← THE BURST
                                    └─ onUpdate(newArray) per leg
                          └─ receipt.status === 1 ─> CONFIRMED + orderId
                                                     │
                    watchOrderFills ──> Trade log ──> FILLED
```

Read-only, parallel: `pingRpcLatency` (5 s) · `fetchMarketBook` (10 s) ·
`checkMarketStatus` (15 s) · `startLiveChannel` (push, optional).

---

## 6. Verification

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean (strict + `noUncheckedIndexedAccess`) |
| `npm run lint` | clean |
| `npm run build` | succeeds, static export to `out/` |
| `Promise.all(` | **none** |
| `await` inside a loop | **none** — the two `for` loops in `kuruClient.ts` (receipt logs, trade logs) contain no `await` |
| `Math.random(` | only in a comment |
| `: any` / `as any` | none |
| `localStorage` / `suppressHydrationWarning` | none |
| references to deleted `marketFeed` | none |

The notional-slice fix (§3.2) and the out-of-range-mark behaviour (§3.3) were
proven with a scratch harness over five configurations, run outside the repo so
nothing was touched.

---

## 7. Not done

Deliberately open, in rough priority order.

1. **Zero unit tests.** `agent1.md` §6 decision 4 bans a test runner (the
   dependency list is closed). Every grid change is currently verified by a
   throwaway harness. This is now the sharpest gap: §3.2 (preview and broadcast
   disagreed on the notional slice) and §3.0.4 (the tick-snap gate) were *both*
   caught by a throwaway harness, and both are exactly the class of bug a
   permanent test catches for free. The mainnet constraints make it worse — the
   200 MON minimum is a number the app now depends on, and nothing asserts it.
2. **Live placement has never been executed against mainnet.** Verified up to
   `estimateGas` with a zero-balance `from`, which proves the *encoding* and the
   *size rules* but not that twenty signatures from a funded wallet settle as
   expected. Deliberate: it needs real funds and real signatures, and stopping
   short of approval is the correct boundary for an automated change.
3. **`checkGridAgainstMarket` covers size and tick, not the rest.** `maxSize` is
   checked, but nothing validates the *sum* of leg sizes against a venue-level
   cap, and `postOnly` rejections (a leg that would cross the spread) are
   handled by the contract rather than predicted. On this market fees are 0 bps
   and the spread is wide enough that post-only rarely triggers, so neither is
   currently biting.
4. **Docs are out of date.** `progress.md` still claims "all steps DONE / audit
   passed" while its own footnote records 3 BLOCKER + 3 MAJOR open. §3.1, §3.4,
   §3.5 and §3.6 have since closed those. `agentplanner.md` rows 1.1–1.6 and
   2.1–2.7 need marking.
5. **No cancel-all.** Rejected on the merits rather than deferred: cancelling is
   a *second* parallel burst of signatures, and the demo's whole point is that
   placing a ladder at once is the hard part. On mainnet this is more painful
   than it sounds — a ladder placed against a real book needs a way out.

Closed since this list was first drafted: the redundant
`getSigner().getAddress()` (B5), the duplicate `extractCode` helper (B6), the
per-poll `JsonRpcProvider` (B7), the inverted `allowance.lt` read (B8), the
unhandled `-32603` (B4), the `MaxUint256` mainnet warning (B14) — which the
mainnet migration then **acted on** rather than leaving as a comment (§3.0.2) —
and the ignored `tickSize` / `minSize` / `maxSize`, which §3.0.3 enforces both
inside the burst and, now, in the preview before it. `FILL_WATCH_ABI` was
verified against the SDK's own `abi/OrderBook.json`: both transcribed signatures
hash to the SDK's topics exactly, so the fill watcher and the ticker are
decoding the real events. See §3.12.

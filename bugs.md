# KuruGrid — Code Review: Bugs, Features, Optimizations

> Full audit of every source file. Severity: **BLOCKER** · **MAJOR** · **MINOR**

---

## Bugs

### B1 — Ticker is ETH/USDT, not MON/USDC (MAJOR)

**File:** `lib/marketFeed.ts:41`, `app/page.tsx:89-90`

The live ticker fetches ETH/USDT from Binance, but the grid trades MON/USDC on
Kuru. The mark price that drives bid/ask assignment is therefore the wrong
asset's price. A judge watching the ladder split at $3,200 (ETH) while
trading MON at $0.05 will notice immediately.

**Why it matters:** The mark price determines which legs are bids vs asks.
Using the wrong price means the grid is built around a meaningless number.

**Fix:** Either (a) find a MON/USDC price source (Kuru API, Monad DEX), or
(b) label the ticker clearly as "ETH/USDT reference" and use the midpoint
as the mark for grid construction, showing the ticker only as market context.

---

### B2 — `TELEMETRY_TIMEOUT_MS` defined but never used (MINOR)

**File:** `lib/constants.ts:127`, `lib/kuruClient.ts:310-328`

`TELEMETRY_TIMEOUT_MS = 4000` is exported from constants but `pingRpcLatency`
never applies it. A hung RPC call will hang the telemetry poll indefinitely
(the `inFlight` guard prevents overlap but never aborts the stuck call).

**Fix:** Wrap the `provider.getBlockNumber()` call with an `AbortController`
or `Promise.race` timeout using `TELEMETRY_TIMEOUT_MS`.

---

### B3 — `WalletConnection` defined twice with different shapes (MINOR)

**File:** `lib/constants.ts:360-364`, `lib/kuruClient.ts:134-137`

Two interfaces named `WalletConnection`:
- `constants.ts`: `{ address, chainId }`
- `kuruClient.ts`: `{ provider, address }`

The one in `kuruClient.ts` is the one actually used. The one in
`constants.ts` is dead code that confuses readers.

**Fix:** Remove the `WalletConnection` interface from `constants.ts` (it
should only live in `kuruClient.ts` where it's used).

---

### B4 — `EIP1193_ERROR.INTERNAL` defined but never used (MINOR)

**File:** `lib/constants.ts:248`

The `INTERNAL: -32603` error code is defined in the frozen const object but
never referenced anywhere in the codebase.

**Fix:** Remove it, or add handling for it in `checkAndSwitchNetwork` (a
locked wallet returns `-32603` on `eth_chainId`).

---

### B5 — `connectWallet` makes redundant RPC call (MINOR)

**File:** `lib/kuruClient.ts:173`

```ts
const address = await provider.getSigner().getAddress();
```

We already have the address from `eth_requestAccounts`. This line makes an
extra `eth_accounts` RPC call to re-derive it. On a slow RPC this adds
latency to the connect flow.

**Fix:** Use the address from `eth_requestAccounts` directly (it's the same
value the signer would return).

---

### B6 — `extractCode` duplicates `eip1193CodeOf` (MINOR)

**File:** `lib/kuruClient.ts:98-109`, `lib/constants.ts:259-273`

Two functions do the same thing: extract a numeric error code from an unknown
error object. `eip1193CodeOf` in constants.ts is the canonical one;
`extractCode` in kuruClient.ts is a local copy that also handles string codes.

**Fix:** Use `eip1193CodeOf` everywhere and remove `extractCode`, or move
`extractCode` to constants.ts and have `eip1193CodeOf` delegate to it.

---

### B7 — `pingRpcLatency` creates a new provider on every call (MINOR)

**File:** `lib/kuruClient.ts:180-182`

```ts
export function getTelemetryProvider(): providers.JsonRpcProvider {
  return new providers.JsonRpcProvider(TELEMETRY_RPC_URL, MONAD_TESTNET.chainId);
}
```

Called every 5 seconds. Each call constructs a new `JsonRpcProvider` with its
own internal state. Not a leak (the old one gets GC'd), but wasteful.

**Fix:** Cache the provider in a module-level singleton:
```ts
let cached: providers.JsonRpcProvider | null = null;
export function getTelemetryProvider(): providers.JsonRpcProvider {
  if (cached === null) cached = new providers.JsonRpcProvider(TELEMETRY_RPC_URL, MONAD_TESTNET.chainId);
  return cached;
}
```

---

### B8 — `void settled` is a code smell (MINOR)

**File:** `lib/kuruClient.ts:674`

```ts
void settled;
```

The `settled` variable is assigned from `Promise.allSettled` but never read.
Each leg already catches its own errors, so `settled` is always fulfilled.
The `void` keyword suppresses the unused-variable warning but adds noise.

**Fix:** Remove the variable entirely:
```ts
await Promise.allSettled(working.map(async (order, index) => { ... }));
```

---

### B9 — Module-level mutable state in `marketFeed.ts` (MINOR)

**File:** `lib/marketFeed.ts:24`

```ts
let lastGood: MarketTicker | null = null;
```

Module-level mutable state. In a client-only app this works, but it's a
hidden dependency that makes the module untestable and could cause issues if
the module is ever imported in a server context.

**Fix:** Acceptable for a hackathon, but document the limitation or move the
cache into the caller's state.

---

### B10 — `tickDir` causes unnecessary re-renders (MINOR)

**File:** `app/page.tsx:181-186`

Every 3-second tick, even when the price is unchanged, `tickDir` is set to
`"up"` or `"down"` and then cleared 800ms later. This causes 2 extra renders
per tick (one to set the direction, one to clear it).

**Fix:** Only set `tickDir` when the price actually changed:
```ts
if (next.price !== previousPrice) {
  setTickDir(next.price > previousPrice ? "up" : "down");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setTickDir(null), 800);
}
```

---

### B11 — No debouncing on config inputs (MINOR)

**File:** `components/ConfigPanel.tsx:369-411`

Every keystroke in the number inputs triggers `onConfigChange`, which
recalculates the entire grid and re-renders the ladder. For a hackathon
demo this is fine, but it could cause jank on slower devices.

**Fix:** Debounce the `onConfigChange` callback by ~150ms, or use
`useDeferredValue` for the grid calculation.

---

### B12 — `handleSyncToMarket` range is too wide (MINOR)

**File:** `app/page.tsx:389-397`

```ts
lowerBound: round4(ticker.price * 0.85),
upperBound: round4(ticker.price * 1.15),
```

A ±15% range (30% total) is very wide for a grid. Most grid strategies use
1-5% ranges. This will produce very few levels within the range.

**Fix:** Use a tighter range (e.g., ±2-5%) or make it configurable.

---

### B13 — `checkMarketStatus` re-imports SDK every 15 seconds (MINOR)

**File:** `lib/kuruClient.ts:383-385`

The dynamic `import("@kuru-labs/kuru-sdk")` is cached by the module system,
so this isn't a real performance issue. But it's unnecessary — the SDK could
be loaded once and passed in.

**Fix:** Acceptable as-is (the module cache makes this a no-op), but worth
noting for clarity.

---

### B14 — `ensureAllowance` uses `MaxUint256` approval (MINOR)

**File:** `lib/kuruClient.ts:479`

```ts
const tx = (await token.approve(spender, constants.MaxUint256)) as ...
```

Approving `MaxUint256` is fine for testnet (faucet money, resettable chain)
but would be a security concern on mainnet. The comment explains the
reasoning, so this is acceptable for the hackathon context.

**Fix:** No change needed for testnet. Add a comment warning against
copying this pattern to mainnet.

---

## Feature Suggestions

### F1 — Add a "Cancel All Orders" button

The README lists "no cancel-all / rebalance" as a known limitation. For a
trading terminal, the ability to cancel all resting orders is table stakes.
The Kuru SDK likely exposes a cancel function.

### F2 — Add grid templates (presets)

Common grid configurations (tight range, wide range, buy-heavy, sell-heavy)
as one-click presets would make the demo faster for judges.

### F3 — Add a depth chart visualization

The current ladder is a table. A visual depth chart (bids on the left, asks
on the right, like a real order book) would be more impressive visually.

### F4 — Add transaction history

A list of recent batches with links to each transaction on the explorer.
Currently only the current batch is shown.

### F5 — Add a "gas spent" metric

Show the total gas cost of the batch (sum of all leg gas costs). This
reinforces the "micro-gas" claim.

### F6 — Add keyboard shortcuts

- `Enter` to deploy
- `Esc` to dismiss errors
- `S` to toggle simulation mode

### F7 — Add a settings panel

- RPC URL override
- Slippage tolerance
- Post-only toggle
- Gas price multiplier

### F8 — Add export/import grid config

Save and load grid configurations as JSON, so judges can reproduce a
specific setup.

---

## Code Optimization Strategies

### O1 — Memoize `LadderRow` with `React.memo`

**File:** `components/OrderLadder.tsx:131`

Each row re-renders on every parent render. With 20 rows this is fine, but
wrapping `LadderRow` in `React.memo` would prevent unnecessary re-renders
when only one row's status changes.

```ts
const LadderRow = memo(function LadderRow({ order, maxNotional }: LadderRowProps) { ... });
```

### O2 — Consolidate the three `setInterval` calls

**File:** `app/page.tsx:137-241`

Three separate intervals (telemetry 5s, ticker 3s, market status 15s) each
with their own `cancelled`/`inFlight` guards. These could be consolidated
into a single interval that ticks every second and runs each task based on
an elapsed-time counter.

### O3 — Use `useDeferredValue` for grid calculation

**File:** `app/page.tsx:92-102`

The `validation` and `summary` useMemo hooks recalculate on every keystroke.
Wrapping the config in `useDeferredValue` would let React prioritize
input responsiveness over grid recalculation.

### O4 — Virtualize the order ladder

**File:** `components/OrderLadder.tsx:98-114`

With 20 rows this is unnecessary, but if `MAX_GRID_COUNT` ever increases,
a virtualized list (e.g., `react-window`) would keep rendering performant.

### O5 — Batch state updates in the broadcast

**File:** `lib/kuruClient.ts:622-629`

Each `updateRow` call creates a new array and calls `onUpdate`, triggering
a React re-render. With 20 legs settling at slightly different times, this
causes up to 20 re-renders. Batching updates (e.g., collecting all updates
and flushing them in a single `setOrders` call) would reduce renders.

### O6 — Use `useSyncExternalStore` for wallet state

**File:** `app/page.tsx:244-275`

The wallet event listeners could be abstracted into a custom hook using
`useSyncExternalStore`, which is the React-recommended pattern for
subscribing to external data sources.

### O7 — Precompute grid levels

**File:** `lib/gridEngine.ts:167-178`

`generateGridLevels` is called every time the config changes. For a given
`(lowerBound, upperBound, gridCount)` tuple, the result is deterministic.
A simple `Map`-based cache would avoid recomputation.

### O8 — Use CSS containment for the ladder

**File:** `components/OrderLadder.tsx:48`

Adding `contain: layout style` to the ladder section would tell the
browser to isolate its rendering, improving scroll performance.

### O9 — Lazy-load the SDK only when needed

**File:** `lib/kuruClient.ts:557-568`

The SDK is loaded on every `placeParallelKuruOrders` call (when not dry-run).
While the module cache makes subsequent loads cheap, the first load still
has a cost. Consider showing a "Loading SDK..." indicator during the
first load.

### O10 — Use `BigInt` for price/size in the engine

**File:** `lib/gridEngine.ts`

The grid engine uses `number` for prices and sizes. For a production
system, `BigInt` (or ethers `BigNumber`) would avoid floating-point
precision issues. For a hackathon demo with 8 decimal places, `number` is
acceptable but worth noting.

---

## Summary

| Category | Count | Critical |
|----------|-------|----------|
| Bugs | 14 | 0 blockers, 1 major, 13 minor |
| Features | 8 | — |
| Optimizations | 10 | — |

**Top 3 to fix before demo:**
1. **B1** — Ticker is ETH/USDT, not MON/USDC (misleading mark price)
2. **B5** — Redundant RPC call in `connectWallet` (adds latency)
3. **B2** — Unused timeout constant (hung RPC can wedge the UI)

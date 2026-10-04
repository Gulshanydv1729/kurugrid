---
name: web3
description: Owns lib/gridEngine.ts (pure grid arithmetic) and lib/kuruClient.ts (MetaMask EIP-1193 + Kuru SDK batch broadcast). Use when touching grid math, wallet/network switching, order placement, batching, gas, or allowances.
---

# Agent: `web3`

You own the only two files in this repo that know what a blockchain is.

- `lib/gridEngine.ts` — pure arithmetic. No I/O, no globals, no clock.
- `lib/kuruClient.ts` — the single boundary to MetaMask and to `@kuru-labs/kuru-sdk`.

You are the one who has to make "parallel" real, and you are the one who has to
make sure a user rejecting a MetaMask popup is not reported as a crash.

---

## Part 1 — `lib/gridEngine.ts`

### The signature (fixed by spec)

```ts
calculateGridOrders(
  currentPrice: number,
  lowerBound: number,
  upperBound: number,
  gridCount: number,
  totalCapital: number,
): GridOrder[]
```

An optional trailing `options` object is permitted for precision/tick snapping,
but **every parameter above must keep its meaning and order**.

### Arithmetic grid, not geometric

Levels are evenly spaced in *price*:

```
step = (upperBound - lowerBound) / gridCount
level[i] = lowerBound + i * step      for i in [0, gridCount)
```

Do not implement a geometric grid. A geometric grid (`upper * r^i`) is what some
exchanges default to, but the arithmetic grid is what the spec calls for, it is
what a reviewer will hand-check, and it gives uniform dollar risk per level — which
is the property that makes a grid a grid.

### Side assignment — read this twice

```ts
isBuy = price < currentPrice;   // strictly below mark  -> green buy limit
isBuy = false otherwise;        // at or above mark     -> red sell limit
```

- Levels **strictly below** the mark price are `isBuy: true`. You are bidding under.
- Levels **at or above** the mark are `isBuy: false`. You are asking over.

"Strictly below" is deliberate: a level landing exactly on the mark is already
touching, so treat it as an offer, not a bid. Do not "improve" this to `<=`.

### Sort order — fixed

**Descending by price.** Highest sell on top, lowest buy on the bottom. This is
how a trader reads a ladder; ascending would be a UI bug, not a preference.
Make sure you do it once, at the end:

```ts
return orders.sort((a, b) => b.price - a.price);
```

### Capital allocation

Every level gets an equal **notional** slice: `N = totalCapital / gridCount`.

- Buy leg: you spend `N` USDC → `size = N / price`.
- Sell leg: you must already hold MON. Size it so the level is worth `N` at the
  mark: `size = N / currentPrice`.

This is the honest model, and it implies an inventory precondition you must state
in the UI: **selling `gridCount` levels requires holding roughly
`totalCapital * (sellLegs / gridCount) / currentPrice` MON**, because a grid that
only ever buys never has base inventory to sell. Do not pretend otherwise.

### Floating point hygiene — the classic bug

`0.1 + 0.2 === 0.30000000000000004`. If a level price renders as
`0.30000000000000004` the order will be clipped by the SDK and the user will see
a nonsense ladder.

Round aggressively and centrally:

```ts
const roundTo = (v: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round((v + Number.EPSILON) * f) / f;
};
```

Use `+ Number.EPSILON` — without it, `roundTo(1.005, 2)` returns `1` instead of
`1.01`. Round prices to `PRICE_DECIMALS`, sizes to `SIZE_DECIMALS` from
`constants.ts`. Never `toFixed()` in the engine; that returns a string and it
silently propagates.

### Validation — fail loud, fail early

Throw a `GridConfigError` (a real exported class, not a bare `Error`) with a
human-readable message for: non-finite inputs, `lowerBound <= 0`, `upperBound <= lowerBound`,
`gridCount < 2` or non-integer, `gridCount > MAX_GRID_COUNT`, `totalCapital <= 0`,
and `currentPrice` outside `[lowerBound, upperBound]`.

A mark price outside the configured band means the user wants to buy the top of
the range or sell the bottom — there is no market-making grid there. Reject it;
silently clamping produces a ladder that does not match what they asked for.

---

## Part 2 — `lib/kuruClient.ts`

### Verified SDK surface (v0.0.95 — trust this, re-verify on upgrade)

```ts
import { ParamFetcher, GTC } from '@kuru-labs/kuru-sdk';

const marketParams = await ParamFetcher.getMarketParams(providerOrSigner, marketAddress);
// -> MarketParams { pricePrecision, sizePrecision, baseAssetAddress,
//                   baseAssetDecimals, quoteAssetAddress, quoteAssetDecimals,
//                   tickSize, minSize, maxSize, takerFeeBps, makerFeeBps }
//    every numeric field is an ethers BigNumber

const receipt = await GTC.placeLimit(signer, marketAddress, marketParams, {
  price,        // string — HUMAN decimal, e.g. "0.05123"
  size,         // string — HUMAN decimal, e.g. "125.5"
  isBuy: true,
  postOnly: true,
});
// -> ethers ContractReceipt { transactionHash, status, gasUsed, blockNumber }
```

Three things about this API that will bite you if you do not know them:

1. **`price` and `size` are decimal *strings*, not numbers.** The SDK does
   `clipToDecimals(order.price, priceDecimals)` which calls `String.split('.')`.
   Pass a number and it throws `value.split is not a function`. The published
   README examples pass bare numbers — **the README is out of date, the types are
   right.** Always `price.toFixed(PRICE_DECIMALS)`.
2. **Decimals are derived from the precision BigNumbers:**
   `decimals = log10(pricePrecision)`. Do not hardcode 6 or 8 — read it.
3. **`placeLimit` does NOT handle ERC-20 approval.** It goes straight to
   `addBuyOrder` / `addSellOrder`. If the vault has no allowance, the contract
   reverts. You must call `approveToken` first — see below.

### The signature (fixed by spec)

```ts
checkAndSwitchNetwork(): Promise<NetworkCheckResult>

placeParallelKuruOrders(
  provider,           // ethers providers.Provider | Signer
  marketAddress,      // string
  orders,             // GridOrder[]
  onUpdate,           // (orders: GridOrder[]) => void   progress callback
): Promise<BatchResult>
```

`BatchResult` must include `durationMs` and `successCount` (the spec requires
them); `failureCount` and `dryRun` are additive and welcome.

### `checkAndSwitchNetwork()`

```
1. Guard window.ethereum.        typeof window === 'undefined'        -> throw NO_WALLET
2. Guard chainId read.           may be missing on odd wallets         -> throw NO_WALLET
3. eth_chainId === 0x279f ?      -> return { ok: true,  switched: false }
4. else eth_requestAccounts      -> may throw 4001 (user said no)      -> USER_REJECTED
5. wallet_switchEthereumChain
     success                     -> return { ok: true,  switched: true }
     throws 4902                 -> fall through to add
     throws anything else        -> rethrow (do NOT guess)
6. wallet_addEthereumChain({ chainId: '0x279f', chainName, nativeCurrency:
   { name: 'Monad', symbol: 'MON', decimals: 18 }, rpcUrls: [rpc], blockExplorerUrls: [explorer] })
7. verify chainId again          -> return { ok: true,  switched: true }
```

Hard rules:

- **Never pass `undefined` into the `params` array of `wallet_switchEthereumChain`.**
  Pass `[ { chainId } ]` or `[]`. Passing `[undefined]` is a TypeError inside the
  wallet, not a user-facing error.
- **Error code `4902` means "chain not added to wallet"** — that is the *only*
  condition under which you call `wallet_addEthereumChain`. Catch it specifically.
- **Error code `4001` means the user rejected the prompt.** Translate it to a
  message like "You rejected the network switch" and do not retry automatically.
  Auto-retrying a rejected wallet prompt is hostile.
- Compare chain IDs **case-insensitively** (`'0x279F'` and `'0x279f'` are both
  legal) and normalise via `ethers.BigNumber.from(chainId).toNumber()` rather than
  string equality.

### The broadcast batch — the heart of the product

```ts
const t0 = performance.now();
const settled = await Promise.allSettled(
  orders.map(async (order) => {
    onUpdate(mark(order.id, 'PLACING'));
    const receipt = await GTC.placeLimit(signer, marketAddress, params, toLimit(order));
    return receipt;
  }),
);
const durationMs = Math.round(performance.now() - t0);
```

- **`.map()` before the `allSettled`**, so every leg starts in the same tick.
  Building the array lazily with `async` generators serialises it.
- **`allSettled`, never `all`** (`AGENTS.md` §4.3).
- Feed `onUpdate` with an immutable array each time so React sees a new reference.
  Never mutate the array you passed in.
- Count success from `receipt.status === 1`, not merely from a resolved promise.
  A mined-but-reverted receipt resolves successfully — reporting that as a
  success is a lie the ladder would display as emerald.

### Approvals — do not skip this

Before broadcasting:

1. Buys spend `quoteAssetAddress` (USDC). Sells spend `baseAssetAddress` (MON).
2. Read `allowance(owner, marketAddress)` for whichever tokens the grid actually
   touches. Skip entirely if the grid has zero buys or zero sells.
3. If allowance is short, send one `approve` per token and **await its receipt
   before** the `allSettled`. Approvals are a precondition, not part of the
   parallel burst — parallelising approvals would just race the same nonce.
4. Approve the required notional (or `MaxUint256` on testnet — it is faucet money,
   and asking for a second signature per token is worse UX than the argument).

### Dry-run / offline mock fallback

Required by spec, and it is genuinely useful for demos without a funded wallet.

```ts
placeParallelKuruOrders(provider, marketAddress, orders, onUpdate, { dryRun: true })
```

Mock behaviour: resolve after a small randomised delay, emit a **syntactically
valid but non-existent** tx hash, and set `dryRun: true` on the result so the UI
can badge the run `SIMULATED`.

**The mock is allowed only when:**
- `options.dryRun === true`, **or**
- the SDK module itself failed to `import()` (offline / broken bundle), **or**
- the RPC is unreachable *and* the user explicitly opted into offline mode.

**The mock is forbidden when:**
- the user rejected a signature (4001) — that is a real outcome, report it,
- `getMarketParams` failed — a wrong market address must be a loud error
  (`AGENTS.md` §7.4), never a fake success,
- any individual leg reverted — the ladder shows the real error string.

A mock that hides a real failure is worse than no mock, because it makes a broken
demo look like a working one in front of judges.

### Telemetry

Measure with `performance.now()` around the batch, and `performance.now()` again
for the pure wall-clock confirm time. Report both if you can — `durationMs`
(wallet-open to all-receipts) and the RPC ping latency separately. These numbers
are the actual deliverable for the bounty.

---

## Review checklist

- [ ] `gridEngine.ts` imports nothing but `constants.ts`. Still true?
- [ ] `isBuy` is `price < currentPrice` — strictly less than.
- [ ] Result is sorted **descending** by price.
- [ ] No `await` inside a `for` loop anywhere.
- [ ] `Promise.allSettled` used, not `Promise.all`.
- [ ] `price`/`size` passed to `placeLimit` as **decimal strings**.
- [ ] `postOnly: true` — we are a market maker, we must never cross the spread.
- [ ] Success counted via `receipt.status === 1`.
- [ ] Approvals in place before the burst.
- [ ] 4001 translated to a friendly message, no auto-retry.
- [ ] `wallet_addEthereumChain` only on 4902.
- [ ] Mock path cannot mask a real error.

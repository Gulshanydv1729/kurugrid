# AGENTS.md — KuruGrid

> Operating contract for every agent working in this repository.
> Read this file completely before writing code.

---

## 1. Project objective

**KuruGrid** is a single-page, client-only trading terminal that deploys a full
**arithmetic grid ladder** onto the **Kuru CLOB** on **Monad Mainnet** in a
single *parallel* burst.

The product thesis — and the thing the judges grade — is:

> Grid trading needs dozens of limit orders live at once. On a sequential EVM,
> fifty sequential broadcasts is fifty round-trips and the grid is worthless.
> Monad executes them **in parallel** with sub-second finality and micro-gas, so
> the entire ladder is live in one user gesture.

Everything in the codebase exists to make that claim **measurable and visible**
in the UI. The latency counter and the batch duration are not decoration — they
are the proof.

**Target:** Metropolis Hackathon — **$5,000 Kuru Bounty** track.

---

## 2. Tech stack (do not substitute)

| Layer            | Choice                              | Notes                                             |
| ---------------- | ----------------------------------- | ------------------------------------------------- |
| Framework        | **Next.js 14 App Router**           | `app/` directory, no `pages/`. React 18.           |
| Styling          | **Tailwind CSS v3**                 | No CSS modules, no styled-components, no UI kit.  |
| Icons            | **lucide-react**                    | Never inline hand-rolled SVG icons.               |
| Chain client     | **ethers v5** (`5.7.2`)             | **v5, not v6.** Signatures and `BigNumber` differ. |
| Trading SDK      | **`@kuru-labs/kuru-sdk`** (`^0.0.95`) | Pinned internally to `ethers@5.7.1` — v5 compatible. |
| FX               | **`canvas-confetti`**               | Single celebration call on batch success.         |

The Kuru SDK is CommonJS and pulls in `axios`. **Load it with a dynamic
`import()` inside `lib/kuruClient.ts`** — never a top-level static import. This
keeps it out of the SSR graph, keeps the first paint small, and gives us a clean
seam for the offline/dry-run mock fallback. It ships as `dist/index.js` with
types at `dist/index.d.ts`, is internally pinned to `ethers@5.7.1`, and ships
its own `approveToken` / `getAllowance` / `log10BigNumber` / `clipToDecimals`
helpers that must be preferred over hand-rolled ABIs. See `web3.md` for the full
surface.

### Verified SDK invariants (v0.0.95)

- `LIMIT.price` / `LIMIT.size` are **strings** — `clipToDecimals` calls
  `value.split('.')`; a number throws.
- Price/size decimals derive from the precision `BigNumber`s, not a constant.
- `placeLimit` never approves — token allowance is a precondition you set first.
- `log10BigNumber` is `bn.toString().length - 1`; validate before `10 ** n`.

---

## 3. Network constraints (Monad **Mainnet**)

> **Changed 2026-10-05.** The LIVE path was migrated from Testnet to Mainnet.
> The old text read "do not add mainnet support" — that instruction has been
> executed and is now retired. What replaced it is stricter, not looser; see
> the mainnet rules at the end of this section.

The live network is fixed. `ACTIVE_NETWORK` in `lib/constants.ts` is the single
selection point, and **every consumer reads it rather than a chain literal** —
that is a hard rule, because the bug this migration existed to fix was the app
asserting one chain while its provider talked to another.

| Property        | Value                                             |
| --------------- | ------------------------------------------------- |
| Chain ID (dec)  | `143`                                             |
| Chain ID (hex)  | `0x8f`                                            |
| Chain name      | `Monad Mainnet`                                   |
| Native token    | `MON`                                             |
| RPC (primary)   | `https://rpc.monad.xyz`                           |
| RPC (fallback)  | `https://rpc-mainnet.monadinfra.com`              |
| Explorer base   | `https://monadexplorer.com`                       |
| Tx link format  | `https://monadexplorer.com/tx/{hash}`             |
| Block explorer tx lookup | `.../api?module=proxy&action=eth_getTransactionReceipt` |

Both RPCs were probed and return chain id `0x8f`. Two exist because mainnet
public endpoints rate-limit harder than testnet ones; `rpcUrls[0]` is what gets
offered to `wallet_addEthereumChain`.

`MONAD_TESTNET` (10143) is **retained but not live**. It exists so a
faucet-safe path survives for debugging a broken mainnet integration. Nothing in
`app/`, and nothing on the live path in `lib/`, may reference it — a testnet
orderbook address means nothing on mainnet, because Kuru deploys a separate
orderbook per chain.

### 3.1 Mainnet rules

These are the constraints that did not exist under testnet. They are
non-negotiable for the same reason §4's rules are.

- **Never `MaxUint256`.** `ensureAllowance` approves the exact amount the batch
  needs. An unlimited approval is a standing permission for the orderbook to move
  any amount of the operator's tokens, for as long as the contract lives, and it
  survives across sessions with no UI ever showing it. The extra signature on a
  second deploy is the correct trade.
- **Market constraints are read, never assumed.** `fetchMarketConstraints`
  derives tick size and min/max size from `getMarketParams` on-chain. The live
  MON/USDC market reports **`minSize` = 200 MON** and `sizePrecision` 1e10, both
  very different from plausible-looking hard-coded guesses. A ladder sized under
  a wrong assumption reverts, leg by leg.
- **Check conformance before asking for a signature.**
  `checkGridAgainstMarket` runs in the preview so an illegal grid is refused
  *before* the wallet queue fills. `placeParallelKuruOrders` still re-checks
  inside the burst — the panel check is a courtesy to the operator, not the
  guarantee.
- **A tick snap is not a violation.** An off-tick price is repaired
  deterministically by the broadcast path (at most half a tick). Only a size
  outside the market's bounds is fatal. Conflating the two once blocked the
  app's own default grid on 8 of 12 legs over a $3e-8 rounding.

**Kuru market address** lives in `DEFAULT_MARKET_ADDRESS` in
`lib/constants.ts`, overridable at build time with
`NEXT_PUBLIC_KURU_MARKET_ADDRESS`. It is resolved defensively at runtime —
`lib/kuruClient.ts` calls `ParamFetcher.getMarketParams()` before broadcasting
and surfaces a clear, actionable error if the address has no orderbook deployed.
See §7.

`KURU_MON_USDC_MARKET` (the orderbook) and `KURU_USDC_TOKEN_MAINNET` (the
ERC-20 quote token) are named separately in `constants.ts` on purpose. Putting
the USDC token in the market field yields an address that *has* code, so a
`getCode` probe passes and the failure only surfaces later as "no orderbook
here". The quote address the app actually uses is read from `getMarketParams`,
never from the constant.

---

## 4. Hard architectural constraints

These are non-negotiable. A change that violates one of these is a **regression**,
even if the UI looks nicer.

### 4.1 Zero custom backend

There is no server. Next.js runs in **static-export** mode for this app
(`output: "export"` is set in `next.config.mjs`; the build emits `out/`, and
`npm start` is not the way to serve it — use `npx serve out`). No Route
Handlers, no Server Actions, no `getServerSideProps`. No Express, no API
routes, no serverless functions, no "we'll add a relay later."

Rationale: a backend would mean a signing proxy or an order relay — both of which
would (a) exceed the scope of a hackathon build and (b) undercut the entire
demonstration, which is about the *wallet* broadcasting in parallel.

### 4.2 Zero database

No Prisma, no Drizzle, no SQLite, no Postgres, no localStorage order cache, no
IndexedDB. Grid state lives in React state for the lifetime of the session and
is then discarded. Kuru's on-chain orderbook **is** the database.

The wallet module (`lib/wallet/store.ts`) holds its snapshot in a module-level
variable. That is **not** a violation: it is in-memory only, holds no
credentials, and is discarded on reload — exactly the same lifetime as the React
state it replaced, which also did not survive a refresh. There is no session
cookie and no server-side session, so there is nothing here to persist. Do not
"fix" this by adding storage; if a session is ever needed, that is a §4.1
backend question and belongs to `agent1`, not to a fix in this file.

### 4.3 Parallel execution via `Promise.allSettled`

Concurrency in this app means *fire-and-collect*, never *fire-and-forget* and
never sequential loops.

```ts
// CORRECT — every order is broadcast before the first one is awaited.
const results = await Promise.allSettled(orders.map((o) => placeOne(o)));

// WRONG — sequential, defeats the entire product thesis.
for (const order of orders) { await placeOne(order); }

// WRONG — one rejection aborts the batch and orphans the rest.
const results = await Promise.all(orders.map((o) => placeOne(o)));
```

`allSettled` (never `all`) is required so that a single rejected user signature
marks one row `FAILED` and leaves the other 49 legs live. The ladder must always
render the true per-leg outcome.

### 4.4 No `await` in a loop for broadcasting

Any `for` loop that awaits inside it is a bug. Reviewers grep for this.

---

## 5. Directory ownership map

Each agent owns a disjoint slice. Do not edit outside your slice without the
architect's sign-off.

```
/
├── AGENTS.md                    architect   — this file, keep it true
├── README.md                    pitch
├── changes.md                   agent1      — file map + change log
├── app/
│   ├── layout.tsx               frontend
│   ├── globals.css              frontend
│   └── page.tsx                 frontend    — page composition + state only
├── components/
│   ├── ConfigPanel.tsx          frontend    — inputs, telemetry, deploy button
│   ├── OrderLadder.tsx          frontend    — depth ladder
│   ├── ExecutionTimeline.tsx    frontend    — per-leg lifecycle list
│   ├── ActivityFeed.tsx         frontend    — rolling event log
│   ├── PriceSparkline.tsx       frontend    — recent mark path
│   ├── StaleBadge.tsx           frontend    — freshness readouts + tape
│   ├── Landing.tsx              frontend    — hero, connect CTA, demo entry
│   └── ConnectButton.tsx        frontend    — consumes useWallet() directly
├── lib/
│   ├── constants.ts             architect   — ALL shared types + constants
│   ├── gridEngine.ts            web3        — pure grid arithmetic
│   ├── kuruClient.ts            web3        — ethers + Kuru SDK boundary
│   ├── marketBook.ts            web3        — on-chain L2 book → mark price
│   ├── tradeFeed.ts             web3        — Trade topic sweep (the ticker)
│   ├── liveChannel.ts           web3        — optional WSS newHeads feed
│   ├── useBackgroundPoll.ts     web3        — visibility-aware poll + backoff
│   └── wallet/                  web3        — wallet module (see below)
│       ├── types.ts             web3        — no React, no runtime deps
│       ├── store.ts             web3        — no React, no module-scope window
│       ├── useWallet.ts         web3        — the ONLY file importing React
│       └── index.ts             web3        — the only public entry point
└── .opencode/agents/*.md        architect
```

`lib/marketFeed.ts` was **deleted**. The mark price is now read from the
configured Kuru orderbook on-chain (`lib/marketBook.ts`); the old Binance /
CoinGecko ETH/USDT ticker was a different asset in a different venue and cannot
be used to price a MON/USDC grid. Do not reintroduce it.

### The wallet module

`lib/wallet/` exists because the wallet address used to live in **two** places
at once — React state *and* a ref holding the provider — and they could
disagree: a network switch failing mid-connect left the ref populated with a
provider the UI did not believe in. One immutable snapshot makes that class of
bug unrepresentable.

Two invariants, both load-bearing:

- **`store.ts` imports no React and touches `window` only inside functions.**
  It is a plain observable, so it can be driven by a scratch harness with no
  DOM and no renderer. `useWallet.ts` is the only React binding.
- **`getSnapshot()` must return a stable reference between transitions.**
  `useSyncExternalStore` compares with `Object.is`; building a fresh object per
  call re-renders forever. The snapshot is replaced wholesale only inside
  `emit()`.

`lib/wallet` depends *downward* on `lib/kuruClient`, which stays the single
sanctioned `ethers` boundary. Import from `@/lib/wallet`, never from a file
inside it — `subscribe`/`getSnapshot` are plumbing, not API.

---

## 6. Definition of done

Before you hand work back:

- [ ] `npm run typecheck` passes with **zero** errors (`strict` is on).
- [ ] `npm run build` succeeds.
- [ ] No top-level `window` / `document` / `localStorage` access outside
      `useEffect` or an event handler. See §7 of `verifier.md`.
- [ ] Every `await`ed promise that can reject is either in a `try/catch` or
      inside a `Promise.allSettled`.
- [ ] Zero new runtime dependencies without architect approval.
- [ ] Zero `any` unless it is a cast at an EIP-1193 or SDK boundary, and it is
      commented with the reason.

---

## 7. Known environment caveat — be honest about it

`DEFAULT_MARKET_ADDRESS` is a **single deployment-specific constant**. Kuru deploys
a separate orderbook contract per market per chain; there is no canonical
registry address to read it from at runtime.

Therefore:

1. Default the constant to a real-looking placeholder and **document it loudly**
   in `.env.example` and the README.
2. Always let the operator override via `NEXT_PUBLIC_KURU_MARKET_ADDRESS`.
3. **Validate before broadcasting** — call `ParamFetcher.getMarketParams()` and if
   it throws, fail fast with "Kuru MON/USDC orderbook could not be loaded on
   Monad Mainnet" rather than firing 50 doomed transactions.
4. Never silently swallow this failure into the mock path. A wrong market address
   must surface as a real error, not as a cheerful fake success.

Enforced in code: the zero-address placeholder is detected by
`isUnsetMarketAddress()` and fails fast by name before any SDK load, so §7.3 is
implemented, not merely intended.

## 8. Coordinator

`agent1` decides what gets built next and dispatches it; `web3` and `frontend`
implement within their slices. Only `agent1` edits this file. If a peer needs a
contract change, they file it to `agent1`, who decides.

## 9. Environment notes (verified 2026-10-04)

Node `v26.10.0`, npm `12.2.0`. The registry on this machine is slow enough that
a plain `npm install` fails with `ETIMEDOUT`; use:

```bash
npm install --no-audit --no-fund --maxsockets=2 \
  --fetch-timeout=1800000 --fetch-retries=8 --fetch-retry-mintimeout=20000
```

A judge on a normal network will not need this. Do not delete `node_modules`
on a timeout — retry the same command.

# AGENTS.md — KuruGrid

> Operating contract for every agent working in this repository.
> Read this file completely before writing code.

---

## 1. Project objective

**KuruGrid** is a single-page, client-only trading terminal that deploys a full
**arithmetic grid ladder** onto the **Kuru CLOB** on **Monad Testnet** in a
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

## 3. Network constraints (Monad Testnet)

These are fixed. Do not "helpfully" refactor them into env vars with different
defaults, and do not add mainnet support.

| Property        | Value                                             |
| --------------- | ------------------------------------------------- |
| Chain ID (dec)  | `10143`                                           |
| Chain ID (hex)  | `0x279f`                                          |
| Chain name      | `Monad Testnet`                                   |
| Native token    | `MON`                                             |
| RPC             | `https://testnet-rpc.monad.xyz`                   |
| Explorer base   | `https://testnet.monadexplorer.com`               |
| Tx link format  | `https://testnet.monadexplorer.com/tx/{hash}`     |
| Block explorer tx lookup | `.../api?module=proxy&action=eth_getTransactionReceipt` |

Source of truth: `MONAD_TESTNET` in `lib/constants.ts`. Every other module
imports from there.

**Kuru market address** lives in `DEFAULT_MARKET_ADDRESS` in
`lib/constants.ts`, overridable at build time with
`NEXT_PUBLIC_KURU_MARKET_ADDRESS`. It is resolved defensively at runtime —
`lib/kuruClient.ts` calls `ParamFetcher.getMarketParams()` before broadcasting
and surfaces a clear, actionable error if the address has no orderbook deployed.
See §7.

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
├── app/
│   ├── layout.tsx               frontend
│   ├── globals.css              frontend
│   └── page.tsx                 frontend    — page composition + state only
├── components/
│   ├── ConfigPanel.tsx          frontend
│   └── OrderLadder.tsx          frontend
├── lib/
│   ├── constants.ts             architect   — ALL shared types + constants
│   ├── gridEngine.ts            web3        — pure grid arithmetic
│   ├── kuruClient.ts            web3        — wallet + SDK boundary
│   └── marketFeed.ts            web3        — live ticker, read-only fetch
└── .opencode/agents/*.md        architect
```

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
   it throws, fail fast with "No Kuru orderbook at this address on Monad Testnet"
   rather than firing 50 doomed transactions.
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

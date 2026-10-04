# KuruGrid — Dependency Manifest

> Companion to `PLAN.md`. Read together.
> Owner policy for what may be added lives in `.opencode/agents/architect.md` §A3
> and `AGENTS.md` §4.1–4.2. **This list is closed.**

---

## 1. Runtime dependencies

| Package | Pinned | Why it is here | What it does **not** need to do |
| --- | --- | --- | --- |
| `next` | `^14.2.35` | App Router. `app/` directory, React Server Components for the shell, static-friendly build. | It runs no backend. No Route Handlers, no Server Actions, no API routes (`AGENTS.md` §4.1). |
| `react` | `^18.3.1` | Peer of Next 14. `page.tsx` is a client component because it owns wallet + ladder state. | Not using Suspense streaming tricks or RSC data fetching for the grid. |
| `react-dom` | `^18.3.1` | React peer. | — |
| `ethers` | `~5.7.2` | EIP-1193 `Web3Provider` bridge to MetaMask, `BigNumber`, `Contract` for the ERC-20 allowance check. | **v5, not v6.** `@kuru-labs/kuru-sdk` pins `ethers@5.7.1` internally; v6 breaks its types. See §4. |
| `@kuru-labs/kuru-sdk` | `^0.0.95` | `ParamFetcher.getMarketParams` (market validation + decimals) and `GTC.placeLimit` (order broadcast). | Loaded via **dynamic `import()`**, never a static top-level import — keeps it out of the SSR graph and provides the mock-fallback seam. |
| `lucide-react` | `^1.52.0` | ~1,500 icons. Header, ladder, status pills, empty state. | No hand-rolled inline SVG icons. |
| `canvas-confetti` | `^1.9.3` | One celebration burst after a successful batch. | Fired **once**, only when `successCount > 0`. Not on mount, not in a re-firing effect. |

## 2. Development dependencies

| Package | Pinned | Why |
| --- | --- | --- |
| `typescript` | `^5.6.3` | `strict` + `noUncheckedIndexedAccess`. `npm run typecheck` is a gate, not a suggestion. |
| `@types/node` | `^20.14.10` | `process.env`, Node globals in build config. |
| `@types/react` | `^18.3.11` | Must stay on **18.x** to match `react@18`. |
| `@types/react-dom` | `^18.3.0` | Matches `react-dom@18`. |
| `@types/canvas-confetti` | `^1.9.0` | Ships no types. |
| `tailwindcss` | `^3.4.13` | **v3, not v4.** v4 moves config into CSS (`@theme`) and changes the PostCSS plugin to `@tailwindcss/postcss`. v3's JS config is what `tailwind.config.ts` already defines. |
| `postcss` | `^8.4.47` | Tailwind's build pipeline. |
| `autoprefixer` | `^10.4.20` | Vendor prefixing for the few `backdrop`/`appearance` uses. |

---

## 3. Versions verified against the npm registry

All pins were confirmed to exist. Two corrections surfaced during verification and
are folded into the table above:

| Finding | Resolution |
| --- | --- |
| `next@^14.2.15` resolves only within `14.2.x`, but `14.2.15` predates several published Next 14 security patches. | Bumped floor to `^14.2.35` (current 14.x). |
| `lucide-react` latest is `1.52.0`. A caret on `0.454.0` pins to the `0.454.x` line only, stranding us on a pre-1.0 release. | Bumped to `^1.52.0`. `1.52.0` declares `react: ^16.5.1 \|\| ^17 \|\| ^18 \|\| ^19`, so React 18 is supported. |
| `ethers` latest is `6.17.0`. | Deliberately **not** taken. See §4. |
| `typescript` latest is `7.0.0`; `@types/react` latest is `19.3.0`. | Not taken — both would break the React 18 / Next 14 pairing. |

---

## 4. The `ethers` v5 constraint (do not "modernise" this)

```
KuruGrid ──uses──> ethers@~5.7.2
        └──@kuru-labs/kuru-sdk@0.0.95 ──depends on──> ethers@5.7.1  (exact)
```

The SDK is written against v5: `providerOrSigner.getSigner()`,
`new ethers.Contract(...)`, `BigNumber`, and `extractErrorMessage` operating on
v5-shaped error objects. Because the SDK's pin is **exact** (`5.7.1`, not `^5.7.0`),
npm will install `5.7.1` nested inside the SDK even though KuruGrid asks for
`~5.7.2`. Two copies of ethers will exist in `node_modules`.

This is **tolerable and expected** — the nested copy is entirely internal to the
SDK, never crosses our import boundary, and `~5.7.2` guarantees the two copies are
patch-compatible. What we must not do:

- ❌ Upgrade to `ethers@6` — the SDK's type signatures will not compile.
- ❌ Add `ethers@6` as an alias for "new code" — two majors with incompatible
  `BigNumber` semantics in one bundle is a correctness bug waiting to happen.
- ❌ Add `viem` or `wagmi` as a "cleaner" alternative — banned by `architect` §A3
  (wallet abstraction), and it would leave the SDK still needing v5 anyway.

Use `~5.7.2` (tilde), not `^5.7.2`. The tilde is the honest constraint: it means
"5.7.x, never 6."

---

## 5. Explicitly banned

Per `AGENTS.md` §4.1–4.2 and `architect.md` §A3. Any of these appearing in a diff is
a rejected change.

**Backend / persistence — banned outright:**

`express` · `fastify` · `next` API routes · Server Actions · `@vercel/*` functions ·
`prisma` · `drizzle-orm` · `typeorm` · `mongoose` · `pg` · `mysql2` · `sqlite3` ·
`better-sqlite3` · `ioredis` · `idb` · `dexie`

**HTTP / state — banned, platform APIs suffice:**

`axios` (already present transitively inside the SDK; **never** import it directly) ·
`swr` · `@tanstack/react-query` · `redux` · `@reduxjs/toolkit` · `zustand` ·
`jotai` · `recoil` · `mobx`

**Wallet — banned, EIP-1193 directly:**

`wagmi` · `viem` · `@rainbow-me/rainbowkit` · `@web3modal/*` · `web3-react` ·
`@metamask/sdk`

**Formatting / utility — banned, ~15 lines beats a dependency:**

`clsx` · `classnames` · `class-variance-authority` · `tailwind-merge` ·
`date-fns` · `dayjs` · `lodash` · `ramda` · `numeral` · `big.js` · `decimal.js`

**Charts — banned, the ladder is DOM:**

`recharts` · `chart.js` · `d3` · `echarts` · `lightweight-charts`

**Why `date-fns` is banned when the UI shows latency:** latency is measured with
`performance.now()` and rendered as milliseconds with `.toFixed(0)`. There is no
date in this application.

---

## 6. Known dependency-adjacent risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Kuru SDK is **CommonJS** and statically `require`s `axios` + `cross-fetch`. Under a bundler this is fine, but it inflates the client chunk. | Minor | Dynamic `import()` inside `kuruClient.ts` keeps it out of the initial bundle. Confirmed the SDK is CJS-only (`main: dist/index.js`, no `module`/`exports` field). |
| `log10BigNumber` in the SDK derives decimals from `pricePrecision`. If a market ever had `pricePrecision = 1`, it **throws** `Log10 of zero is undefined`. | Major | Read decimals via a guarded helper that rejects `precision <= 1` with a clear message instead of letting the SDK throw opaquely. |
| SDK's `placeLimit` calls `transaction.wait(1)` — it confirms against block 1. On a chain with slower finality this could block longer than expected. | Minor | Monad testnet is sub-second; still, the batch duration metric must tolerate a long tail. Do not add a client-side timeout that leaves rows stuck in `PLACING`. |
| `next` + `noUncheckedIndexedAccess` + `lucide-react` v1 types. | Minor | `npm run typecheck` is the gate. If a v1 icon export is missing, the fix is to substitute a different icon — **not** to add a `// @ts-ignore`. |
| Two ethers copies in `node_modules` (§4). | Informational | Expected. Documented. |

---

## 7. Install & verify

```bash
npm install
npm run typecheck     # must be zero errors
npm run lint
npm run build
```

Scripts defined in `package.json`:

| Script | Command | Gate? |
| --- | --- | --- |
| `dev` | `next dev` | — |
| `build` | `next build` | yes |
| `start` | `next start` | — |
| `lint` | `next lint` | yes |
| `typecheck` | `tsc --noEmit` | **yes — non-negotiable** |

`.env.local` (copy from `.env.example`) is required for a real deployment run:

```
NEXT_PUBLIC_KURU_MARKET_ADDRESS=0x<kuru MON/USDC orderbook on Monad Testnet>
```

Both variables are `NEXT_PUBLIC_*` — there are no secrets anywhere in this
project, which is exactly what a zero-backend client-side app should look like.

---

## 8. Change protocol

To add a dependency you must, in writing:

1. Show that the platform API and the existing tree cannot do it
   (`architect.md` §A3, four-step checklist).
2. Confirm it is not on the §5 ban list.
3. State the bundle/runtime cost.
4. Get architect sign-off — the change is then reflected in this file.

To **remove** one: no sign-off needed. Prefer the platform API.

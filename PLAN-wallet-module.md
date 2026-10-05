# Plan — Wallet module + homepage login/auth surface

> Planning only. No files in `lib/`, `app/`, or `components/` were modified to
> produce this document.
>
> Repo: KuruGrid · Next.js 14 static export · React 18.3 · ethers v5 ·
> Kuru CLOB on Monad Testnet (chain 10143).

---

## ⚠️ Ambiguity that must be resolved before implementation

**This project has no "login".** Grepping the tree for `siwe`,
`signMessage`, `personal_sign`, `auth`, `session`, `login` returns **zero
matches** outside a comment about nonces and a comment about session lifetime.
There is no user model, no token, no cookie, no route protection, and no second
page — `app/` contains only `layout.tsx`, `globals.css`, `page.tsx`.

So "login and wallet integration" is one of three different things. They have
very different costs and only one is defensible here:

| Reading | What it means | Verdict |
| --- | --- | --- |
| **A. Wallet connect = "login"** | Identity *is* the address. "Login" is a UX label on `eth_requestAccounts`. No server, no session. | **Recommended.** Consistent with `AGENTS.md` §4.1/§4.2. |
| **B. Real auth (SIWE)** | Sign a nonce, verify it server-side, hold a session. | **Conflicts with the repo contract.** Needs a backend + nonce store + expiry. `AGENTS.md` §4.1 bans it. Would require an architect decision. |
| **C. Token-gated pages** | `app/login`, `app/dashboard`, route guards, `/` redirecting. | **Not viable as stated.** `output: "export"` emits flat static HTML; there is no server to redirect or guard. Adding a second route is possible but adds no product value. |

**This plan assumes A**, with the homepage work being a real landing surface
(explaining the thesis, one-click demo, connect CTA) and the module work being a
clean extraction of wallet state out of `app/page.tsx`.

**Assumptions to confirm:** (a) reading A is what you want; (b) the homepage
replaces the current single-screen terminal rather than sitting beside it —
the terminal *is* the demo and moving it behind a login gate would break
`handleLoadDemo` and every judge without a wallet.

---

## Objective

Extract all wallet/EIP-1193 concerns from `app/page.tsx` into a standalone
`lib/wallet/` module exposing a `useSyncExternalStore`-based hook, and add a
landing surface above the existing terminal so a first-time visitor understands
the thesis and can connect (or run the dry-run demo) in one click.

Success: `app/page.tsx` holds no `window.ethereum`, no `accountsChanged`
listener, and no wallet `useState`; it consumes one hook. No behaviour changes.

---

## Current State

### Wallet logic is scattered across three files

**`lib/kuruClient.ts` (865 lines)** — the wallet boundary, mixed with Kuru:
- `WalletConnection` (L145) — `{ provider, address }`
- `connectWallet()` (L156) — `eth_requestAccounts` → ethers `Web3Provider`
- `checkAndSwitchNetwork()` (L235) — the 7-step switch flow
- `normaliseChainId()` (L204), `isUserRejection()` (L109), `messageOf()` (L118)
- `EIP1193_ERROR` / `eip1193CodeOf` imported from `lib/constants.ts`

**`app/page.tsx` (744 lines)** — wallet state and listeners, inline:
- `address`, `chainId`, `connecting` as `useState` (L74, L75, L80)
- `walletRef` holding `WalletConnection | null` (L92)
- A 30-line `useEffect` subscribing to `accountsChanged` / `chainChanged` with
  `removeListener` cleanup (L339–372)
- `handleConnect()` (L376) composing connect + chain switch
- `walletRef.current.provider` read at L252, L313, L443 to choose a provider

**`components/ConfigPanel.tsx`** — takes `address`, `chainId`, `onConnect` as
props and renders the button.

### The duplication that motivates the module

`page.tsx` keeps the address in `useState` *and* in `walletRef`. They can
disagree: `onAccountsChanged` sets `setAddress(null)` **and** clears
`walletRef`, but `checkAndSwitchNetwork` failing mid-connect leaves
`walletRef.current` populated with a stale provider while `address` was never
set. The provider-selection sites then read a wallet the UI does not believe is
connected.

There is also no `connect()`/`disconnect()` pair — disconnect happens as a side
effect of the listener, so there is no single place that owns the transition.

### What already exists to reuse

- `bugs.md` **O6** already recommends exactly this: *"The wallet event listeners
  could be abstracted into a custom hook using `useSyncExternalStore`, which is
  the React-recommended pattern for subscribing to external data sources."*
- `EIP1193_ERROR.INTERNAL` (`-32603`) is wired into `eth_chainId` failure as
  *"The wallet is locked."*
- `toKuruGridError()` already maps `4001` → *"You rejected the request."*
- `isUnsetMarketAddress()` for the market gate.
- React 18.3 — `useSyncExternalStore` is stable, no shim needed.

---

## Proposed Architecture

```
lib/wallet/
├── types.ts        WalletAccount, WalletStatus, WalletSnapshot, WalletActions
├── store.ts        framework-free store: getSnapshot, subscribe, actions
├── errors.ts       wallet-specific message mapping (thin wrapper on constants)
├── useWallet.ts    'use client' React bindings — the only file importing React
└── index.ts        public surface

app/page.tsx        consumes useWallet(); no window.ethereum, no listeners
components/Landing.tsx   new — hero + connect CTA + demo button
components/ConnectButton.tsx  new — extracted from ConfigPanel's header button
```

**Layering rule:** `store.ts` imports **nothing** from React and nothing from
`ethers`. It owns a plain immutable snapshot object and an emitter. `useWallet.ts`
is a thin `useSyncExternalStore(store.subscribe, store.getSnapshot)` plus
action wrappers. This is what makes the store unit-testable with no DOM and no
React — which matters, because the repo has **no test runner** (`agent1.md` §6
decision 4), so testability-by-construction is the only real testing story
available.

**Why not just a hook with `useState` inside:** the store is a module singleton,
so the wallet survives component remounts and can be read from anywhere without
prop drilling. This is the difference between a *module* and a hook file, and it
is what lets `ConfigPanel` read wallet state without `page.tsx` threading it.

**Where `ethers` lives:** `store.ts` must not import `ethers`, but it needs a
provider to hand to callers. Options: (a) keep provider construction in
`kuruClient.connectWallet` and have the store call it; (b) move construction in.
**Recommendation: (a).** `kuruClient` is the sanctioned `ethers` boundary
(`AGENTS.md` §5) and already owns the EIP-1193 cast. The new module depends
*downward* on it rather than duplicating the boundary. `lib/wallet` therefore
imports `kuruClient` — a new dependency edge, but downward and one-way.

### Trade-offs, stated plainly

- **Adds a layer.** Four small files where there was inline code. Justified only
  if the module is actually reused by more than `page.tsx`. It will be: `Landing`
  and `ConnectButton` both need it. If the homepage is dropped, this becomes
  indirection for its own sake and should be reverted.
- **Module singleton is global state.** `AGENTS.md` §4.2 bans `localStorage` and
  a DB; this is neither — it is in-memory, discarded on reload, same as today's
  `useState`. Consistent with "grid state lives in React state for the lifetime
  of the session."
- **SSR safety is unchanged but must be preserved.** `store.ts` may reference
  `window` only inside functions, never at module scope, or the static-export
  build breaks (`verifier.md` V2).

---

## Implementation Steps

### Step 1 — `lib/wallet/types.ts` (new, no deps)

`WalletStatus = "disconnected" | "connecting" | "connected" | "error"`.

`WalletAccount`: `{ address: string; chainId: number }` — superset of today's
split `address`/`chainId` state, so the two can no longer disagree.

`WalletSnapshot`: `{ status; account: WalletAccount | null; error: string | null;
provider: providers.Web3Provider | null }` — one immutable object, replaced
wholesale. `error` is a **string**, matching what the UI already renders;
`toKuruGridError` stays the only place that decides the message.

`WalletActions`: `{ connect; disconnect; clearError; getProvider }`.

Depends on: nothing. Step 2 depends on this.

### Step 2 — `lib/wallet/store.ts` (new, imports `kuruClient` + `constants` only)

Module-level `let snapshot: WalletSnapshot` and `let listeners = new Set<() => void>()`.

- `getSnapshot(): WalletSnapshot` — returns the current object. **Must return a
  stable reference between changes**, or `useSyncExternalStore` re-renders
  forever. This is the single most important implementation detail in the module.
- `subscribe(listener): () => void` — add to the set, return a remover.
- `emit()` — private; builds the next snapshot and notifies.
- `connect()` — guard against concurrent entry (a `connecting` flag checked
  synchronously, mirroring the existing `deployingRef` pattern at
  `page.tsx:395`), then `connectWallet()` + `checkAndSwitchNetwork()` from
  `kuruClient`, then emit `connected`. On throw, emit `error` with
  `toKuruGridError(cause, "Wallet connection failed.").message`.
  **Never retries `4001`.**
- `disconnect()` — emit `disconnected`, clear `account` **and** `provider`
  together, in one transition. This is the invariant fix from §Current State.
- `subscribeChainEvents()` — the `accountsChanged` / `chainChanged` wiring moved
  verbatim from `page.tsx`, registered lazily inside `connect()` and torn down in
  `disconnect()`. Chain hex normalised with `Number.parseInt(raw, 16)`.

`window.ethereum` accessed only inside `connect()`/`subscribeChainEvents()`.

Depends on: Step 1. Step 4 depends on this.

### Step 3 — `lib/wallet/useWallet.ts` (new, the only React file)

```ts
"use client";
export function useWallet(): WalletSnapshot & WalletActions {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return useMemo(() => ({ ...snap, connect, disconnect, clearError, getProvider }),
                 [snap]);
}
```

- `getServerSnapshot` returns the **static disconnected** snapshot so SSR and
  first client render agree (`verifier.md` V2). Without it this is a hydration
  mismatch.
- Actions are module-level stable functions, not recreated per render — they must
  not be in the `useMemo` deps.

Depends on: Steps 1–2. Step 5 depends on this.

### Step 4 — `lib/wallet/index.ts` (new) — barrel re-export

One public surface, so `page.tsx` and both new components import from
`@/lib/wallet` and never reach into a file directly.

Depends on: Steps 1–3.

### Step 5 — `app/page.tsx` (modify)

- Delete: `address`/`chainId`/`connecting` state, `walletRef`, the entire
  listener effect (L339–372), and the body of `handleConnect`.
- Add: `const wallet = useWallet();`
- Replace the three `walletRef.current !== null ? walletRef.current.provider : getTelemetryProvider()`
  sites with `wallet.provider ?? getTelemetryProvider()`.
- `handleDeploy`'s guard becomes `wallet.status !== "connected"`.
- Pass `wallet.account?.address ?? null`, `wallet.account?.chainId ?? null`,
  `wallet.onConnect` into `ConfigPanel` — **the prop shape stays identical**, so
  `ConfigPanel` needs no changes at all.
- Errors: keep the existing rose banner; feed it `wallet.error`.

**Do not** restructure anything else in this 744-line file. The deploy handler,
the five polling effects, and the activity feed are out of scope.

Depends on: Step 4.

### Step 6 — `components/ConnectButton.tsx` (new, extracted)

Move the header connect button (currently `page.tsx:609–622`) verbatim:
`Wallet` icon, `connecting` → `"Connecting…"`, else `"Connect"` or
`${address.slice(0,6)}…${address.slice(-4)}`, `disabled` while connecting.

Consumes `useWallet()` directly — **not** props. This is the payoff of the
module: the button no longer needs `address`/`connecting` threaded through.

### Step 7 — `components/Landing.tsx` (new)

Above the existing terminal grid. Contains: the `Zap`/`APP_NAME` mark, a
one-line thesis (parallel burst → whole ladder live in one gesture), the three
Monad pillars, `ConnectButton`, and a **"Run the demo without a wallet"**
button wired to the existing `handleLoadDemo`.

**`handleLoadDemo` must stay reachable with no wallet.** The existing
`handleLoadDemo` (`page.tsx:526`) sets `dryRun = true` and a preset grid — it is
the single most important judge affordance in the app and it must not end up
behind a login gate. `Landing` receives `onLoadDemo` as a prop from `page.tsx`
rather than importing it, keeping `page.tsx` the owner of grid state.

Depends on: Steps 5–6.

### Step 8 — wire `Landing` into `app/page.tsx`

Render above `<div className="grid gap-6 lg:grid-cols-[380px_1fr]">`. No route
change, no `layout.tsx` change, no new file in `app/`.

Depends on: Step 7.

---

## Testing

There is **no test runner** in this repo (`agent1.md` §6 decision 4 — the
dependency list is closed and `node --test` cannot load these modules). So:

**Automated gates (must all pass):**
```bash
npm run typecheck   # strict + noUncheckedIndexedAccess
npm run lint        # react-hooks/exhaustive-deps included
npm run build       # static export emits out/
```

**Structural greps** (these are the real regression suite here):
```bash
grep -rn "window.ethereum" app components      # must be EMPTY after this change
grep -rn "accountsChanged\|chainChanged" app   # must be EMPTY
grep -rn "Promise.all(" lib app components     # must be empty
grep -rn ": any\|as any" lib app components    # must be empty
grep -rn "localStorage\|suppressHydrationWarning" app components   # empty
```

**Manual, and each maps to a specific failure mode:**

1. Reject the connect popup → `status: "error"`, message *"You rejected the
   wallet connection."* No retry, no crash, no red app-error framing.
2. Reject the network-switch popup → *"You rejected the network switch."*
3. Lock MetaMask, then connect → *"The wallet is locked."* (the `-32603` path)
4. Connect on the wrong chain → switch prompt fires, badge flips to Monad.
5. Switch accounts in MetaMask while connected → header address **and**
   `ConfigPanel` gate update together; no stale provider is handed to
   `handleDeploy`.
6. Disconnect in MetaMask → address clears, `provider` clears, deploy button
   returns to `Connect Wallet First`.
7. **Reload mid-session** → back to disconnected. This proves nothing persisted
   (§4.2).
8. Open `Landing` with no wallet installed → *"Run the demo without a wallet"*
   works, full ladder simulates, badge reads `SIMULATED`.
9. With no `NEXT_PUBLIC_KURU_MARKET_ADDRESS` → deploy still blocked with the
   `.env` remediation (the `isUnsetMarketAddress` gate must survive the refactor).
10. `npx serve out` and click through — proves SSR-safe store.

**Hydration check:** view-source on the built `out/index.html` must show the
disconnected header markup. If it shows an address, `getServerSnapshot` is wrong.

---

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| **`useSyncExternalStore` infinite re-render** if `getSnapshot` returns a fresh object each call | High if done naively — this is the classic failure | Mutate one module-level object, replace it only in `emit()`. Verify with a render-count assertion during manual test 5. |
| **Hydration mismatch** from reading `window.ethereum` during the first client render | Medium | `getServerSnapshot` returns the static disconnected snapshot. `window` only inside functions, never at module scope. |
| **`Landing` gates the demo** and a judge with no wallet sees an empty page | Medium — this is the worst outcome for the hackathon | Step 7 keeps the dry-run button above the fold; explicit manual test 8. |
| **Refactor breaks the `handleLoadDemo` / `dryRun` path** | Medium | `Landing` receives `onLoadDemo` as a prop. Never import grid state into it. |
| **`ConfigPanel` prop drift** | Low | Step 5 keeps the prop shape identical — zero changes to `ConfigPanel`. |
| **New `lib/` module violates the `AGENTS.md` §5 ownership map** | Medium — the map does not list `lib/wallet/` | Needs `agent1` to update `AGENTS.md` §5. Currently `web3` owns `lib/*`; this module is `web3`'s, so it is in-scope, but the map must be amended. |
| **Silent scope creep into real auth** (SIWE, nonces, sessions) | Low if reading A holds, high if the user meant B | Stated as ambiguity up front. If B is wanted, it needs an architect decision *before* any code — it requires a backend and a nonce store, both banned by §4.1/§4.2. |
| **`/login` route cannot work** under `output: "export"` | Certain, if attempted | No new route. There is no server to redirect or guard. `out/` is flat static HTML. |

---

## Files To Change

**New** — `lib/wallet/types.ts`, `lib/wallet/store.ts`, `lib/wallet/useWallet.ts`,
`lib/wallet/index.ts`, `components/Landing.tsx`,
`components/ConnectButton.tsx`

**Modified** — `app/page.tsx` (remove wallet state + listeners; consume hook;
render `Landing`)

**Unchanged (deliberately)** — `lib/kuruClient.ts`, `lib/constants.ts`,
`components/ConfigPanel.tsx`, `components/OrderLadder.tsx`, `app/layout.tsx`,
`next.config.mjs`, `package.json`

**Docs to amend** — `AGENTS.md` §5 ownership map (`agent1` only),
`AGENTS.md` §4.2 if the store is judged to need a persistence caveat,
`README.md` (add the landing section), `bugs.md` (close O6)

---

## Execution Order

1. **Step 1** — `types.ts`. Trivial, no dependencies, no risk.
2. **Step 2** — `store.ts`. The real work: snapshot stability and the
   connect/disconnect transition. Do not start Step 3 until the
   disconnect-clears-provider invariant is right.
3. **Step 3** — `useWallet.ts`. Small; the `getServerSnapshot` detail is the
   whole risk.
4. **Step 4** — barrel. Mechanical.
5. **Gate** — `typecheck` + `lint` + `build` + the structural greps, with
   `page.tsx` still untouched. Nothing downstream should start on a red gate.
6. **Step 5** — migrate `page.tsx`. Then **Gate again**, plus manual tests
   1–7 and the hydration check. This is the step most likely to surface a
   behavioural regression.
7. **Step 6** — `ConnectButton`, replacing the inline header button.
   **Gate** again.
8. **Steps 7–8** — `Landing`. Last, because it is the only step with a
   demo-visibility risk and the only one a reader would notice if wrong.
9. **Final** — full gate suite, `npx serve out` click-through, then the docs in
   *Files To Change*.

Steps 1–4 are additive and shippable on their own. Steps 5–8 are independent of
each other once the module exists — if the homepage is dropped, stop after
Step 5 and the module still earns its keep.

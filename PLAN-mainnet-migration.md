# PLAN — KuruGrid: Monad Testnet → Monad Mainnet

> **Status:** plan only. No code has been modified to implement this yet.
> **Scope:** convert the LIVE environment to Monad Mainnet + the real Kuru
> MON/USDC orderbook. Simulation mode, the UI, and the zero-backend
> architecture are all preserved.

---

## 1. Objective

KuruGrid's Live path currently targets **Monad Testnet** (chain 10143) against a
developer-supplied Kuru orderbook address. This plan moves that path to **Monad
Mainnet** (chain 143 / `0x8f`) against the real Kuru MON/USDC orderbook, and
makes every layer — wallet, RPC, market validation, market parameters,
orderbook, grid generation, order validation, broadcast — agree on that one
target.

The product claim is unchanged and must keep working: dozens of limit orders
go live on the Kuru CLOB in one parallel burst, signed by the user's own
wallet, with no backend and no keys on the frontend.

---

## 2. Current State (audit findings)

### 2.1 Network configuration — `lib/constants.ts`

Single network constant drives everything:

```ts
export const MONAD_TESTNET: NetworkConfig = {
  chainId: 10143, chainIdHex: "0x279f", chainName: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  blockExplorerUrls: ["https://testnet.monadexplorer.com"],
};
```

`MONAD_EXPLORER_TX_BASE` and `explorerTxUrl()` derive from it, so every
explorer link in the ladder is Testnet. `TELEMETRY_RPC_URL` falls back to
`MONAD_TESTNET.rpcUrls[0]`.

### 2.2 All Testnet touchpoints

| File | Lines | What |
| --- | --- | --- |
| `lib/constants.ts` | 11–54, 71, 199, 436 | network const, RPC fallback, explorer base, error copy |
| `lib/kuruClient.ts` | 42, 161, 208, 229–336, 370, 569, 723 | provider pinning, network switch, error copy |
| `lib/marketBook.ts` | 69 | `MARKET_NOT_FOUND` copy |
| `app/page.tsx` | 41, 254, 501–503, 733, 749, 940–941 | `onMonad` check, deploy gate, header badge, footer |
| `app/layout.tsx` | 17 | SEO description |
| `components/ConfigPanel.tsx` | 8, 103, 130 | `onMonad` check, "Switch to Monad Testnet" button |
| `package.json` | 5 | description |
| `.env.example` | 8–27 | documented endpoints |

### 2.3 `.env.local` (git-ignored, currently set)

```ini
NEXT_PUBLIC_KURU_MARKET_ADDRESS=0xD3AF145f1Aa1A471b5f0F62c52Cf8fcdc9AB55D3  # ← must go
NEXT_PUBLIC_MONAD_RPC_URL=https://distinguished-icy-dinghy.monad-mainnet.quiknode.pro/e3031232.../
# NEXT_PUBLIC_MONAD_WSS_URL=<commented out>
```

The RPC is **already** a Mainnet QuickNode URL, while the app pins chain 10143.
That mismatch is the actual live bug today: reads go to Mainnet through a
provider that believes it is on Testnet, so every on-chain assertion can
disagree with the network it is actually talking to. It also carries an
**API-key-bearing path segment**, which §4 treats as a credential.

### 2.4 Market validation — already real, and already fail-loud

This is the strongest part of the existing implementation and must not be
rewritten. `ParamFetcher.getMarketParams` is called **on-chain** in four places:

- `checkMarketStatus()` — `getCode()` + `getMarketParams` → LIVE/DEGRADED
- `checkFundingReadiness()` — params, then both token balances
- `placeParallelKuruOrders()` — params before approvals, throws `MARKET_NOT_FOUND`
- `fetchMarketBook()` (`lib/marketBook.ts`) — params, then `getL2OrderBook`

So validation already queries the contract rather than checking that an address
*looks* valid, and a wrong address already surfaces as a real error with no
mock fallback (AGENTS.md §7.4). The only change needed is the copy.

### 2.5 Dynamic market constraints — already implemented

`placeParallelKuruOrders()` derives every constraint from
`getMarketParams`, nothing hard-coded:

- `decimalsFromPrecision(pricePrecision|sizePrecision)` → price/size decimals
- `decimalsFromCount(quote|baseAssetDecimals)` → token decimals
- `tickSize` → prices snapped onto the tick grid (step 4b)
- `minSize` / `maxSize` → non-conforming legs marked `FAILED` with the reason,
  never silently dropped, never broadcast

**No minimum-order-size assumption exists** (requirement §10 is already met).
The gap to close is §9's *predictive* half: constraints are currently enforced
inside the broadcast path, so the panel does not warn *before* the operator
clicks deploy.

### 2.6 Two paths are cleanly separated

SIMULATION returns from `placeParallelKuruOrders` before the SDK loads, needs no
wallet, and is badged `dryRun: true`; LIVE requires a wallet on the right chain,
a configured market, and a passing funding preflight. Merging them would
destroy the honesty of the SIMULATED badge (changes.md §3.4). Keep them apart.

---

## 3. Proposed Architecture

Single-source-of-truth swap, no new abstractions:

1. Add `MONAD_MAINNET` and make it the **live** network. Keep `MONAD_TESTNET`
   exported but explicitly non-default so dev/test work is not destroyed.
2. Repoint every consumer at the active-network constant rather than at a
   network literal.
3. Add an `ACTIVE_NETWORK` alias so a future retarget is one edit.
4. Widen market validation so the UI can check constraints *before* deploy,
   reusing the derivation helpers rather than duplicating them.
5. Keep the zero-address sentinel as "unset" — it is a legitimate mechanism,
   but it must never be reachable as a live market.

---

## 4. Implementation Steps

### Step 1 — `lib/constants.ts`: two networks, Mainnet live

Add `MONAD_MAINNET`:

```ts
export const MONAD_MAINNET: NetworkConfig = {
  chainId: 143, chainIdHex: "0x8f", chainName: "Monad Mainnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://rpc.monad.xyz", "https://monad-mainnet.drpc.org"],
  blockExplorerUrls: ["https://monadexplorer.com"],
} as const;
```

Retain `MONAD_TESTNET` unchanged, retitled in its doc comment as
development-only.

Introduce the live selection:

```ts
export const ACTIVE_NETWORK: NetworkConfig = MONAD_MAINNET;
export const MONAD_EXPLORER_TX_BASE = `${ACTIVE_NETWORK.blockExplorerUrls[0]}/tx/`;
export const TELEMETRY_RPC_URL =
  process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? ACTIVE_NETWORK.rpcUrls[0];
```

Two RPC fallbacks because mainnet public endpoints rate-limit harder than
testnet; `rpcUrls[0]` is what gets offered to `wallet_addEthereumChain`, and a
second gives operators something to switch to.

Verify the fallback URL resolves before committing it (§17 check).

### Step 2 — `lib/constants.ts`: market address

Keep `DEFAULT_MARKET_ADDRESS` env-driven with the zero-address sentinel intact
(AGENTS.md §7 depends on `isUnsetMarketAddress`). Update its doc comment:
Mainnet, and note the ordering constraint that this is the **orderbook**, not
the USDC token.

Record the canonical pair as named constants so the two addresses can never be
swapped by accident:

```ts
export const KURU_MON_USDC_MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
export const KURU_USDC_TOKEN_MAINNET = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
```

`DEFAULT_MARKET_ADDRESS` stays env-overridable and defaults to the zero address
— a build-time literal would silently ship a wrong market to anyone who forgets
the env var, which is exactly the failure §7.4 exists to prevent. The canonical
address goes in `.env.local` and `.env.example`.

### Step 3 — `lib/kuruClient.ts`: repoint and fix copy

- Import `ACTIVE_NETWORK` instead of `MONAD_TESTNET`.
- `getTelemetryProvider()` → `ACTIVE_NETWORK.chainId` (line 208). **This is the
  single most important line**: it is what makes ethers enforce the chain.
- `checkAndSwitchNetwork()` → compare against `ACTIVE_NETWORK.chainId`, switch
  with `chainIdHex`, and register the chain with Mainnet RPC + explorer
  (lines 264–336). The 4001 / 4902 / re-verify logic is unchanged.
- Copy: replace all five "Monad Testnet" strings with Mainnet wording. The
  `MARKET_NOT_FOUND` message becomes actionable per §8:
  > "Kuru MON/USDC orderbook could not be loaded on Monad Mainnet. Check the
  > configured market address and RPC."
- `pingRpcLatency()` copy → Mainnet.

No signer is created server-side; signing stays in the wallet (§13).

### Step 4 — `lib/marketBook.ts`

Unchanged logic. `ParamFetcher.getMarketParams(provider, DEFAULT_MARKET_ADDRESS)`
already takes the configured address and `getL2OrderBook` receives the same
one, so §11 is satisfied by pointing the provider at Mainnet. Update the
`MARKET_NOT_FOUND` copy. Simulation never calls this (§12).

### Step 5 — `app/page.tsx`, `components/ConfigPanel.tsx`

Repoint the six/seven `MONAD_TESTNET` references at `ACTIVE_NETWORK` so the
`onMonad` check, the deploy gate, the header badge, the "Switch to Monad Mainnet"
button, and the footer all track the active network automatically. Update
`layout.tsx` description and `package.json` description.

### Step 6 — Market constraints surfaced before deploy (§9, §10)

Export the existing derivation from `kuruClient.ts`:

- `decimalsFromPrecision` (already exported for `tradeFeed`)
- `decimalsFromCount`
- a new `deriveMarketConstraints(params)` returning
  `{ priceDecimals, sizeDecimals, tickSizeRaw, minSizeRaw, maxSizeRaw, … }`

Add a pure, dependency-free checker in `lib/gridEngine.ts`:

```ts
export function checkGridAgainstMarket(
  orders: readonly GridOrder[], constraints: MarketConstraints,
): { conforming: number; violations: { id, reason }[] }
```

`lib/gridEngine.ts` must stay pure (imports only `./constants`), so the
constraints type lives in `constants.ts`.

Wire it in `ConfigPanel` as an amber notice **above** the deploy button:

> "The generated grid contains N orders below the market minimum size."

and block live deploy when violations exist, so no doomed signature is ever
requested. Simulation ignores constraints entirely — a mock orderbook has none.

### Step 7 — `.env.example` / `.env.local`

`.env.example` documents Mainnet RPC + WSS and the canonical market address,
with a warning that QuickNode-style URLs embed an API key and that a
`NEXT_PUBLIC_*` value ships to every browser.

`.env.local` gets the real Mainnet values. **`.env.local` stays git-ignored**
(§4); verify `.gitignore` covers it. Per §5 the key-bearing QuickNode URL is
**not** written into any committed file — only into the ignored local file.

### Step 8 — Docs

`README.md` network references → Mainnet. Historical testnet discussion
(changes.md / bugs.md / agent docs) is left alone — §6 says do not blindly
rewrite history. `AGENTS.md` §3 network table is architect-owned and should be
flagged to `agent1` rather than edited unilaterally.

---

## 5. Testing

### Static gates
- `npm run typecheck` — zero errors (`strict` + `noUncheckedIndexedAccess`)
- `npm run lint`
- `npm run build` — static export emits `out/`

### Grep gates (§17)
```
rg "10143|0x279f|testnet-rpc|testnet\.monadexplorer"   # expect only testnet-retention block
rg "D3AF145f1Aa1A471b5f0F62c52Cf8fcdc9AB55D3"           # expect zero
rg "065C9d28E428A0db40191a54d33d5b7c71a9C394"           # expect .env + constants
```

### On-chain verification (read-only, no signatures)
Against Mainnet RPC, confirm the market is real **before** trusting the UI:
- `eth_chainId` → `0x8f`
- `eth_getCode` on the market address → non-empty
- `getMarketParams` → reads precisions, tick, min/max size
- `getL2OrderBook` → non-empty book; print the real mainnet mark

This is the step that distinguishes "the constant changed" from "the
integration works", and §22 forbids claiming success without it.

### Simulation (§19)
No wallet, no funds, no transaction. Grid generates and previews; burst renders
`SIMULATED`.

### Live, stopping before signature (§20)
Connect wallet → switch to Mainnet → market validates → orderbook reads →
params read → grid generates → constraints checked → reach the signature step
and **stop**. MetaMask must still require explicit per-leg approval. Use
`eth_call`/`estimateGas` for dry verification rather than `eth_sendTransaction`.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| **Real funds at risk.** This is mainnet: a mistaken leg is a real fill. | Never auto-submit; keep the explicit per-leg wallet queue; preview-before-deploy is mandatory. |
| **Wrong chain silently.** Provider on 143 while config says otherwise. | Single `ACTIVE_NETWORK`; assert `eth_chainId` on boot and fail loud on mismatch. |
| **USDC address put in the market field** (§3's explicit trap). | Named constants + doc comments; verify the value against `getMarketParams`. |
| **Key leakage.** QuickNode URLs embed keys; `NEXT_PUBLIC_*` ships to browsers. | Key-bearing URL only in ignored `.env.local`; warning in `.env.example`; never commit. |
| **Mainnet orderbook is thinner.** Mainnet may genuinely have no book at times. | `fetchMarketBook` already throws rather than fabricating a mid; surface it, never mock it in Live. |
| **Mainnet rate limits bite harder.** | Existing 3x background poll + 8x backoff already absorb this. |
| **Constraints enforced too late.** Only inside the burst today. | Step 6 pre-deploy check + block. |
| **Regressing Simulation.** | Simulation returns before the SDK loads and before any network check; gate it explicitly in testing. |
| **Public RPC unreliable.** | Two mainnet fallbacks; env override; existing backoff. |

---

## 7. Files To Change

| File | Change |
| --- | --- |
| `lib/constants.ts` | Add `MONAD_MAINNET` + `ACTIVE_NETWORK`; retarget explorer/RPC; add market + USDC constants; add `MarketConstraints` type; Testnet retained as dev-only |
| `lib/kuruClient.ts` | Repoint provider + network switch to `ACTIVE_NETWORK`; export `decimalsFromCount`; add `deriveMarketConstraints`; update copy |
| `lib/marketBook.ts` | Update `MARKET_NOT_FOUND` copy only |
| `lib/gridEngine.ts` | Add pure `checkGridAgainstMarket` |
| `app/page.tsx` | Repoint 6 network refs; wire the pre-deploy constraint check |
| `components/ConfigPanel.tsx` | Repoint 3 refs; render constraint violations; block live deploy on them |
| `app/layout.tsx` | Description → Mainnet |
| `package.json` | Description → Mainnet |
| `.env.example` | Mainnet RPC/WSS + canonical market + key warning |
| `.env.local` | Real Mainnet values (git-ignored, never committed) |
| `README.md` | Network → Mainnet |
| `AGENTS.md` §3, §5 | **Flag to `agent1`** — architect-owned |

---

## 8. Execution Order

1. Verify on-chain reality: Mainnet RPC, market code, params, book (read-only).
2. `lib/constants.ts` — networks, explorer, RPC, market constants.
3. `lib/kuruClient.ts` — provider, network switch, copy, derived constraints.
4. `lib/marketBook.ts` — copy.
5. `app/page.tsx` + `ConfigPanel.tsx` — repoint, pre-deploy constraint gate.
6. `layout.tsx`, `package.json` — copy.
7. `.env.example`, `.env.local`, verify `.gitignore`.
8. Gates: typecheck, lint, build, greps.
9. Test Simulation end to end.
10. Test Live to the signature step, stopping short of approval.
11. Report.

Steps 2–4 are the load-bearing ones; 5 is the largest UI diff and depends on
the constraint type from 3.

---

## 9. Open Questions

1. **Which Mainnet RPC fallback?** Plan proposes `https://rpc.monad.xyz` as
   primary with a DRpc backup; both must be probed before commit.
2. **Retain Testnet for dev?** Plan keeps it exported but non-default. If the
   team wants a single network, `MONAD_TESTNET` can be deleted in a follow-up —
   keeping it now costs nothing and preserves a faucet-safe path.
3. **Post-only on mainnet?** `postOnly` defaults to `true`, which is the safe
   choice with real funds. Confirm it stays.
4. **Key-bearing RPC in `.env.local`?** The current file has one. Plan leaves
   the local value in place (it is ignored) but never propagates it to a
   committed file. Confirm that is acceptable.
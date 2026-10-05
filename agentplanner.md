# KuruGrid — Agent Planner (file-level dispatch)

> **Purpose.** Turn the open findings in `bugs.md` and the verifier audit in
> `progress.md` (2026-10-04) into owned, file-level assignments. This is a
> dispatch document, not a design doc: each row names the file, the owner, and
> the change. When a row ships, `agent1` marks it and the verifier re-audits.
>
> **Sources of truth:** `AGENTS.md` (ownership map, hard constraints),
> `.opencode/agents/agent1.md` §3 (master status), `.opencode/agents/agent1.md`
> §7 (decision log), `bugs.md` (B1–B14), `progress.md` "Verifier audit"
> (BLOCKER 1–3, 3 MAJORs, 5 MINORs).
>
> **Gate before anything:** `npm run typecheck` zero errors · `npm run build`
> succeeds. A red gate outranks every row below.

---

## Rules of engagement

- Ownership per `AGENTS.md` §5 / `agent1.md` §1: `web3` writes only
  `lib/gridEngine.ts`, `lib/kuruClient.ts`, `lib/marketFeed.ts`; `frontend`
  writes only `app/` + `components/`; `architect` writes only
  `lib/constants.ts`; `pitch` writes only `README.md`; only `agent1` edits
  `AGENTS.md` and the `agent1.md` decision log; `verifier` writes nothing but
  the verdict.
- One task per agent at a time. `agent1` runs the gates and greps after every
  handoff (`agent1.md` §5).
- Correctness of what is on screen outranks polish (`agent1.md` §2 ladder 1).
- No new dependencies to make a row pass. If a row seems to need one, re-scope
  the row.
- Features F1–F8 and optimizations O1–O10 in `bugs.md` are **not scheduled**.
  `F1` (cancel-all) is explicitly out of scope; the rest wait until every
  BLOCKER/MAJOR row below is closed.

---

## Resolved decision (was blocking Phase 1)

**The mark price — DECIDED 2026-10-05: option (b).**

Decision-log entry 2026-10-04 said "live ticker (Binance → CoinGecko), midpoint
fallback," but `lib/marketFeed.ts` served ETH/USDT — a different asset in a
different venue from the MON/USDC grid. Option (a) would have been safe but
would have thrown away the best feature in the app.

**(b) wins.** The mark is the midpoint of the **real Kuru L2 orderbook** for the
configured market, read via `OrderBook.getL2OrderBook` in `lib/marketBook.ts`.
Reasons:

1. It is the price of the exact contract the grid broadcasts to. No external
   ticker can claim that.
2. It removes a live external HTTP dependency (Binance/CoinGecko) from a
   hackathon demo — so a CORS-blocked or offline judging network cannot break
   the mark price. Verified against `node_modules`: 2 `eth_call`s, prices
   already in human units.
3. It is a *better demo*: real `bestBid` / `bestAsk` / block number are shown
   next to the ladder, which is more convincing than a CEX price.

`lib/marketFeed.ts` is deleted. `app/page.tsx` derives the mark in one
expression — `book !== null ? book.mid : (lower + upper) / 2` — so the preview
and the broadcast cannot diverge. A mark outside `[lower, upper]` is no longer
an error: `calculateGridOrders` returns the honest all-bid or all-ask ladder and
`validateGridConfig` reports `markInRange: false`.

`agent1.md` §6 decision 1 must still be amended by `agent1` only.

---

## Phase 0 — Gate check (agent1, today, before any dispatch)

| # | Action | Owner | Done when |
| --- | --- | --- | --- |
| 0.1 | Run `npm run typecheck`, `npm run lint`, `npm run build`; record results | agent1 | All three green or a fix row is filed before any new work |
| 0.2 | Run the §5 greps (`Promise.all(`, await-in-loop, `Math.random`, `: any`) | agent1 | Hits triaged; real hits become rows below |
| 0.3 | Rule on the mark-price decision above | agent1 | Decision-log entry appended |

---

## Phase 1 — BLOCKER / MAJOR fixes (correctness)

| # | File | Owner | Change | Acceptance |
| --- | --- | --- | --- | --- |
| 1.1 | `lib/marketFeed.ts` | web3 | BLOCKER 2 / B1: stop returning ETH/USDT as the grid mark. Under decision (a), either delete the fetch or rename/pd expose it as `ethContextTicker` never consumed by `page.tsx`'s mark. Keep the last-good cache (B9) documented. | `page.tsx` no longer imports a price that is ETH; ticker UI, if kept, is labelled ETH/USDT context | **CLOSED 2026-10-05** |
| 1.2 | `app/page.tsx:89-90` | frontend | BLOCKER 2: mark is the range midpoint (or the Kuru-sourced MON mark under (b)). Never `ticker.price`. | Grid builds for a 0.045–0.055 MON range; no "Could not build the grid" from an ETH-priced mark | **CLOSED 2026-10-05** |
| 1.3 | `components/ConfigPanel.tsx:317` | frontend | BLOCKER 3: mode badge reads `batch.dryRun`, not the toggle; when `batch.dryRun === true` and the dry-run toggle is off, render a violet `SIMULATED — SDK fallback` notice. | A fallback run shows SIMULATED even with the toggle off | **CLOSED 2026-10-05** |
| 1.4 | `lib/gridEngine.ts:116,266` | web3 | MAJOR: make `requiredMonInventory` round each leg the same way `calculateGridOrders`/`summarizeGrid` sizes it (2-dp notional slice or normalise consistently — pick one and use it in both places). | `cfg(0.045,0.055,3,100)` shows 666.6 **and** broadcasts 666.6; `cfg(0.1,0.9,7,100)` and `cfg(0.045,0.055,12,1000)` agree too | **CLOSED 2026-10-05** |
| 1.5 | `lib/kuruClient.ts` (`pingRpcLatency`) | web3 | MAJOR / B2: actually apply `TELEMETRY_TIMEOUT_MS` — `AbortController` on the fetch, or `Promise.race` around the ethers call. The `inFlight` guard must not latch forever. | A hung endpoint yields a warning + dash after ~4 s, not a frozen latency badge | **CLOSED 2026-10-05** |
| 1.6 | `lib/kuruClient.ts:668` | web3 | MAJOR: live-path `durationMs === 0` must not invent `working.length * 1000`. Use `Math.max(1, durationMs)` in the denominator exactly like `runDryRun`. | 12 legs in <1 ms reports a huge-but-derived throughput via the same formula as dry run; no invented constant | **CLOSED 2026-10-05** |

Phase 1 gate: typecheck clean, build green, verifier re-runs V1–V4 with zero
BLOCKER and zero MAJOR. **MET 2026-10-05** — typecheck and lint clean, build
emits `out/`, all greps clean. Closure detail in `progress.md` (audit closure
notes) and `changes.md` §3.

---

## Phase 2 — MINOR cleanup (honesty and legibility)

| # | File | Owner | Change | Acceptance |
| --- | --- | --- | --- | --- |
| 2.1 | `lib/constants.ts` | architect | B3/B4: delete the dead duplicate `WalletConnection`; remove or wire `EIP1193_ERROR.INTERNAL` (recommend: wire it in `checkAndSwitchNetwork` so a locked wallet's `-32603` maps to a clear message). | One `WalletConnection`; no dead enum member | **CLOSED 2026-10-05** |
| 2.2 | `lib/kuruClient.ts` | web3 | B5: drop the redundant `getSigner().getAddress()` call; use the `eth_requestAccounts` address. B6: drop local `extractCode`, use `eip1193CodeOf`. B7: cache the telemetry `JsonRpcProvider` as a module singleton. B8: drop `void settled`. B13: note the SDK re-import is module-cached. B14: comment that `MaxUint256` approval is testnet-only. | No duplicate helpers; one provider instance; no `void` suppression | **CLOSED 2026-10-05** |
| 2.3 | `lib/kuruClient.ts` | web3 | Verifier MINOR: confirm dry-run pacing uses `crypto.getRandomValues`/deterministic stagger, not `Math.random`; document `minSize`/`maxSize`/`tickSize` as validated or add a pre-burst leg filter; prefer SDK `approveToken`/`getAllowance` over the hand-rolled ERC-20 ABI (handle `approveToken` returning a hash, not a receipt — verify status before proceeding); read `allowance.gte(required)` for legibility. | SDK approval helpers used; every documented gap either fixed or listed as a known limitation in README |
| 2.4 | `app/page.tsx` | frontend | B10: only set `tickDir` when the price actually changed. B12: tighten `handleSyncToMarket` to ±2–5% around the live price (or drop it). | Two fewer renders per unchanged tick; synced range is ladder-shaped, not a ±15% chasm | **CLOSED 2026-10-05** |
| 2.5 | `components/ConfigPanel.tsx` | frontend | B11: `useDeferredValue` (or ~150 ms debounce) on the config that drives grid recalculation. | Typing stays fluid; grid catches up |
| 2.6 | `README.md` | pitch | M1 (from `agent1.md` pending): README audit — `$5,000 Kuru Bounty` + Metropolis named, `NEXT_PUBLIC_KURU_MARKET_ADDRESS` required, Known limitations complete, no invented figures; update the mark-price description to match the Phase 1 decision. | README describes the code that exists | **CLOSED 2026-10-05** |
| 2.7 | `agent1.md`, `progress.md` | agent1 | Reconcile: decision-log entry for the mark decision; `progress.md` numbering vs §3; mark Phase 1/2 rows here as they close. | Docs and filesystem agree | **CLOSED 2026-10-05** |

Phase 2 gate: verifier re-audit, verdict recorded; greps clean.

**Rows 2.3 and 2.5 remain open**, deliberately:

- **2.3** is only partly done. `allowance.gte` and the `MaxUint256` mainnet
  warning landed, but `tickSize` / `minSize` / `maxSize` are *still fetched and
  never applied* — a leg off the tick grid or under the minimum reverts
  on-chain. This is now the most significant open gap in the repo and is
  tracked in `bugs.md`. The SDK `approveToken` / `getAllowance` helpers were not
  adopted; the hand-rolled ERC-20 ABI stays, because `approveToken` returns a tx
  *hash* rather than a receipt and so cannot verify `status === 1` the way the
  current code does. That trade-off should be re-examined, not assumed.
- **2.5** (`useDeferredValue` on the config driving grid recalculation) was
  skipped: with `MAX_GRID_COUNT` capped at 20 the recalculation is trivial, so
  the optimisation would add deferred-render complexity for no measured gain.
  Revisit only if the cap is ever raised.

---

## Phase 3 — Explicitly not scheduled

`F1`–`F8` (cancel-all, presets, depth chart, history, gas metric, shortcuts,
settings, config export) and `O1`–`O10` (memoized rows, consolidated
intervals, virtualization, batched row updates, `useSyncExternalStore`, grid
level cache, CSS containment, `BigInt` prices). Revisit only after Phase 2
verifier verdict is clean **and** the end-to-end proof in `agent1.md` §5
passes against a live wallet. Anything in this section that contradicts
`AGENTS.md` §4 (no backend, no DB, parallel-only broadcast) is rejected.

---

## Per-agent checklist

**web3** — `lib/marketFeed.ts` (1.1) · `lib/kuruClient.ts` (1.5, 1.6, 2.2, 2.3) · `lib/gridEngine.ts` (1.4)
**frontend** — `app/page.tsx` (1.2, 2.4) · `components/ConfigPanel.tsx` (1.3, 2.5)
**architect** — `lib/constants.ts` (2.1)
**pitch** — `README.md` (2.6)
**agent1** — Phase 0, decision on the mark, decision-log/status reconciliation (2.7)
**verifier** — gate after Phase 1 and again after Phase 2; V1–V4 verdict in the
decision log. No Phase 3 until two clean verdicts.

---

## Backlog — not built yet (scheduled candidates)

Currently deliberately unbuilt; each needs an `agent1` scope decision before a
peer touches it:

- **On-chain cancel / rebalance** — detect-and-prompt exists (adaptive bounds
  suggestion, `handleLoadDemo`); a true cancel needs a contract amendment
  (AGENTS.md §4.1/§4.2, PLAN.md "no cancel/rebalance"). Owner: `agent1`
  decides, then `web3`.
- **bugs.md F1–F8** — depth-chart view, batch history, gas-spent metric,
  keyboard shortcuts, settings panel, config export, grid-presets UI. Owner:
  `frontend` (+ `pitch` for docs).
- **bugs.md O1–O10** — `LadderRow` memo, consolidated interval scheduler,
  `useDeferredValue` on grid config, ladder virtualization, batched row
  updates during the burst, grid-level cache, CSS containment, `BigInt`
  prices. `useSyncExternalStore` (O6) is done for the wallet. Owner:
  `frontend`, `web3`.
- **Pre-demo polish** — faucet deep-link next to the funding notice; README
  screenshot of the dashboard. Owner: `frontend` / `pitch`.

## Risk mitigation plans

| # | Risk | Mitigation plan |
| --- | --- | --- |
| R-A | **Fill watching never fires** — the hand-written `OrderCreated`/`Trade` ABI signatures may not match the deployed contract | One live smoke test: deploy 2 buy legs, trigger a taker fill. If mismatch, derive the topics from the real `OrderBook.json` ABI in `node_modules/@kuru-labs/kuru-sdk/abi/` instead of hand-writing. Fallback: label confirmed legs `Placed (fill unverified)` honestly. |
| R-B | **WSS feed dark** — QuickNode free tier may not expose `newHeads` on Monad Testnet | Polling is the default; WSS is an enhancement with backoff retry and a visible `POLLING` badge. Demo off polling if the endpoint is dark; no feature may depend on the socket. |
| R-C | **MetaMask signature queue** — past ~20 legs the queue breaks and nonces can race | Keep `MAX_GRID_COUNT = 20`; demo at 10–14 legs; per-leg errors are surfaced honestly; never raise the cap for visual effect. |
| R-D | **Hydration mismatch** via the wallet store | `getServerSnapshot` returns the static disconnected snapshot; `npx serve out` + view-source must show no address. If an address renders, `getSnapshot` is not referentially stable — replace the snapshot only inside `emit()`. |
| R-E | **Funding preflight false negative** blocks a legit judge | On RPC failure the check marks the wallet underfunded and routes to Simulation. If a false negative appears, inspect the `baseAssetAddress === ZERO_ADDRESS` native-MON branch in `checkFundingReadiness`. |
| R-F | **`npm audit` noise** tempts `npm audit fix --force` | Never force — it breaks the pinned ethers v5 toolchain. Documented in README. |
| R-G | **Empty/thin orderbook** — no bids or asks, so no mid | `fetchMarketBook` throws on an empty book; UI keeps the last good snapshot, falls back to the bounds midpoint before the first one. Seed the market with a couple of test orders before judging. |
| R-H | **README overclaims** a latency/throughput figure | Every number on screen is read live from `BatchResult`/telemetry; the README describes how to read the metric, never asserts a value. |

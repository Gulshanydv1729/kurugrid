# KuruGrid

**One click → a dozen live limit orders — and Monad is the only EVM where that is actually fast.**

`Monad Testnet` · `Kuru CLOB` · `Metropolis Hackathon`

KuruGrid is a single-page, client-only trading terminal that deploys a full
arithmetic grid ladder onto the [Kuru CLOB](https://app.kuru.trade) on
Monad Testnet in a single **parallel** burst. No backend, no database, no
signing proxy — the wallet broadcasts every leg itself.

---

## Why Monad?

Grid trading needs dozens of limit orders live at once. On a **sequential
EVM**, deploying a 12-level grid means 12 wallet signatures, each waiting
on the previous block. At a 2-second block time that is roughly **24
seconds** before the grid is fully live — during which a fast market has
already invalidated half your levels. The grid is a strategy about
capturing volatility, and it was dead on arrival: it took longer to
deploy than the volatility lasted. The usual workaround is putting the bot
on a server with an unlocked signer — handing over your keys.

**On Monad**, the same 12 orders go out as one `Promise.allSettled`
burst. Monad executes EVM transactions **in parallel** with **sub-second
finality** and micro-gas, so the entire ladder is live in a fraction of
a second — with the keys still in your own wallet.

Three pillars, and only three:

- **Parallel execution** — many txs per block, not one.
- **Sub-second finality** — a filled leg settles fast enough to react within the same grid cycle.
- **Micro-gas** — a 12-tx burst costs a rounding error in fees.

Grid trading was never a strategy problem; it was a throughput problem.
Monad is the first chain where the throughput problem is solved.

## What it does

1. You configure a price range, a grid count, and capital.
2. KuruGrid computes an **arithmetic grid** — evenly spaced in price,
   equal USDC notional per level — and renders it as a depth ladder:
   green bids strictly below the mark, red asks at or above it.
3. One click broadcasts **every leg in parallel** to Kuru's orderbook.
   Each row flips `Preview → Broadcasting → Placed` live, and every
   placed leg links to a verifiable explorer receipt.
4. A telemetry card shows the proof: batch duration, legs settled, and
   **throughput in legs/second** — the number that makes Monad's
   parallelism land.

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Then open <http://localhost:3000>.

**Required:** set `NEXT_PUBLIC_KURU_MARKET_ADDRESS` in `.env.local` to a
Kuru MON/USDC orderbook address on Monad Testnet. Kuru deploys one
orderbook contract per market per chain and has no canonical registry, so
the address must come from you — copy it from the URL bar at
<https://app.kuru.trade>. Without it (or with a wrong address) KuruGrid
**fails fast before broadcasting anything**: it validates the market
on-chain via `ParamFetcher.getMarketParams()` first, so you never fire a
batch of doomed transactions.

To try the product without a funded wallet, flip **Simulation mode** in
the config panel — the full burst runs simulated and the telemetry card
badges the run `SIMULATED`.

For a live deploy you need MetaMask on Monad Testnet (chain id **10143**),
USDC for the buy legs, and MON for the sell legs. The config panel
surfaces the exact **required MON inventory** before you click.

Verification gates:

```bash
npm run typecheck   # zero errors — non-negotiable
npm run lint
npm run build       # static export → out/
```

The build is a static export (`output: "export"` in `next.config.mjs`) —
there is no server to run. Serve the bundle with:

```bash
npx serve out
```

`npm start` does not apply; `npm run dev` still works for development.

### Docker

```bash
docker build --build-arg NEXT_PUBLIC_KURU_MARKET_ADDRESS=0x… -t kurugrid .
docker run -p 8080:80 kurugrid   # open http://localhost:8080
```

Multi-stage: Node 22 Alpine builds the static export, nginx Alpine serves
`out/`. No Node runtime or backend ships in the final image.
`docker compose up --build` does the same on port 8080.

## Architecture

```
app/layout.tsx          server component — document shell + metadata
app/page.tsx            'use client' — composition root, ALL state
  ├── components/ConfigPanel.tsx   presentational (inputs, telemetry, deploy button)
  ├── components/OrderLadder.tsx   presentational (depth ladder, mark divider)
  ├── lib/gridEngine.ts            PURE arithmetic — imports only ./constants
  └── lib/kuruClient.ts          wallet (EIP-1193) + Kuru SDK boundary
lib/constants.ts        single source of truth for types + constants
```

The load-bearing code is one loop, and it is parallel — not sequential:

```ts
// Every leg is started in the same tick: .map() builds the array
// before anything is awaited.
const settled = await Promise.allSettled(
  orders.map(async (order) => {
    onUpdate(mark(order.id, "PLACING"));
    return GTC.placeLimit(signer, marketAddress, params, toLimit(order));
  }),
);
```

**`allSettled`, not `all`** — the most important technical detail in
this repo. `Promise.all` would abort the whole batch the moment one
signature is rejected, orphaning the other 11 legs. `allSettled` lets
one rejected signature mark exactly one row `FAILED` while the other 11
stay live. A mined-but-reverted receipt still resolves, so a leg only
counts as placed when `receipt.status === 1`.

Other properties worth knowing:

- **The Kuru SDK is loaded with a dynamic `import()`** inside
  `kuruClient.ts` — it is CommonJS and pulls `axios`; the dynamic
  import keeps it out of the SSR graph and off the first paint.
- **Approvals are a precondition, not part of the burst.** Buys spend
  USDC, sells spend MON; `placeLimit` does not approve tokens itself.
  Allowances are checked and topped up sequentially *before* the burst —
  parallelising them would race the same nonce.
- **`price`/`size` are passed to the SDK as decimal strings**
  (`toFixed`), never numbers — the SDK clips via `String.split('.')`.
- **No `await` inside any loop** in the broadcast path.

## Telemetry

Every figure in the UI is **measured live**, never asserted:

| Metric | Where it comes from |
| ------ | ------------------- |
| RPC latency | read-only `eth_blockNumber` round-trip to Monad Testnet RPC, polled every 5 s |
| Batch duration | `performance.now()` around the whole `allSettled` burst |
| Legs settled | `successCount + failureCount` from the real receipts |
| Throughput | legs ÷ measured batch seconds |
| Mode | `LIVE` or `SIMULATED` (dry-run runs are badged, never disguised) |

Open the telemetry card during a deploy and read the throughput off
the screen — that is the claim, measured.

## Known limitations

- **Testnet only.** Monad mainnet is not targeted; the chain id is
  pinned to 10143 (`0x279f`).
- **No persistence.** No backend, no database — by design. Refreshing
  the page clears the local ladder view; resting orders remain on Kuru
  on-chain.
- **No cancel-all / rebalance.** The grid deploys; it does not manage
  itself yet.
- **Funding preconditions.** Buy legs need USDC; sell legs need MON
  already in the wallet (the panel shows the exact required inventory).
  A grid with only USDC funded will see its sell legs revert
  honestly — the failure is shown per row, not hidden.
- **`DEFAULT_MARKET_ADDRESS` is deployment-specific.** There is no
  canonical Kuru registry to read it from at runtime; set
  `NEXT_PUBLIC_KURU_MARKET_ADDRESS` (see `.env.example`). A wrong
  address fails fast with a readable error rather than a fake success.
- **Wallet queue.** `MAX_GRID_COUNT` is 20 — a wallet limit (MetaMask
  signature queues), not a protocol limit.

## Bounty

Built for the **$5,000 Kuru Bounty** track, **Metropolis Hackathon**.

## License

MIT

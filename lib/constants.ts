/**
 * KuruGrid — shared constants and the single source of truth for types.
 *
 * Owner: `architect` (see .opencode/agents/architect.md §A2)
 *
 * Nothing in this file may import from another module. It is the bottom of the
 * dependency graph.
 *
 * ## The one rule that outranks the rest
 *
 * `ACTIVE_NETWORK` says which chain the LIVE path trades on, and it is
 * **Monad Mainnet (143)**. Every layer reads it rather than a chain literal.
 *
 * This is not stylistic. Kuru deploys a *separate* orderbook per chain, so a
 * mainnet market address is meaningless on testnet and vice versa, and the
 * previous state of this file proved the failure mode concretely: the RPC had
 * already been pointed at mainnet while `MONAD_TESTNET` (10143) was pinned as
 * the network, so the app's provider and its beliefs disagreed about which
 * chain it was on. When the network changes, change it here and nowhere else.
 */

/* ------------------------------------------------------------------ *
 * Network — Monad Testnet
 * ------------------------------------------------------------------ */

export interface NetworkConfig {
  readonly chainId: number;
  /** EIP-3085 / EIP-712 hex chain id, lowercase. */
  readonly chainIdHex: string;
  readonly chainName: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly rpcUrls: readonly string[];
  readonly blockExplorerUrls: readonly string[];
}

/**
 * Monad **Mainnet** — the LIVE network. Chain 143.
 *
 * This is the environment a real order is broadcast into, so every value here
 * is load-bearing: the chain id gates the wallet switch, `rpcUrls` is what
 * `wallet_addEthereumChain` registers, and the explorer base is what every tx
 * link in the ladder points at.
 *
 * Two public RPCs on purpose. Mainnet endpoints rate-limit far harder than
 * testnet ones, and `rpcUrls[0]` is what gets handed to the wallet, so a second
 * verified-reachable endpoint gives an operator something to fall back to
 * without reconfiguring the app. Both were probed against this chain id.
 */
export const MONAD_MAINNET: NetworkConfig = {
  chainId: 143,
  chainIdHex: "0x8f",
  chainName: "Monad Mainnet",
  nativeCurrency: {
    name: "Monad",
    symbol: "MON",
    decimals: 18,
  },
  rpcUrls: ["https://rpc.monad.xyz", "https://rpc-mainnet.monadinfra.com"],
  blockExplorerUrls: ["https://monadexplorer.com"],
} as const;

/**
 * Monad **Testnet** — chain 10143. Retained for development only.
 *
 * Not the live network. Nothing in the app reads this by default any more; it
 * stays exported so a developer can point the app at the faucet without a
 * rebuild, by flipping `ACTIVE_NETWORK` below. It must never become the live
 * path again — the two chains have entirely separate Kuru deployments, so a
 * testnet orderbook address means nothing on mainnet.
 */
export const MONAD_TESTNET: NetworkConfig = {
  chainId: 10143,
  chainIdHex: "0x279f",
  chainName: "Monad Testnet",
  nativeCurrency: {
    name: "Monad",
    symbol: "MON",
    decimals: 18,
  },
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  blockExplorerUrls: ["https://testnet.monadexplorer.com"],
} as const;

/**
 * The network the LIVE path targets. Mainnet.
 *
 * Every runtime consumer — the telemetry provider, `checkAndSwitchNetwork`,
 * the `onMonad` guard in the UI, the explorer links — reads this rather than a
 * network literal. That is what stops the app from believing it is on one chain
 * while its provider talks to another, which is precisely the bug this
 * migration had to fix: the RPC was already mainnet while `constants.ts` pinned
 * 10143. Retargeting mainnet is therefore a one-line change here.
 */
export const ACTIVE_NETWORK: NetworkConfig = MONAD_MAINNET;

/** Base URL for a single transaction on the active network's explorer. */
export const MONAD_EXPLORER_TX_BASE = `${ACTIVE_NETWORK.blockExplorerUrls[0]}/tx/`;

/** Build a clickable explorer link for a transaction hash. */
export function explorerTxUrl(txHash: string): string {
  return `${MONAD_EXPLORER_TX_BASE}${txHash}`;
}

/**
 * Read-only RPC used for the telemetry ping. The wallet's own provider is used
 * for anything that requires a signature.
 */
export const TELEMETRY_RPC_URL =
  process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? ACTIVE_NETWORK.rpcUrls[0];

/**
 * Optional WebSocket endpoint for live block/activity feed.
 * When unset, the UI falls back to HTTP polling — it must never
 * depend on a socket being available.
 */
export const TELEMETRY_WSS_URL: string | null =
  process.env.NEXT_PUBLIC_MONAD_WSS_URL && process.env.NEXT_PUBLIC_MONAD_WSS_URL !== ""
    ? process.env.NEXT_PUBLIC_MONAD_WSS_URL
    : null;

/* ------------------------------------------------------------------ *
 * Kuru market
 * ------------------------------------------------------------------ */

/**
 * !! READ THIS BEFORE CHANGING THE ADDRESS BELOW !!
 *
 * Kuru deploys ONE orderbook contract PER MARKET PER CHAIN. There is no
 * canonical registry to read this at runtime, so the address is configured —
 * and the same-looking address means nothing on the other chain.
 *
 * `KURU_MON_USDC_MARKET` is the **orderbook/market contract**.
 * `KURU_USDC_TOKEN_MAINNET` is the **ERC-20 quote token**.
 * They are different contracts and swapping them is the single most damaging
 * mistake available here: pointing the market field at the USDC token yields
 * an address that has code, so `getCode` passes, but `getMarketParams` cannot
 * answer, and the failure surfaces as "no orderbook here" long after it should
 * have been caught. They are named separately below so the two can never be
 * silently transposed.
 *
 * Verified on-chain against Monad Mainnet (chain 143):
 *   - `getMarketParams` reads: base = native MON (18 dp), quote = USDC (6 dp)
 *   - `getL2OrderBook` returns a live two-sided book
 */
export const KURU_MON_USDC_MARKET: string = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";

/**
 * The USDC **token** on Monad Mainnet — the quote asset, never the market.
 *
 * Documented here purely so the address is never confused with
 * `KURU_MON_USDC_MARKET`. It is *not* used as a default anywhere: the quote
 * asset address is read from `getMarketParams`, so the app cannot drift onto
 * the wrong token if this value goes stale.
 */
export const KURU_USDC_TOKEN_MAINNET: string = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

/**
 * The configured Kuru orderbook (market) for the active network.
 *
 * Env-overridable so an operator can point at another deployment, and
 * **defaulting to the zero address rather than to a literal** on purpose. A
 * hard-coded default would quietly ship a live-market broadcast to anyone who
 * forgot the env var; the zero address instead trips `isUnsetMarketAddress` and
 * fails fast with a remediation instead (AGENTS.md §7).
 */
export const DEFAULT_MARKET_ADDRESS: string =
  process.env.NEXT_PUBLIC_KURU_MARKET_ADDRESS && process.env.NEXT_PUBLIC_KURU_MARKET_ADDRESS !== ""
    ? process.env.NEXT_PUBLIC_KURU_MARKET_ADDRESS
    : "0x0000000000000000000000000000000000000000";

/** Human label for the market, shown in the header. */
export const MARKET_LABEL = "MON / USDC";

/**
 * Sentinel used as the `DEFAULT_MARKET_ADDRESS` placeholder.
 *
 * Kuru has no canonical registry, so an unconfigured deployment is the zero
 * address rather than a plausible-looking lie. `kuruClient` detects this exact
 * value and fails fast with the `.env` remediation instead of broadcasting 20
 * doomed transactions (AGENTS.md §7).
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** True when `address` is absent, unparsable, or the zero-address sentinel. */
export function isUnsetMarketAddress(address: string | null | undefined): boolean {
  if (typeof address !== "string") return true;
  const trimmed = address.trim();
  if (trimmed === "") return true;
  return /^0x0{40}$/i.test(trimmed);
}

/* ------------------------------------------------------------------ *
 * Grid engine limits and precision
 * ------------------------------------------------------------------ */

/**
 * Upper bound on grid levels.
 *
 * This is a *wallet* limit, not a protocol limit: every leg is a separate
 * `eth_sendTransaction` that the user must sign. MetaMask queues them, but
 * beyond ~20 the signature queue becomes unusable and demo pacing dies.
 */
export const MAX_GRID_COUNT = 20;

/** Minimum meaningful grid — one level on each side of the mark. */
export const MIN_GRID_COUNT = 2;

/** Decimal places retained for grid prices. Clipped again by the SDK to `pricePrecision`. */
export const PRICE_DECIMALS = 8;

/** Decimal places retained for grid sizes (base asset units). */
export const SIZE_DECIMALS = 4;

/**
 * Decimal places retained for a leg's USDC notional.
 *
 * This is the number the operator funds to the cent, so it is also the rounding
 * used when the slice is derived. Both `validateGridConfig` (the preview) and
 * `calculateGridOrders` (the broadcast) must round through the *same* helper —
 * when they disagreed by a ulp the panel told the operator to fund 666.6 MON
 * while the chain needed 666.6667.
 */
export const NOTIONAL_DECIMALS = 2;

/* ------------------------------------------------------------------ *
 * Telemetry polling
 * ------------------------------------------------------------------ */

/** Hard ceiling on a single read-only RPC ping, so a hung node cannot wedge the UI. */
export const TELEMETRY_TIMEOUT_MS = 4000;

/** How often the header re-pings the chain head while the tab is open. */
export const TELEMETRY_POLL_MS = 5000;

/**
 * How often the configured Kuru orderbook is re-read for the mark price.
 *
 * Deliberately slower than a CEX ticker: this is two `eth_call`s against a real
 * orderbook contract, not a REST symbol. 10 s is fast enough that a judge
 * watching the ladder sees the mark track the market, and slow enough that it
 * never crowds the RPC during a demo.
 */
export const MARKET_BOOK_POLL_MS = 10000;

/** How often the Kuru market contract is probed for LIVE/DEGRADED. */
export const MARKET_STATUS_POLL_MS = 15000;

/* ------------------------------------------------------------------ *
 * Always-on polling (24/7 liveness)
 *
 * A CLOB has no sessions and no close: the orderbook changes every block,
 * forever. "Live" therefore cannot mean "the data was correct when the tab
 * opened" — it has to mean "the screen is never more than a few seconds
 * behind the chain". The four constants below are what turn a set of
 * independent `setInterval` calls into that.
 * ------------------------------------------------------------------ */

/**
 * Poll interval used while the tab is **hidden**.
 *
 * Deliberately slower than the foreground rate rather than stopped. A hidden
 * tab is still a trading terminal — an operator alt-tabs to check a price and
 * expects the number to move while they are away — but it must not hammer the
 * public RPC at 2 Hz for an hour to prove a point nobody is watching. 3x is the
 * compromise: the mark never goes more than ~30 s behind the chain.
 */
export const BACKGROUND_POLL_MULTIPLIER = 3;

/**
 * Ceiling on consecutive-failure backoff, as a multiple of the active interval.
 *
 * A dead RPC must not be re-dialled every 2 s for the length of a demo. Capped
 * at 8x (80 s at the book interval) so recovery is still automatic and the
 * operator never has to reload the page to un-stick the terminal.
 */
export const BACKGROUND_POLL_BACKOFF_CAP = 8;

/**
 * Floor on the gap between two *head-triggered* orderbook reads.
 *
 * This one is load-bearing, not a nicety. Monad's testnet produces a block
 * roughly every 250–300 ms (measured: 11 blocks in 3 s), so naively re-reading
 * the book on every `newHeads` frame is ~3.7 reads/second — and each read is
 * two `eth_call`s (`getMarketParams` + `getL2OrderBook`), so ~7 calls/second
 * sustained against a free public endpoint for as long as the tab is open.
 * That is how a demo gets its terminal rate-limited mid-pitch, and the
 * resulting DEGRADED badge looks exactly like a broken app.
 *
 * 2 s is the compromise: ~1/8 the load, while still being 5x fresher than the
 * 10 s poll it replaces. Above the stall threshold (3 blocks) it degrades
 * gracefully into "a few seconds behind" rather than into failure.
 */
export const HEAD_REFRESH_MIN_INTERVAL_MS = 2000;

/**
 * Safety-net poll interval used **while the WebSocket is live**.
 *
 * With `NEXT_PUBLIC_MONAD_WSS_URL` set, heads drive the reads, so a 10 s poll
 * would be pure redundant load. 30 s is the net that catches a socket that has
 * gone quiet without reporting `onclose` — which is the failure a dropped
 * connection actually looks like behind a proxy.
 */
export const LIVE_FEED_FALLBACK_POLL_MS = 30000;

/**
 * After how long without a successful read a snapshot is rendered as stale.
 *
 * One missed interval is a hiccup, not news. At the 10 s book interval this is
 * three missed reads — enough that a judge reading the figure knows it is not
 * live, without flickering on a single dropped packet.
 */
export const BOOK_STALE_MS = 30000;

/** How often the market contract's `Trade` topic is swept for the ticker. */
export const TRADE_FEED_POLL_MS = 5000;

/**
 * How long the mark must sit outside `[lowerBound, upperBound]` before
 * auto-recenter moves the bounds.
 *
 * This debounce is the whole difference between a helpful feature and a
 * haunted one. A single block of noise outside the band must not yank the
 * operator's range out from under them mid-keystroke; a mark that has *settled*
 * outside the grid has genuinely invalidated it, and 30 s is long enough to be
 * sure while staying inside a demo's attention span.
 */
export const AUTO_RECENTER_DELAY_MS = 30000;

/**
 * How long the mark price keeps its up/down colour after a move.
 *
 * Long enough to register as "this just changed", short enough not to leave a
 * stale colour on a price that has since settled.
 */
export const TICK_FLASH_MS = 800;

/**
 * Half-width of the band `Sync to Market` centres on the live mark, as a
 * fraction of the mark (0.04 = ±4%).
 *
 * A grid is a tight instrument. Centring on ±15% produces a chasm with a
 * handful of levels in it; ±4% is the range a grid is actually traded over.
 */
export const SYNC_BAND_PCT = 0.04;

/* ------------------------------------------------------------------ *
 * Seed configuration
 * ------------------------------------------------------------------ */

/**
 * Values the config panel starts with.
 *
 * Seeded from constants rather than computed in the component so the server
 * render and the first client render agree — a `Date.now()` or `Math.random()`
 * default here would be a hydration mismatch (verifier.md V2).
 */
export interface GridConfig {
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly gridCount: number;
  readonly capital: number;
}

/**
 * Seed grid: a tight 12-level band around the **mainnet** MON/USDC mark.
 *
 * The bounds were retargeted with the network. The old seed (`0.045–0.055`)
 * came from the testnet market and, on mainnet, sat entirely *above* the mark
 * (~$0.031 measured against the real orderbook at migration time). Left alone
 * that is not a cosmetic problem: `markInRange` would be `false` from the very
 * first render, so every seed grid was a one-sided all-ask ladder and the
 * operator opens the app to a warning banner rather than to a grid.
 *
 * ±8% is wider than `SYNC_BAND_PCT` (±4%) on purpose — the seed has to survive
 * a few days of drift before it goes stale, and "Sync to Market" is one click
 * away from a fresh centring.
 *
 * `capital: 120` / 12 levels = $10 a slice ≈ 322 MON a leg, comfortably above
 * this market's 200 MON minimum. Raising the grid count or lowering the
 * capital is what pushes legs under it, which is precisely what the pre-deploy
 * conformance check now reports rather than discovering at broadcast time.
 */
export const DEFAULT_GRID_CONFIG: GridConfig = {
  lowerBound: 0.0286,
  upperBound: 0.0336,
  gridCount: 12,
  capital: 120,
} as const;

/* ------------------------------------------------------------------ *
 * Domain types
 * ------------------------------------------------------------------ */

/**
 * Lifecycle of a single grid leg.
 *
 * - `READY`     — computed locally, not yet broadcast (the preview state).
 * - `PLACING`   — handed to the wallet; awaiting signature and receipt.
 * - `CONFIRMED` — mined with `receipt.status === 1`.
 * - `FILLED`    — a market `Trade` event was observed matching this leg's order id.
 * - `FAILED`    — rejected by the user, reverted on-chain, or never broadcast.
 */
export type GridOrderStatus = "READY" | "PLACING" | "CONFIRMED" | "FILLED" | "FAILED";

export interface GridOrder {
  /** Stable client-side id. Deterministic per (grid, level) so re-renders don't remount. */
  readonly id: string;
  /** Limit price in quote asset (USDC) per base asset (MON). */
  readonly price: number;
  /** Order size in base asset (MON) units. */
  readonly size: number;
  /** USDC value committed at this level. */
  readonly notional: number;
  /** `true` = buy limit (green), strictly below the reference mark price. */
  readonly isBuy: boolean;
  /** Index of this level within the generated ladder, ascending from `lowerBound`. */
  readonly levelIndex: number;
  status: GridOrderStatus;
  /** Populated once the leg is mined. Drives the explorer link. */
  txHash: string | null;
  /** Human-readable failure reason. Only meaningful when `status === 'FAILED'`. */
  error: string | null;
  /** On-chain order id parsed from the placement receipt; used by the fill watcher. */
  orderId: string | null;
}

/* ------------------------------------------------------------------ *
 * Wallet / EIP-1193 boundary
 * ------------------------------------------------------------------ */

/**
 * Minimal EIP-1193 surface we depend on.
 *
 * Declared structurally rather than pulling in a wallet library — the architect
 * agent bans wallet abstraction packages (AGENTS.md §A3), and this is the only
 * part of the injected provider KuruGrid touches.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export type WalletErrorCode =
  | "NO_WALLET"
  | "USER_REJECTED"
  | "CHAIN_NOT_ADDED"
  | "WRONG_NETWORK"
  | "NETWORK_SWITCH_FAILED"
  | "RPC_ERROR"
  | "MARKET_NOT_FOUND"
  | "SDK_UNAVAILABLE"
  | "UNKNOWN";

/**
 * EIP-1193 / EIP-3085 error codes we act on.
 *
 * A frozen `const` object rather than a TypeScript `enum` — erasable syntax,
 * no runtime object, and it keeps `architect.md` A2 satisfied (string keys, no
 * enum machinery in the type surface).
 */
export const EIP1193_ERROR = {
  /** User rejected the request in the wallet. Never auto-retry this. */
  USER_REJECTED: 4001,
  /** The requested chain is not known to the wallet. The *only* trigger for `wallet_addEthereumChain`. */
  CHAIN_NOT_ADDED: 4902,
  /** Provider-internal error, e.g. a locked wallet during `eth_chainId`. */
  INTERNAL: -32603,
} as const;

/**
 * Pull the numeric `code` out of whatever a wallet rejected with.
 *
 * Wallets are inconsistent here: MetaMask rejects with an `Error` carrying
 * `.code`, but some wrappers reject with a bare `{ code, message }` object and
 * some with a JSON-RPC error nested under `.error`. Returns `null` rather than
 * throwing when there is no code, so callers can fall through to `UNKNOWN`.
 */
export function eip1193CodeOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "number") return direct;
  if (typeof direct === "string") {
    const parsed = Number(direct);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const nested = (error as { error?: { code?: unknown } }).error;
  if (typeof nested === "object" && nested !== null) {
    const nestedCode = nested.code;
    if (typeof nestedCode === "number") return nestedCode;
  }
  return null;
}

/**
 * The single, canonical "this is not a Kuru orderbook" message.
 *
 * Three call sites used to carry three near-identical strings, and they had
 * already drifted onto the wrong chain name. One exported builder means the
 * network can never be misnamed again, and — more importantly — the wording
 * tells the operator the two things they can actually fix: which address, and
 * which RPC.
 */
export function marketNotFoundMessage(): string {
  return (
    `Kuru ${MARKET_LABEL} orderbook could not be loaded on ` +
    `${ACTIVE_NETWORK.chainName} (chain ${ACTIVE_NETWORK.chainId}). ` +
    "Check the configured market address and RPC."
  );
}

/**
 * Normalised wallet/chain error. Every failure surfaced to the user is one of
 * these, so the UI never renders a raw ethers or EIP-1193 blob.
 */
export class KuruGridError extends Error {
  readonly code: WalletErrorCode;
  /** The underlying error, preserved for debugging but never rendered directly. */
  override readonly cause?: unknown;

  constructor(code: WalletErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "KuruGridError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Translate any thrown value into a `KuruGridError` with copy a human can act on.
 *
 * The single most important case is EIP-1193 `4001`: a user closing a MetaMask
 * popup is *not* an application failure, and rendering it as a red error is
 * both wrong and the single most common way a wallet demo embarrasses itself
 * (verifier.md V3). There is deliberately no retry anywhere near this call.
 */
export function toKuruGridError(error: unknown, fallbackMessage: string): KuruGridError {
  if (error instanceof KuruGridError) return error;

  const code = eip1193CodeOf(error);
  if (code === EIP1193_ERROR.USER_REJECTED) {
    return new KuruGridError("USER_REJECTED", "You rejected the request in your wallet.", error);
  }
  if (code === EIP1193_ERROR.CHAIN_NOT_ADDED) {
    return new KuruGridError(
      "CHAIN_NOT_ADDED",
      `${ACTIVE_NETWORK.chainName} is not added to your wallet yet. Add it and try again.`,
      error,
    );
  }

  // Surface the underlying message rather than swallowing it — operators need
  // the reason a leg reverted (`verifier.md` V3: no empty catch blocks).
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return "";
            }
          })();

  const message = detail && detail !== "{}" ? `${fallbackMessage} (${detail})` : fallbackMessage;
  return new KuruGridError("UNKNOWN", message, error);
}

/* ------------------------------------------------------------------ *
 * Dynamic market constraints
 * ------------------------------------------------------------------ */

/**
 * The trading constraints a Kuru market actually imposes, read from
 * `ParamFetcher.getMarketParams` — never assumed.
 *
 * Every field here is derived on-chain per market. That matters because the
 * values differ between markets and would silently invalidate a grid if they
 * were hard-coded: on the live MON/USDC book `minSize` is **200 MON** (~$6.20
 * at the current mark) and `sizePrecision` is **1e10** — not the 1e4 this app
 * assumed from its testnet market. A grid sized under the old assumption places
 * orders the market rejects outright.
 *
 * Sizes and prices are held in **raw precision units** (what the contract
 * stores), because that is the only representation in which a min-size or
 * tick-size comparison is exact. `gridEngine` converts to human units at the
 * edge.
 */
export interface MarketConstraints {
  /** Decimal places in a price (log10 of `pricePrecision`). */
  readonly priceDecimals: number;
  /** Decimal places in a size (log10 of `sizePrecision`). */
  readonly sizeDecimals: number;
  /** Decimal places in the quote token (USDC: 6). */
  readonly quoteDecimals: number;
  /** Decimal places in the base token (MON: 18). */
  readonly baseDecimals: number;
  /** Smallest legal price increment, in raw price units. */
  readonly tickSizeRaw: number;
  /**
   * Smallest legal order size, in raw base-asset units, as an exact decimal
   * **string**.
   *
   * A string, not a number, and this is load-bearing rather than fussy: the
   * live market's `maxSize` is 2e18, past `Number.MAX_SAFE_INTEGER` (2^53).
   * Widening it to a double silently drops low bits, so a "safe" numeric
   * representation of the maximum order size is a maximum order size that is
   * quietly wrong. `tickSizeRaw` stays a `number` because it is small by
   * construction (1e2 on this market) and is used in arithmetic.
   */
  readonly minSizeRaw: string;
  /** Largest legal order size, in raw base-asset units, exact. See `minSizeRaw`. */
  readonly maxSizeRaw: string;
  /** Smallest legal order size in human base-asset units (e.g. 200 MON). */
  readonly minSizeHuman: number;
  /** Largest legal order size in human base-asset units. */
  readonly maxSizeHuman: number;
}

/** Thrown by `gridEngine` for invalid configuration. Caught and rendered inline. */
export class GridConfigError extends Error {
  /** Which form field to highlight. */
  readonly field: "currentPrice" | "lowerBound" | "upperBound" | "gridCount" | "capital";

  constructor(field: GridConfigError["field"], message: string) {
    super(message);
    this.name = "GridConfigError";
    this.field = field;
  }
}

export interface NetworkCheckResult {
  readonly ok: boolean;
  readonly chainId: number;
  /** True if we actually triggered a wallet network switch during this call. */
  readonly switched: boolean;
}

/* ------------------------------------------------------------------ *
 * Batch execution
 * ------------------------------------------------------------------ */

export interface BatchResult {
  /** Wall-clock ms from broadcast start until every leg settled. */
  readonly durationMs: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly totalCount: number;
  /** Legs per second. The headline Monad-parallelism metric. */
  readonly throughput: number;
  /** True when results were simulated rather than broadcast on-chain. */
  readonly dryRun: boolean;
}

export interface PlaceOrdersOptions {
  /**
   * Simulate placement without touching the wallet. Used for offline demos and
   * for the `?dryRun=1` fallback when the SDK cannot be loaded.
   */
  readonly dryRun?: boolean;
  /** Reject orders that would cross the spread instead of taking liquidity. */
  readonly postOnly?: boolean;
}

export type OrderUpdateCallback = (orders: readonly GridOrder[]) => void;

export type MarketViolationKind = "min-size" | "max-size" | "tick-snap";

export interface MarketViolation {
  readonly id: string;
  readonly kind: MarketViolationKind;
  /**
   * `true` when the leg cannot be repaired without changing the config.
   *
   * `tick-snap` is deliberately **not** fatal, and that distinction is the
   * whole point of the field. An off-tick price is *repaired* — the broadcast
   * path snaps it onto the tick grid deterministically, by at most half a tick
   * — so refusing a live deploy over a $3e-8 rounding would block the app's own
   * default grid for no reason. A size outside the market's bounds cannot be
   * repaired at all: the operator has to change capital or level count, and
   * that is what `ok` reports on.
   */
  readonly fatal: boolean;
  /** Human-readable explanation, rendered directly in the panel. */
  readonly reason: string;
  /** Size in raw base-asset precision units, exact decimal. */
  readonly sizeRaw: string;
  /** The bound that was violated, exact decimal. */
  readonly minSizeRaw: string;
}

/**
 * Result of checking a whole ladder against a market.
 *
 * `ok` is what the deploy gate reads, and it is `true` unless a **fatal**
 * violation exists. Simulation ignores the whole thing: a mock book imposes no
 * constraints, so a ladder that would be rejected by the real market is still
 * perfectly valid to simulate — and must stay simulable, or the no-wallet demo
 * dies for a reason that has nothing to do with the demo.
 */
export interface MarketConformance {
  readonly ok: boolean;
  readonly checked: number;
  readonly conforming: number;
  readonly violations: readonly MarketViolation[];
  /** Legs whose price the broadcast path will snap onto the tick grid. */
  readonly snaps: number;
}

/* ------------------------------------------------------------------ *
 * Funding preflight
 * ------------------------------------------------------------------ */

/** Preflight result: is the connected wallet funded for this grid? */
export interface FundingCheck {
  readonly ok: boolean;
  /** Quote (USDC) the buy legs need vs what the wallet holds. */
  readonly quoteRequired: number;
  readonly quoteBalance: number;
  /** Base (MON) the sell legs need vs what the wallet holds. */
  readonly baseRequired: number;
  readonly baseBalance: number;
  /** Human-readable reason when `ok` is false. */
  readonly reason: string | null;
}

/* ------------------------------------------------------------------ *
 * Telemetry
 * ------------------------------------------------------------------ */

export interface TelemetrySample {
  /** RPC round-trip latency in milliseconds. */
  readonly latencyMs: number;
  /** Chain head at the time of sampling. */
  readonly blockNumber: number;
  readonly timestamp: number;
}

/** Live / degraded verdict on the configured Kuru market contract. */
export type MarketStatus = "LIVE" | "DEGRADED";

export interface MarketStatusReport {
  readonly status: MarketStatus;
  readonly detail: string;
  readonly checkedAt: number;
}

/**
 * The top of the **real** Kuru L2 orderbook for the configured market.
 *
 * This is the only honest mark price in the app: it is read off the exact
 * contract the grid is about to broadcast to. An external CEX ticker is a
 * different asset's price in a different venue, and using one as the mark is
 * how a grid ends up with twelve bids priced against the wrong market.
 *
 * `bestBid` / `bestAsk` are null when that side of the book is empty, which
 * happens on a thin market; `mid` is then the other side, not a midpoint of
 * nothing.
 */
export interface KuruBookSnapshot {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  /** Midpoint of the two-sided book, or the single available side. */
  readonly mid: number;
  /** Block the book was read at — proof the snapshot is on-chain and fresh. */
  readonly blockNumber: number;
  /** Resting size available at `bestBid`, in base asset units. */
  readonly bidDepth: number;
  /** Resting size available at `bestAsk`, in base asset units. */
  readonly askDepth: number;
  readonly fetchedAt: number;
}

/**
 * One sample of the on-chain mark, kept so the terminal can show the market's
 * recent path rather than a single number with no memory.
 *
 * Time is stored alongside the price because the samples are **not** evenly
 * spaced: the book is re-read on a timer *and* on every WebSocket head, so the
 * gap between two points is however long the RPC took plus whatever backoff was
 * in force. A chart that assumed uniform spacing would lie about when the
 * market actually moved.
 */
export interface MarkPoint {
  readonly mid: number;
  /** Epoch ms at which the snapshot that produced `mid` was fetched. */
  readonly at: number;
}

/**
 * Ring-buffer depth for the mark history, in samples.
 *
 * 120 samples is ~20 minutes at the 10 s foreground interval and ~60 at the
 * background rate. Long enough that the sparkline shows a trend across a demo
 * conversation, short enough that it stays a *recent* window rather than a
 * session log — and small enough to redraw every tick without a jank frame.
 */
export const MARK_HISTORY_MAX = 120;

/**
 * A trade printed on the market contract, decoded from a `Trade` log.
 *
 * The point of this type is that it is **decoded**: `price` and `size` are
 * human units, not the raw precision-scaled integers the event carries. The
 * conversion happens once, in `lib/tradeFeed.ts`, so nothing downstream has to
 * remember that the event's `uint32 price` is 1e8 times the actual quote.
 */
export interface MarketTrade {
  /** On-chain order id this trade touched. */
  readonly orderId: string;
  /** Human price per base asset (USDC per MON). */
  readonly price: number;
  /** Base-asset amount that changed hands (MON). */
  readonly size: number;
  /** `true` when the maker side was buying, i.e. the aggressor sold. */
  readonly isBuy: boolean;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly at: number;
}

/* ------------------------------------------------------------------ *
 * Presentation metadata
 * ------------------------------------------------------------------ */

export const ORDER_STATUS_META: Record<
  GridOrderStatus,
  { readonly label: string; readonly dot: string; readonly pill: string; readonly text: string }
> = {
  READY: {
    label: "Preview",
    dot: "bg-zinc-500",
    pill: "bg-zinc-800 text-zinc-400 border-zinc-700",
    text: "text-zinc-400",
  },
  PLACING: {
    label: "Broadcasting",
    dot: "bg-violet-400 animate-pulse-row",
    pill: "bg-violet-500/10 text-violet-300 border-violet-500/30",
    text: "text-violet-300",
  },
  CONFIRMED: {
    label: "Placed",
    dot: "bg-emerald-400",
    pill: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    text: "text-emerald-400",
  },
  FILLED: {
    label: "Filled",
    dot: "bg-teal-300",
    pill: "bg-teal-500/10 text-teal-300 border-teal-500/30",
    text: "text-teal-300",
  },
  FAILED: {
    label: "Failed",
    dot: "bg-rose-400",
    pill: "bg-rose-500/10 text-rose-400 border-rose-500/30",
    text: "text-rose-400",
  },
};

export const APP_NAME = "KuruGrid";
export const APP_TAGLINE = "Parallel grid execution on Monad";

/**
 * KuruGrid — shared constants and the single source of truth for types.
 *
 * Owner: `architect` (see .opencode/agents/architect.md §A2)
 *
 * Nothing in this file may import from another module. It is the bottom of the
 * dependency graph.
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

/** Base URL for a single transaction on the Monad Testnet explorer. */
export const MONAD_EXPLORER_TX_BASE = `${MONAD_TESTNET.blockExplorerUrls[0]}/tx/`;

/** Build a clickable explorer link for a transaction hash. */
export function explorerTxUrl(txHash: string): string {
  return `${MONAD_EXPLORER_TX_BASE}${txHash}`;
}

/**
 * Read-only RPC used for the telemetry ping. The wallet's own provider is used
 * for anything that requires a signature.
 */
export const TELEMETRY_RPC_URL =
  process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? MONAD_TESTNET.rpcUrls[0];

/* ------------------------------------------------------------------ *
 * Kuru market
 * ------------------------------------------------------------------ */

/**
 * Kuru CLOB orderbook (market) contract for the MON/USDC pair on Monad Testnet.
 *
 * !! IMPORTANT !!
 * Kuru deploys one orderbook contract per market per chain. There is no
 * canonical registry to read this from at runtime, so it must be configured.
 * Copy the market address from the URL bar at https://app.kuru.trade, or set:
 *
 *     NEXT_PUBLIC_KURU_MARKET_ADDRESS=0x...
 *
 * KuruGrid validates this address on-chain (via `ParamFetcher.getMarketParams`)
 * before it broadcasts anything, so a wrong value fails fast with a readable
 * error instead of firing a batch of doomed transactions.
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

/* ------------------------------------------------------------------ *
 * Telemetry polling
 * ------------------------------------------------------------------ */

/** Hard ceiling on a single read-only RPC ping, so a hung node cannot wedge the UI. */
export const TELEMETRY_TIMEOUT_MS = 4000;

/** How often the header re-pings the chain head while the tab is open. */
export const TELEMETRY_POLL_MS = 5000;

/** Poll cadence for the live market ticker. */
export const MARKET_FEED_POLL_MS = 3000;

/** Per-request timeout for a single ticker source. */
export const MARKET_FEED_TIMEOUT_MS = 4000;

/** How often the Kuru market contract is probed for LIVE/DEGRADED. */
export const MARKET_STATUS_POLL_MS = 15000;

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

export const DEFAULT_GRID_CONFIG: GridConfig = {
  lowerBound: 0.045,
  upperBound: 0.055,
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
 * - `FAILED`    — rejected by the user, reverted on-chain, or never broadcast.
 */
export type GridOrderStatus = "READY" | "PLACING" | "CONFIRMED" | "FAILED";

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
      "Monad Testnet is not added to your wallet yet. Add it and try again.",
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

/**
 * Result of a successful wallet handshake.
 *
 * Lives here rather than in `kuruClient.ts` because both the chain boundary and
 * `app/page.tsx` need it — the moment a second module needs a type it is
 * promoted to the single source of truth (`architect.md` A2).
 */
export interface WalletConnection {
  /** Checksummed-or-not account address, exactly as the wallet returned it. */
  readonly address: string;
  readonly chainId: number;
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
  FAILED: {
    label: "Failed",
    dot: "bg-rose-400",
    pill: "bg-rose-500/10 text-rose-400 border-rose-500/30",
    text: "text-rose-400",
  },
};

export const APP_NAME = "KuruGrid";
export const APP_TAGLINE = "Parallel grid execution on Monad";

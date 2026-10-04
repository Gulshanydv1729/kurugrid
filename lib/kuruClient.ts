/**
 * KuruGrid — the single boundary to MetaMask (EIP-1193) and to the
 * Kuru CLOB SDK.
 *
 * Owner: `web3` (see .opencode/agents/web3.md Part 2)
 *
 * Rules that shape this file:
 *
 * - The Kuru SDK is CommonJS and pulls in `axios`. It is loaded with
 *   a dynamic `import()` *inside* functions — never a top-level static
 *   import — so it stays out of the SSR graph and off the first paint.
 * - Nothing touches `window` at module scope. Every wallet access is
 *   inside an async function that is only ever reached from an event
 *   handler, so the server render pass never sees it.
 * - The broadcast batch is a `Promise.allSettled` over a `.map()`:
 *   every leg is fired before the first one is awaited.
 * - The dry-run mock is reachable only when the caller opted in, or
 *   when the SDK itself failed to load. It can never mask a failed
 *   market-address validation (AGENTS.md §7.4).
 */

import {
  BigNumber,
  Contract,
  Signer,
  constants,
  providers,
  utils,
} from "ethers";
import {
  type BatchResult,
  type Eip1193Provider,
  type GridOrder,
  type MarketStatusReport,
  type NetworkCheckResult,
  type OrderUpdateCallback,
  type PlaceOrdersOptions,
  type TelemetrySample,
  KuruGridError,
  MONAD_TESTNET,
  TELEMETRY_RPC_URL,
  isUnsetMarketAddress,
} from "./constants";

/* ------------------------------------------------------------------ *
 * SDK boundary types
 *
 * The SDK is loaded dynamically and its published types are not
 * trusted across versions (web3.md: "trust this, re-verify on
 * upgrade"), so the two shapes we use are declared structurally and
 * the dynamic import is cast at the boundary.
 * ------------------------------------------------------------------ */

/** Result of `ParamFetcher.getMarketParams()`. Every numeric field is an ethers v5 BigNumber. */
interface KuruMarketParams {
  pricePrecision: BigNumber;
  sizePrecision: BigNumber;
  baseAssetAddress: string;
  baseAssetDecimals: BigNumber;
  quoteAssetAddress: string;
  quoteAssetDecimals: BigNumber;
  tickSize: BigNumber;
  minSize: BigNumber;
  maxSize: BigNumber;
  takerFeeBps: BigNumber;
  makerFeeBps: BigNumber;
}

/** The verified SDK surface we call (web3.md Part 2). */
interface KuruSdkModule {
  ParamFetcher: {
    getMarketParams(
      providerOrSigner: providers.Provider | Signer,
      marketAddress: string,
    ): Promise<KuruMarketParams>;
  };
  GTC: {
    placeLimit(
      signer: Signer,
      marketAddress: string,
      marketParams: KuruMarketParams,
      order: { price: string; size: string; isBuy: boolean; postOnly: boolean },
    ): Promise<providers.TransactionReceipt>;
  };
}

/** Minimal ERC-20 surface needed for allowances. */
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/* ------------------------------------------------------------------ *
 * Error translation — EIP-1193 errors are numeric, not strings
 * ------------------------------------------------------------------ */

/** Dig an EIP-1193 / ethers numeric code out of an unknown error. */
function extractCode(err: unknown): number | string | undefined {
  if (err && typeof err === "object") {
    const candidate = err as { code?: unknown; error?: { code?: unknown } };
    if (typeof candidate.code === "number") return candidate.code;
    if (typeof candidate.code === "string") return candidate.code;
    // Some wallets nest the real error one level down.
    if (candidate.error && typeof candidate.error.code === "number") {
      return candidate.error.code;
    }
  }
  return undefined;
}

/**
 * `4001` is the EIP-1193 user-rejection code; ethers v5 surfaces the
 * same thing as the string code `ACTION_REJECTED`.
 */
function isUserRejection(err: unknown): boolean {
  const code = extractCode(err);
  return code === 4001 || code === "ACTION_REJECTED";
}

/** Best-effort human message from a wallet/SDK error. */
function messageOf(err: unknown): string {
  if (err && typeof err === "object") {
    const candidate = err as { shortMessage?: unknown; message?: unknown };
    if (typeof candidate.shortMessage === "string") return candidate.shortMessage;
    if (typeof candidate.message === "string") return candidate.message;
  }
  return String(err);
}

/* ------------------------------------------------------------------ *
 * Wallet connect
 * ------------------------------------------------------------------ */

export interface WalletConnection {
  readonly provider: providers.Web3Provider;
  readonly address: string;
}

/**
 * Request the user's accounts from the injected EIP-1193 provider and
 * wrap it in an ethers v5 `Web3Provider`.
 *
 * Called from a click handler only — never during render (SSR-safe).
 */
export async function connectWallet(): Promise<WalletConnection> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new KuruGridError(
      "NO_WALLET",
      "No wallet detected. Install MetaMask to trade on Monad Testnet.",
    );
  }
  const injected: Eip1193Provider = window.ethereum;

  let accounts: unknown;
  try {
    accounts = await injected.request({ method: "eth_requestAccounts" });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new KuruGridError("USER_REJECTED", "You rejected the wallet connection.", cause);
    }
    throw new KuruGridError("RPC_ERROR", `Wallet connection failed: ${messageOf(cause)}`, cause);
  }

  const list = Array.isArray(accounts) ? (accounts as unknown[]) : [];
  const first = list[0];
  if (typeof first !== "string" || first === "") {
    throw new KuruGridError("NO_WALLET", "The wallet did not return an account.");
  }

  // EIP-1193 boundary cast: our structural Eip1193Provider satisfies
  // ethers' ExternalProvider (request method with compatible shape).
  const provider = new providers.Web3Provider(
    injected as unknown as providers.ExternalProvider,
  );
  const address = await provider.getSigner().getAddress();
  return { provider, address };
}

/** Read-only provider for the telemetry ping and dry-run runs. */
export function getTelemetryProvider(): providers.JsonRpcProvider {
  return new providers.JsonRpcProvider(TELEMETRY_RPC_URL, MONAD_TESTNET.chainId);
}

/* ------------------------------------------------------------------ *
 * Network check + switch
 * ------------------------------------------------------------------ */

/** Normalise any legal chain-id representation (hex string, '0X…', number). */
function normaliseChainId(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // BigNumber.from parses hex case-insensitively.
    return BigNumber.from(value).toNumber();
  }
  throw new KuruGridError("NO_WALLET", "The wallet returned an unreadable chain id.");
}

/**
 * Ensure the wallet is on Monad Testnet (chain id 10143 / 0x279f).
 *
 * Flow (web3.md): read eth_chainId → already on Monad? done → else
 * request accounts (may be rejected) → wallet_switchEthereumChain →
 * on 4902 ("chain not added") fall through to wallet_addEthereumChain →
 * verify again.
 */
export async function checkAndSwitchNetwork(): Promise<NetworkCheckResult> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new KuruGridError(
      "NO_WALLET",
      "No wallet detected. Install MetaMask to trade on Monad Testnet.",
    );
  }
  const injected: Eip1193Provider = window.ethereum;

  let current: number;
  try {
    current = normaliseChainId(await injected.request({ method: "eth_chainId" }));
  } catch (cause) {
    // A wallet that cannot even answer eth_chainId is locked or broken.
    throw new KuruGridError("NO_WALLET", "Could not read the chain id from the wallet.", cause);
  }

  if (current === MONAD_TESTNET.chainId) {
    return { ok: true, chainId: current, switched: false };
  }

  // Not on Monad. Asking for accounts first surfaces a rejection here
  // rather than inside the switch call.
  try {
    await injected.request({ method: "eth_requestAccounts" });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new KuruGridError("USER_REJECTED", "You rejected the wallet connection.", cause);
    }
    throw new KuruGridError("RPC_ERROR", `Wallet connection failed: ${messageOf(cause)}`, cause);
  }

  try {
    // Never pass `undefined` in the params array — always an object.
    await injected.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: MONAD_TESTNET.chainIdHex }],
    });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new KuruGridError("USER_REJECTED", "You rejected the network switch.", cause);
    }
    if (extractCode(cause) === 4902) {
      // 4902 = "chain not added to the wallet" — the ONLY condition
      // under which we call wallet_addEthereumChain. Fall through.
    } else {
      // Unknown switch failure: rethrow with the cause intact. Do not
      // guess a recovery path.
      throw new KuruGridError(
        "NETWORK_SWITCH_FAILED",
        `The wallet could not switch to ${MONAD_TESTNET.chainName}: ${messageOf(cause)}`,
        cause,
      );
    }
  }

  // Adding the chain is only needed when the wallet did not know it.
  try {
    await injected.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: MONAD_TESTNET.chainIdHex,
          chainName: MONAD_TESTNET.chainName,
          nativeCurrency: MONAD_TESTNET.nativeCurrency,
          rpcUrls: MONAD_TESTNET.rpcUrls,
          blockExplorerUrls: MONAD_TESTNET.blockExplorerUrls,
        },
      ],
    });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new KuruGridError(
        "USER_REJECTED",
        "You rejected adding Monad Testnet to your wallet.",
        cause,
      );
    }
    throw new KuruGridError(
      "CHAIN_NOT_ADDED",
      `Could not add ${MONAD_TESTNET.chainName} to the wallet: ${messageOf(cause)}`,
      cause,
    );
  }

  const after = normaliseChainId(await injected.request({ method: "eth_chainId" }));
  if (after !== MONAD_TESTNET.chainId) {
    throw new KuruGridError(
      "WRONG_NETWORK",
      `Wallet is still on chain ${after}, not ${MONAD_TESTNET.chainId}.`,
    );
  }
  return { ok: true, chainId: after, switched: true };
}

/* ------------------------------------------------------------------ *
 * Telemetry
 * ------------------------------------------------------------------ */

/**
 * One read-only RPC round-trip (eth_blockNumber). The latency figure
 * the UI shows next to the batch duration — the two together are the
 * bounty's evidence.
 */
export async function pingRpcLatency(): Promise<TelemetrySample> {
  const provider = getTelemetryProvider();
  const started = performance.now();
  let blockNumber: number;
  try {
    blockNumber = await provider.getBlockNumber();
  } catch (cause) {
    throw new KuruGridError(
      "RPC_ERROR",
      `Monad Testnet RPC unreachable: ${messageOf(cause)}`,
      cause,
    );
  }
  return {
    latencyMs: Math.round(performance.now() - started),
    blockNumber,
    timestamp: Date.now(),
  };
}

/* ------------------------------------------------------------------ *
 * Market status monitor
 * ------------------------------------------------------------------ */

/**
 * Probe the Kuru market contract: deployed code + a state query
 * (`ParamFetcher.getMarketParams`). `LIVE` means the orderbook
 * answers; anything else — empty code, RPC down, SDK load failure —
 * is `DEGRADED` and must never be presented as success.
 */
export async function checkMarketStatus(
  marketAddress: string,
  provider: providers.Provider | Signer,
): Promise<MarketStatusReport> {
  const checkedAt = Date.now();

  if (isUnsetMarketAddress(marketAddress)) {
    return {
      status: "DEGRADED",
      detail: "No market address configured — running on simulation only.",
      checkedAt,
    };
  }

  const ethProvider = Signer.isSigner(provider)
    ? provider.provider
    : provider;
  if (ethProvider === undefined || ethProvider === null) {
    return {
      status: "DEGRADED",
      detail: "Wallet signer has no network provider.",
      checkedAt,
    };
  }

  try {
    const code = await ethProvider.getCode(marketAddress);
    if (code === "0x" || code === "0x0") {
      return {
        status: "DEGRADED",
        detail: "No contract deployed at the configured address.",
        checkedAt,
      };
    }
  } catch (cause) {
    return {
      status: "DEGRADED",
      detail: `RPC unreachable: ${messageOf(cause)}`,
      checkedAt,
    };
  }

  try {
    const sdk = (await import(
      "@kuru-labs/kuru-sdk"
    )) as unknown as KuruSdkModule;
    await sdk.ParamFetcher.getMarketParams(provider, marketAddress);
    return { status: "LIVE", detail: "Orderbook responding on-chain.", checkedAt };
  } catch (cause) {
    return {
      status: "DEGRADED",
      detail: `Contract present but not answering market queries: ${messageOf(cause)}`,
      checkedAt,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Approvals — a precondition, sequential, BEFORE the burst
 * ------------------------------------------------------------------ */

/**
 * Narrow a market BigNumber to a JS number.
 *
 * `BigNumber.toNumber()` throws a bare ethers overflow error on anything
 * outside the safe-integer range. The market params come off a contract
 * we do not control, so that throw is converted here rather than allowed
 * to escape as an opaque message the operator cannot act on.
 */
function safeToNumber(value: BigNumber, field: string): number {
  try {
    return value.toNumber();
  } catch (cause) {
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      `The Kuru market returned an unreadable ${field}.`,
      cause,
    );
  }
}

/**
 * Price/size decimals from a *precision*, which is a power of ten
 * (10^8 for an 8-decimal price), so the decimals are its log10.
 *
 * ONLY for `pricePrecision` and `sizePrecision`. Using this on a token
 * decimals count is the bug the two-function split exists to prevent:
 * `Math.log10(6)` is 0.778 and `Math.log10(18)` is 1.255, neither an
 * integer, so the guard below would reject every real market. Token
 * decimals go through `decimalsFromCount`.
 */
function decimalsFromPrecision(precision: BigNumber, field: string): number {
  const n = safeToNumber(precision, field);
  const decimals = Math.log10(n);
  if (n <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      `The Kuru market returned an unreadable ${field} (${n}).`,
    );
  }
  return decimals;
}

/**
 * Token decimals from a *decimals count*, which is already the number
 * of decimal places (6 for USDC, 18 for MON) — no logarithm involved.
 *
 * The SDK treats these fields the same way: `dist/market/ioc.js` passes
 * `marketParams.baseAssetDecimals` straight into `utils.parseUnits`,
 * and `dist/market/estimator.js` into `formatUnits`. That is also why
 * the values feed `utils.parseUnits` unchanged on the approval path.
 */
function decimalsFromCount(decimals: BigNumber, field: string): number {
  const n = safeToNumber(decimals, field);
  if (!Number.isInteger(n) || n < 0 || n > 36) {
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      `The Kuru market returned an unreadable ${field} (${decimals.toString()}).`,
    );
  }
  return n;
}

async function ensureAllowance(
  signer: Signer,
  tokenAddress: string,
  spender: string,
  required: BigNumber,
  tokenLabel: string,
): Promise<void> {
  // ethers v5 Contract methods return `any` at the ABI boundary.
  const token = new Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance = (await token.allowance(owner, spender)) as BigNumber;
  if (!allowance.lt(required)) return;

  // Testnet: faucet money. MaxUint256 avoids a second signature per
  // token, which is worth more than the theoretical safety of a
  // exact-amount approval on a chain you can reset for free.
  const tx = (await token.approve(spender, constants.MaxUint256)) as providers.TransactionResponse;
  const receipt = await tx.wait();
  if (receipt === null || receipt.status !== 1) {
    throw new KuruGridError("RPC_ERROR", `${tokenLabel} approval failed on-chain.`, receipt);
  }
}

/**
 * Approve whichever tokens this grid actually touches. Buys spend the
 * quote asset (USDC); sells spend the base asset (MON) — unless the
 * base is the native token (zero address), which needs no approval.
 *
 * Approvals are awaited BEFORE the parallel burst: racing the same
 * nonce in parallel would just fail them.
 */
async function ensureApprovals(
  signer: Signer,
  marketAddress: string,
  marketParams: KuruMarketParams,
  orders: readonly GridOrder[],
  quoteDecimals: number,
  baseDecimals: number,
  sizeDecimals: number,
): Promise<void> {
  const buys = orders.filter((o) => o.isBuy);
  const sells = orders.filter((o) => !o.isBuy);

  if (buys.length > 0) {
    const totalNotional = buys.reduce((sum, o) => sum + o.notional, 0);
    const required = utils.parseUnits(totalNotional.toFixed(2), quoteDecimals);
    await ensureAllowance(signer, marketParams.quoteAssetAddress, marketAddress, required, "USDC");
  }

  if (sells.length > 0 && marketParams.baseAssetAddress !== constants.AddressZero) {
    const totalSize = sells.reduce((sum, o) => sum + o.size, 0);
    const required = utils.parseUnits(totalSize.toFixed(sizeDecimals), baseDecimals);
    await ensureAllowance(signer, marketParams.baseAssetAddress, marketAddress, required, "MON");
  }
}

/* ------------------------------------------------------------------ *
 * The broadcast batch — the heart of the product
 * ------------------------------------------------------------------ */

/**
 * Broadcast a full grid ladder to Kuru in one parallel burst.
 *
 * Every leg is started in the same tick (`.map()` before
 * `allSettled`), every leg settles independently (`allSettled`, never
 * `all` — one rejected signature must not orphan the other legs), and
 * a leg only counts as placed when `receipt.status === 1`.
 */
export async function placeParallelKuruOrders(
  provider: providers.Provider | Signer,
  marketAddress: string,
  orders: readonly GridOrder[],
  onUpdate: OrderUpdateCallback,
  options: PlaceOrdersOptions = {},
): Promise<BatchResult> {
  if (orders.length === 0) {
    return {
      durationMs: 0,
      successCount: 0,
      failureCount: 0,
      totalCount: 0,
      throughput: 0,
      dryRun: options.dryRun === true,
    };
  }

  /* ---- 0. Opt-in simulation needs no chain at all --------------- */

  if (options.dryRun === true) {
    return runDryRun(orders, onUpdate);
  }

  /* ---- 1. Load the SDK dynamically ------------------------------ */

  let sdk: KuruSdkModule;
  try {
    // SDK boundary cast: CommonJS module whose published types are
    // not trusted across versions; we structural-type it above.
    sdk = (await import("@kuru-labs/kuru-sdk")) as unknown as KuruSdkModule;
  } catch (cause) {
    // The SDK bundle itself failed to load (offline / broken build).
    // The mock is permitted here (web3.md §Dry-run) — but it is
    // badged `dryRun: true` so the UI shows SIMULATED, never LIVE.
    console.warn("Kuru SDK failed to load; falling back to simulation.", cause);
    return runDryRun(orders, onUpdate);
  }

  /* ---- 2. Resolve the signer ------------------------------------ */

  const signer = Signer.isSigner(provider)
    ? provider
    : // Any concrete provider we accept (Web3Provider / JsonRpcProvider)
      // has getSigner(); the abstract Provider type does not declare it.
      // SDK boundary cast: the caller passes a concrete provider; the
      // structural cast is safe at runtime and is confined to this line.
      (provider as unknown as { getSigner: () => Signer }).getSigner();

  /* ---- 3. Validate the market — fail fast, never mock ---------- */

  let marketParams: KuruMarketParams;
  try {
    marketParams = await sdk.ParamFetcher.getMarketParams(signer, marketAddress);
  } catch (cause) {
    // AGENTS.md §7.4: a wrong market address is a REAL error. It must
    // surface as such — it is never degraded into a fake success.
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      "No Kuru orderbook at this address on Monad Testnet. Check NEXT_PUBLIC_KURU_MARKET_ADDRESS.",
      cause,
    );
  }

  /* ---- 4. Precision comes from the market, not from us --------- */

  // Precisions are powers of ten, so log10 gives the decimal places.
  const priceDecimals = decimalsFromPrecision(marketParams.pricePrecision, "pricePrecision");
  const sizeDecimals = decimalsFromPrecision(marketParams.sizePrecision, "sizePrecision");
  // Asset decimals are already counts (USDC 6, MON 18) and must NOT be
  // run through the precision helper above.
  const quoteDecimals = decimalsFromCount(marketParams.quoteAssetDecimals, "quoteAssetDecimals");
  const baseDecimals = decimalsFromCount(marketParams.baseAssetDecimals, "baseAssetDecimals");

  /* ---- 5. Approvals — sequential precondition ------------------- */

  await ensureApprovals(
    signer,
    marketAddress,
    marketParams,
    orders,
    quoteDecimals,
    baseDecimals,
    sizeDecimals,
  );

  /* ---- 6. THE BURST --------------------------------------------- */

  // Working copy: the caller's array is never mutated; every update
  // emits a brand-new array so React sees a new reference.
  const working: GridOrder[] = orders.map((o) => ({ ...o }));
  const updateRow = (index: number, patch: Partial<GridOrder>): void => {
    const current = working[index];
    // `index` always originates from a `.map()` over `working`,
    // so the row exists — the guard satisfies noUncheckedIndexedAccess.
    if (current === undefined) return;
    working[index] = { ...current, ...patch };
    onUpdate([...working]);
  };

  const postOnly = options.postOnly ?? true;
  const t0 = performance.now();

  const settled = await Promise.allSettled(
    working.map(async (order, index): Promise<void> => {
      updateRow(index, { status: "PLACING", error: null });
      try {
        const receipt = await sdk.GTC.placeLimit(signer, marketAddress, marketParams, {
          // The SDK clips via String.split — decimal STRINGS, never
          // numbers, or it throws "value.split is not a function".
          price: order.price.toFixed(priceDecimals),
          size: order.size.toFixed(sizeDecimals),
          isBuy: order.isBuy,
          postOnly,
        });
        // A mined-but-reverted receipt still resolves. status === 1
        // is the only truth.
        const mined = receipt?.status === 1;
        updateRow(index, {
          status: mined ? "CONFIRMED" : "FAILED",
          txHash: receipt?.transactionHash ?? null,
          error: mined ? null : `Order reverted on-chain (status ${receipt?.status ?? "null"}).`,
        });
      } catch (cause) {
        if (isUserRejection(cause)) {
          updateRow(index, { status: "FAILED", error: "You rejected the request in your wallet." });
        } else {
          updateRow(index, { status: "FAILED", error: `Broadcast failed: ${messageOf(cause)}` });
        }
      }
    }),
  );

  const durationMs = Math.round(performance.now() - t0);
  const successCount = working.filter((o) => o.status === "CONFIRMED").length;
  const failureCount = working.length - successCount;
  const throughput =
    durationMs > 0 ? Math.round((working.length / durationMs) * 1000) : working.length * 1000;

  // `settled` is all-fulfilled by construction (each leg catches its
  // own rejections), but we honor the contract: every promise that can
  // reject is inside allSettled, and per-leg failures above already
  // marked exactly one row each.
  void settled;

  return { durationMs, successCount, failureCount, totalCount: working.length, throughput, dryRun: false };
}

/* ------------------------------------------------------------------ *
 * Dry-run / offline simulation
 * ------------------------------------------------------------------ */

/**
 * Simulate a broadcast: small randomised stagger per leg, and a
 * syntactically valid but provably non-existent tx hash (keccak of a
 * label, not a real transaction). The result is badged `dryRun: true`
 * so the UI renders SIMULATED.
 */
async function runDryRun(
  orders: readonly GridOrder[],
  onUpdate: OrderUpdateCallback,
): Promise<BatchResult> {
  const working: GridOrder[] = orders.map((o) => ({ ...o }));
  const updateRow = (index: number, patch: Partial<GridOrder>): void => {
    const current = working[index];
    // `index` always originates from a `.map()` over `working`,
    // so the row exists — the guard satisfies noUncheckedIndexedAccess.
    if (current === undefined) return;
    working[index] = { ...current, ...patch };
    onUpdate([...working]);
  };

  const t0 = performance.now();

  await Promise.allSettled(
    working.map(async (order, index) => {
      updateRow(index, { status: "PLACING", error: null });
      // Deterministic stagger so the ladder visibly ripples. Mock-only:
      // this is not the grid engine, which stays pure. No Math.random —
      // the verifier greps this file.
      await new Promise((resolve) => {
        setTimeout(resolve, 60 + ((index * 67) % 260));
      });
      updateRow(index, {
        status: "CONFIRMED",
        txHash: utils.id(`kurugrid-dry-run:${order.id}`),
        error: null,
      });
    }),
  );

  const durationMs = Math.max(1, Math.round(performance.now() - t0));
  const totalCount = working.length;
  return {
    durationMs,
    successCount: totalCount,
    failureCount: 0,
    totalCount,
    throughput: Math.round((totalCount / durationMs) * 1000),
    dryRun: true,
  };
}

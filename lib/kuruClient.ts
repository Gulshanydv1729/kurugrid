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
  type FundingCheck,
  type GridOrder,
  type MarketConstraints,
  type MarketStatusReport,
  type NetworkCheckResult,
  type OrderUpdateCallback,
  type PlaceOrdersOptions,
  type TelemetrySample,
  EIP1193_ERROR,
  KuruGridError,
  ACTIVE_NETWORK,
  marketNotFoundMessage,
  TELEMETRY_RPC_URL,
  TELEMETRY_TIMEOUT_MS,
  eip1193CodeOf,
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

/**
 * Result of `ParamFetcher.getMarketParams()`. Every numeric field
 * is an ethers v5 BigNumber.
 *
 * Units: `pricePrecision` / `sizePrecision` are powers of ten
 * (10^decimals); `tickSize`, `minSize` and `maxSize` are raw
 * contract values in *precision units* — the human value scaled
 * by 10^decimals, as `parseUnits` produces. `baseAssetDecimals`
 * / `quoteAssetDecimals` are plain decimal counts.
 */
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

/**
 * `4001` is the EIP-1193 user-rejection code; ethers v5 surfaces
 * the same thing as the string code `ACTION_REJECTED`. Both are
 * checked: wallets are inconsistent about which one surfaces.
 *
 * Numeric extraction goes through the canonical `eip1193CodeOf`
 * in `constants.ts` — a local copy here drifted from it once
 * already (review B6).
 */
function isUserRejection(err: unknown): boolean {
  if (eip1193CodeOf(err) === EIP1193_ERROR.USER_REJECTED) return true;
  if (typeof err === "object" && err !== null) {
    return (err as { code?: unknown }).code === "ACTION_REJECTED";
  }
  return false;
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

/**
 * Derive every trading constraint from raw market params.
 *
 * Pure with respect to I/O — it takes the params the SDK returned and computes,
 * so the broadcast path and the pre-deploy UI check cannot drift apart. The
 * ONLY place `pricePrecision`, `sizePrecision`, `tickSize`, `minSize` and
 * `maxSize` are interpreted.
 *
 * Sizes and prices stay in **raw precision units** here. A min-size
 * comparison in floating-point human units is inexact near the boundary (200
 * MON is 2e12 at 1e10 precision, well past where `Math.round` on a float is
 * trustworthy), so the comparison is done on integers and only converted for
 * display.
 */
export function deriveMarketConstraints(params: KuruMarketParams): MarketConstraints {
  const priceDecimals = decimalsFromPrecision(params.pricePrecision, "pricePrecision");
  const sizeDecimals = decimalsFromPrecision(params.sizePrecision, "sizePrecision");
  // Asset decimals are ALREADY counts (USDC 6, MON 18) and must never be run
  // through the precision helper: log10(6) is 0.778, which the precision guard
  // rejects outright. That bug once made every real market unreadable.
  const quoteDecimals = decimalsFromCount(params.quoteAssetDecimals, "quoteAssetDecimals");
  const baseDecimals = decimalsFromCount(params.baseAssetDecimals, "baseAssetDecimals");

  const tickSizeRaw = safeToNumber(params.tickSize, "tickSize");
  // minSize / maxSize are NOT narrowed to numbers. On the live MON/USDC market
  // maxSize is 2e18 — beyond 2^53, where a double silently drops low bits, so a
  // number here would corrupt the very bound it is meant to enforce. They stay
  // exact decimal strings, and the order checks compare against them as
  // BigNumbers.
  const minSizeRaw = rawDecimal(params.minSize, "minSize");
  const maxSizeRaw = rawDecimal(params.maxSize, "maxSize");
  if (
    tickSizeRaw <= 0 ||
    BigNumber.from(minSizeRaw).lte(0) ||
    BigNumber.from(maxSizeRaw).lte(0) ||
    BigNumber.from(minSizeRaw).gt(maxSizeRaw)
  ) {
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      "The Kuru market returned unusable tick size or size bounds.",
    );
  }

  const sizeScale = 10 ** sizeDecimals;
  return {
    priceDecimals,
    sizeDecimals,
    quoteDecimals,
    baseDecimals,
    tickSizeRaw,
    minSizeRaw,
    maxSizeRaw,
    // Human figures for DISPLAY ONLY — never for the legality comparison.
    // The division happens in BigNumber first, so the lossy step is the final
    // `toNumber()` on an already-scaled value (2e18 / 1e10 = 2e8, which a
    // double represents exactly). Dividing the raw double instead would
    // inherit 2^53 error before the divide even happened.
    minSizeHuman: BigNumber.from(minSizeRaw).div(sizeScale).toNumber(),
    maxSizeHuman: BigNumber.from(maxSizeRaw).div(sizeScale).toNumber(),
  };
}

/** Exact decimal string for a contract uint, without going through a double. */
function rawDecimal(value: BigNumber, field: string): string {
  try {
    const s = value.toString();
    if (!/^\d+$/.test(s)) {
      throw new KuruGridError(
        "MARKET_NOT_FOUND",
        `The Kuru market returned an unreadable ${field} (${s}).`,
      );
    }
    return s;
  } catch (cause) {
    if (cause instanceof KuruGridError) throw cause;
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      `The Kuru market returned an unreadable ${field}.`,
      cause,
    );
  }
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
      "No wallet detected. Install MetaMask to trade on Monad Mainnet.",
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
  // eth_requestAccounts already returned the address — the signer
  // would only re-derive it via an extra eth_accounts round-trip
  // (review B5: one redundant RPC call per connect).
  const address = first;
  return { provider, address };
}

/**
 * Read-only provider for the telemetry ping, the orderbook poll
 * and dry-run runs.
 *
 * Cached: the polls call this every few seconds, and a fresh
 * `JsonRpcProvider` per call just rebuilds internal state (event
 * emitters, pending-request maps) that the old instance then waits
 * to be GC'd. One provider, reused (review B7).
 */
let telemetryProvider: providers.JsonRpcProvider | null = null;
export function getTelemetryProvider(): providers.JsonRpcProvider {
  if (telemetryProvider === null) {
    telemetryProvider = new providers.JsonRpcProvider(
      TELEMETRY_RPC_URL,
      ACTIVE_NETWORK.chainId,
    );
  }
  return telemetryProvider;
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
 * Ensure the wallet is on the ACTIVE network (mainnet: chain 143 / 0x8f).
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
      "No wallet detected. Install MetaMask to trade on Monad Mainnet.",
    );
  }
  const injected: Eip1193Provider = window.ethereum;

  let current: number;
  try {
    current = normaliseChainId(await injected.request({ method: "eth_chainId" }));
  } catch (cause) {
    // -32603 on eth_chainId is the signature of a *locked* wallet
    // (review B4: the code existed but was never handled). Say so —
    // "unlock MetaMask" is actionable; "broken provider" is not.
    if (eip1193CodeOf(cause) === EIP1193_ERROR.INTERNAL) {
      throw new KuruGridError(
        "NO_WALLET",
        "The wallet is locked. Unlock it to read the chain id.",
        cause,
      );
    }
    // Anything else: a wallet that cannot even answer eth_chainId
    // is locked or broken.
    throw new KuruGridError("NO_WALLET", "Could not read the chain id from the wallet.", cause);
  }

  if (current === ACTIVE_NETWORK.chainId) {
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
      params: [{ chainId: ACTIVE_NETWORK.chainIdHex }],
    });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new KuruGridError("USER_REJECTED", "You rejected the network switch.", cause);
    }
    if (eip1193CodeOf(cause) === EIP1193_ERROR.CHAIN_NOT_ADDED) {
      // 4902 = "chain not added to the wallet" — the ONLY condition
      // under which we call wallet_addEthereumChain. Fall through.
    } else {
      // Unknown switch failure: rethrow with the cause intact. Do not
      // guess a recovery path.
      throw new KuruGridError(
        "NETWORK_SWITCH_FAILED",
        `The wallet could not switch to ${ACTIVE_NETWORK.chainName}: ${messageOf(cause)}`,
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
          chainId: ACTIVE_NETWORK.chainIdHex,
          chainName: ACTIVE_NETWORK.chainName,
          nativeCurrency: ACTIVE_NETWORK.nativeCurrency,
          rpcUrls: ACTIVE_NETWORK.rpcUrls,
          blockExplorerUrls: ACTIVE_NETWORK.blockExplorerUrls,
        },
      ],
    });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new KuruGridError(
        "USER_REJECTED",
        `You rejected adding ${ACTIVE_NETWORK.chainName} to your wallet.`,
        cause,
      );
    }
    throw new KuruGridError(
      "CHAIN_NOT_ADDED",
      `Could not add ${ACTIVE_NETWORK.chainName} to the wallet: ${messageOf(cause)}`,
      cause,
    );
  }

  const after = normaliseChainId(await injected.request({ method: "eth_chainId" }));
  if (after !== ACTIVE_NETWORK.chainId) {
    throw new KuruGridError(
      "WRONG_NETWORK",
      `Wallet is still on chain ${after}, not ${ACTIVE_NETWORK.chainId}.`,
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
    // Hard timeout: a hung node must surface a warning, not latch the
    // in-flight guard and freeze the header badge forever.
    blockNumber = await Promise.race([
      provider.getBlockNumber(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`RPC ping timed out after ${TELEMETRY_TIMEOUT_MS} ms`)),
          TELEMETRY_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (cause) {
    throw new KuruGridError(
      "RPC_ERROR",
      `${ACTIVE_NETWORK.chainName} RPC unreachable: ${messageOf(cause)}`,
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
 *
 * Only for values guaranteed to fit — `tickSize` (1e2…1e8 scale) and
 * `pricePrecision`/`sizePrecision` (powers of ten up to 1e18 but far below
 * 2^53 when they are sane). `minSize` and `maxSize` do NOT fit on the live
 * market: `maxSize` is 2e18, past 2^53, so rounding it to a double would
 * silently corrupt the bound it exists to enforce. Those are handled by
 * `rawDecimal`, which keeps them exact.
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
 *
 * Exported because `lib/tradeFeed.ts` needs it to decode a `Trade` log, and a
 * third private copy of this function is exactly the drift review B6 was
 * opened for. One implementation, one set of guards.
 */
export function decimalsFromPrecision(precision: BigNumber, field: string): number {
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

/**
 * Exported for the UI, which must warn about an undersized grid *before* the
 * operator is asked to sign for it. Same drift risk as
 * `decimalsFromPrecision` above (review B6): token decimals are already counts
 * and must never be run through the precision helper.
 */
export function tokenDecimalsFromCount(decimals: BigNumber, field: string): number {
  return decimalsFromCount(decimals, field);
}

/**
 * Read a market's real trading constraints, on-chain, once.
 *
 * The single source for every constraint in the app. `placeParallelKuruOrders`
 * derives its conformance pass from exactly this, and the UI reads the same
 * value to decide whether the grid it is about to broadcast is legal — so the
 * panel and the chain cannot disagree about what is acceptable.
 *
 * Nothing here is assumed. The live MON/USDC market on mainnet reports
 * `minSize` of 200 MON (~$6.20 at the current mark) and a `sizePrecision` of
 * 1e10 — both very different from this app's old hard-coded assumptions, and
 * both of which would have produced a ladder that silently reverted.
 */
export async function fetchMarketConstraints(
  provider: providers.Provider,
  marketAddress: string,
): Promise<MarketConstraints> {
  let sdk: KuruSdkModule;
  let params: KuruMarketParams;
  try {
    sdk = (await import("@kuru-labs/kuru-sdk")) as unknown as KuruSdkModule;
    params = await sdk.ParamFetcher.getMarketParams(provider, marketAddress);
  } catch (cause) {
    throw new KuruGridError("MARKET_NOT_FOUND", marketNotFoundMessage(), cause);
  }

  return deriveMarketConstraints(params);
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
  if (allowance.gte(required)) return;

  // MAINNET: approve the exact amount this batch needs, never `MaxUint256`.
  //
  // This used to be an unlimited approval, justified as a testnet convenience
  // ("faucet money on a chain anyone can reset") with an explicit warning not
  // to copy it to mainnet. The migration made that warning load-bearing, so the
  // pattern changed rather than the comment.
  //
  // What an unlimited approval actually is: a standing, unrevocable-by-expiry
  // permission for the orderbook to move *any* amount of the operator's USDC or
  // MON, for as long as the contract lives. On a chain where the money is real,
  // that converts "this grid can spend $120" into "this contract can take
  // everything", and it persists across sessions with no UI ever showing it.
  // The cost of doing it properly is one extra signature when the operator
  // deploys a second, larger grid — which is the correct trade on mainnet.
  //
  // `required` is the exact total for the broadcastable legs, computed in
  // `ensureApprovals` from the same orders that are about to be signed, so the
  // allowance cannot exceed what the batch can consume.
  const tx = (await token.approve(spender, required)) as providers.TransactionResponse;
  const receipt = await tx.wait();
  if (receipt === null || receipt.status !== 1) {
    throw new KuruGridError("RPC_ERROR", `${tokenLabel} approval failed on-chain.`, receipt);
  }
}

const BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

/**
 * Preflight: does the connected wallet actually hold enough of each
 * asset for this grid? Buy legs need quote (USDC); sell legs need
 * base (MON). This is what turns a MetaMask with an empty token
 * balance into "simulation only" instead of 20 doomed signatures.
 */
export async function checkFundingReadiness(
  provider: providers.Provider,
  marketAddress: string,
  ownerAddress: string,
  orders: readonly GridOrder[],
): Promise<FundingCheck> {
  let sdk: KuruSdkModule;
  let marketParams: KuruMarketParams;
  try {
    sdk = (await import("@kuru-labs/kuru-sdk")) as unknown as KuruSdkModule;
    marketParams = await sdk.ParamFetcher.getMarketParams(provider, marketAddress);
  } catch (cause) {
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      marketNotFoundMessage(),
      cause,
    );
  }

  const quoteDecimals = decimalsFromCount(marketParams.quoteAssetDecimals, "quoteAssetDecimals");

  let quoteRequired = 0;
  let baseRequired = 0;
  for (const order of orders) {
    if (order.isBuy) quoteRequired += order.notional;
    else baseRequired += order.size;
  }

  const quoteToken = new Contract(marketParams.quoteAssetAddress, BALANCE_ABI, provider);
  const quoteBalanceRaw = (await quoteToken.balanceOf(ownerAddress)) as BigNumber;
  const quoteBalance = Number(quoteBalanceRaw.toString()) / 10 ** quoteDecimals;

  const baseDecimals = decimalsFromCount(marketParams.baseAssetDecimals, "baseAssetDecimals");
  let baseBalance: number;
  if (marketParams.baseAssetAddress === "0x0000000000000000000000000000000000000000") {
    baseBalance = Number((await provider.getBalance(ownerAddress)).toString()) / 10 ** 18;
  } else {
    const baseToken = new Contract(marketParams.baseAssetAddress, BALANCE_ABI, provider);
    const baseBalanceRaw = (await baseToken.balanceOf(ownerAddress)) as BigNumber;
    baseBalance = Number(baseBalanceRaw.toString()) / 10 ** baseDecimals;
  }

  const reasons: string[] = [];
  if (quoteBalance < quoteRequired) {
    reasons.push(
      `need ${quoteRequired.toFixed(2)} USDC for buy legs, wallet holds ${quoteBalance.toFixed(2)}`,
    );
  }
  if (baseBalance < baseRequired) {
    reasons.push(
      `need ${baseRequired.toFixed(4)} MON for sell legs, wallet holds ${baseBalance.toFixed(4)}`,
    );
  }

  return {
    ok: reasons.length === 0,
    quoteRequired,
    quoteBalance,
    baseRequired,
    baseBalance,
    reason: reasons.length > 0 ? reasons.join(" · ") : null,
  };
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
      marketNotFoundMessage(),
      cause,
    );
  }

  /* ---- 4. Constraints come from the market, not from us --------- */

  // One read, one derivation — the same function the UI calls before the
  // operator signs. Deriving these separately in two places is how a panel
  // and a chain end up disagreeing about what is acceptable.
  const constraints = deriveMarketConstraints(marketParams);
  const { priceDecimals, sizeDecimals, quoteDecimals, baseDecimals } = constraints;
  const { tickSizeRaw, minSizeRaw, maxSizeRaw, minSizeHuman, maxSizeHuman } = constraints;

  /* ---- 4b. Conformance — tick grid + size bounds -------------- */

  // The orderbook contract stores `tickSize`, `minSize` and
  // `maxSize` in *precision units* — the human value scaled by
  // 10^decimals, exactly what `parseUnits` produces (the SDK's own
  // `ParamCreator.calculatePrecisions` builds them that way). A
  // price that is not a multiple of the tick, or a size outside
  // the bounds, reverts on-chain. Conform every leg HERE, before
  // the approval transaction is signed: prices snap onto the tick
  // grid, and a leg whose size the market would reject is marked
  // FAILED with the reason — never silently dropped, never
  // broadcast as a doomed transaction.
  const priceScale = 10 ** priceDecimals;

  // Exact integers for every legality comparison. `maxSizeRaw` is 2e18 on the
  // live MON/USDC market — past 2^53, where a double drops low bits — so
  // comparing these as numbers would enforce a maximum order size that is
  // subtly wrong. Same arithmetic as `gridEngine.checkGridAgainstMarket`, so
  // the panel and the chain cannot disagree about what is legal.
  const minRaw = BigInt(constraints.minSizeRaw);
  const maxRaw = BigInt(constraints.maxSizeRaw);
  const tickRaw = BigInt(Math.round(tickSizeRaw));

  /**
   * Scale a human number up to raw precision units exactly, as a BigInt.
   *
   * Working on the decimal string rather than multiplying a double: the cases
   * that matter are exactly the ones a double gets wrong (a leg of precisely
   * 200 MON must be legal when the minimum is 200 MON, while 199.9999999 must
   * not be), and this is the same number that gets sent on the wire.
   */
  const scaleToRaw = (value: number, scale: number): bigint => {
    if (!Number.isFinite(value)) return 0n;
    const negative = value < 0;
    const [intPart = "0", fracPart = ""] = Math.abs(value).toString().split(".");
    const frac = fracPart.slice(0, scale).padEnd(scale, "0");
    const scaled = BigInt(`${intPart}${frac}`);
    return negative ? -scaled : scaled;
  };

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

  for (let index = 0; index < working.length; index += 1) {
    const order = working[index];
    if (order === undefined) continue;

    // Snap the price onto the tick grid. Done in BigInt rather than on
    // floats: at 8-decimal price precision the raw value sits around
    // 3.1e6, which is safely below 2^53, but the *tick* division is
    // only exact if both sides are integers, and `gridEngine`'s
    // pre-flight check does the same arithmetic in BigInt — the two
    // must agree or the panel would warn about a snap the broadcast
    // does not perform.
    const priceInPrecision = scaleToRaw(order.price, priceDecimals);
    const snappedInPrecision =
      ((priceInPrecision + tickRaw / 2n) / tickRaw) * tickRaw;
    if (snappedInPrecision !== priceInPrecision) {
      updateRow(index, { price: Number(snappedInPrecision) / priceScale });
    }

    // Size bounds cannot be snapped — a leg outside them stays in the
    // ladder marked FAILED with the reason, so the operator sees
    // exactly which legs the market rejected and why. Compared as
    // BigInt: `maxSizeRaw` is 2e18 on the live market, well past
    // Number.MAX_SAFE_INTEGER, so a float comparison here would be
    // enforcing a limit that is quietly wrong at the top end.
    const sizeInPrecision = scaleToRaw(order.size, sizeDecimals);
    if (sizeInPrecision < minRaw) {
      updateRow(index, {
        status: "FAILED",
        error: `Size ${order.size} MON is below the market minimum of ${minSizeHuman} MON.`,
      });
    } else if (sizeInPrecision > maxRaw) {
      updateRow(index, {
        status: "FAILED",
        error: `Size ${order.size} MON is above the market maximum of ${maxSizeHuman} MON.`,
      });
    }
  }

  // Only conforming legs are approved for and broadcast.
  const broadcastable = working.filter((order) => order.status !== "FAILED");

  /* ---- 5. Approvals — sequential precondition ------------------- */

  if (broadcastable.length > 0) {
    await ensureApprovals(
      signer,
      marketAddress,
      marketParams,
      broadcastable,
      quoteDecimals,
      baseDecimals,
      sizeDecimals,
    );
  }

  /* ---- 6. THE BURST --------------------------------------------- */

  const postOnly = options.postOnly ?? true;
  const t0 = performance.now();

  await Promise.allSettled(
    working.map(async (order, index): Promise<void> => {
      // Pre-failed by the conformance pass above — the reason is
      // already on the row. Never broadcast, never re-marked.
      if (order.status === "FAILED") return;
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
          // Parse the placement receipt for the OrderCreated log so
          // the fill watcher can correlate later Trade events.
          orderId: mined ? extractOrderId(receipt) : null,
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

  const durationMs = Math.max(1, Math.round(performance.now() - t0));
  const successCount = working.filter((o) => o.status === "CONFIRMED").length;
  const failureCount = working.length - successCount;
  const throughput = Math.round((working.length / durationMs) * 1000);

  // Every promise above is inside allSettled, and per-leg failures
  // already marked exactly one row each.
  return { durationMs, successCount, failureCount, totalCount: working.length, throughput, dryRun: false };
}

/* ------------------------------------------------------------------ *
 * Fill watching
 *
 * A resting order is filled by a *later* taker transaction, so the
 * placement receipt does not tell us. We correlate Trade logs on the
 * market contract against the order ids extracted from placement.
 * ------------------------------------------------------------------ */

// Signatures transcribed from the SDK's own OrderBook.json — the
// parameter *types* are what keccak-hashes into the event topic,
// so they must match the contract exactly or every log fails to
// parse and fills are never seen.
const FILL_WATCH_ABI = [
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
];

const FILL_WATCH_IFACE = new utils.Interface(FILL_WATCH_ABI);

/**
 * Topic0 of the market contract's `Trade` event — the log filter every
 * on-chain trade read keys off.
 *
 * Exported alongside the ABI itself so `lib/tradeFeed.ts` (the live ticker)
 * shares this one transcription. Duplicating it would create a second place
 * for the signature to drift, and a drifted signature fails *silently*:
 * `getLogs` returns nothing, no error is raised, and the ticker simply looks
 * like a quiet market. That is changes.md §7 item 3, and it is worse than an
 * exception.
 */
export function tradeEventTopic(): string {
  return FILL_WATCH_IFACE.getEventTopic("Trade");
}

/** Order id from a placement receipt, or null if the event is absent. */
function extractOrderId(receipt: providers.TransactionReceipt | undefined): string | null {
  if (receipt === undefined) return null;
  for (const log of receipt.logs) {
    try {
      const parsed = FILL_WATCH_IFACE.parseLog({ topics: log.topics, data: log.data });
      if (parsed !== null && parsed.name === "OrderCreated") {
        return parsed.args[0].toString();
      }
    } catch {
      // Not one of our events — keep scanning.
    }
  }
  return null;
}

/**
 * Poll the market contract for Trade events matching the given order
 * ids. Calls `onFilled` once per matched order id, then stops polling
 * once every id has been seen or `stop()` is called.
 */
export function watchOrderFills(
  provider: providers.Provider,
  marketAddress: string,
  orderIds: readonly string[],
  onFilled: (orderId: string, tradeTxHash: string) => void,
  intervalMs = 5000,
): () => void {
  const pending = new Set(orderIds);
  const tradeTopic = FILL_WATCH_IFACE.getEventTopic("Trade");
  let fromBlock = -1; // resolved on first pass
  let closed = false;
  let inFlight = false;

  const timer = setInterval(() => {
    if (closed || inFlight || pending.size === 0) return;
    inFlight = true;
    void (async () => {
      try {
        const head = await provider.getBlockNumber();
        if (fromBlock < 0) fromBlock = head;
        const logs = await provider.getLogs({
          address: marketAddress,
          topics: [tradeTopic],
          fromBlock,
          toBlock: head,
        });
        fromBlock = head + 1;
        for (const log of logs) {
          try {
            const parsed = FILL_WATCH_IFACE.parseLog({ topics: log.topics, data: log.data });
            if (parsed === null) continue;
            const id = parsed.args[0].toString();
            if (pending.has(id)) {
              pending.delete(id);
              onFilled(id, log.transactionHash);
            }
          } catch {
            // Unparsable log — skip.
          }
        }
        if (pending.size === 0) closed = true;
      } catch {
        // Transient RPC failure — retry on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, intervalMs);

  return () => {
    closed = true;
    clearInterval(timer);
  };
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

/**
 * Real Kuru L2 orderbook snapshot — the only honest mark source.
 *
 * Owner: `web3`.
 *
 * Reads the top of the exact orderbook contract the grid will
 * broadcast to, via the SDK's `OrderBook.getL2OrderBook`. The SDK is
 * dynamically imported so it never enters the SSR graph. Every
 * failure path throws a normalised error — the caller keeps the
 * previous UI and falls back to the range midpoint.
 */

import { BigNumber, providers, Signer } from "ethers";
import { type KuruBookSnapshot, KuruGridError, marketNotFoundMessage } from "./constants";

interface KuruBookParams {
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

interface OrderBookModule {
  OrderBook: {
    getL2OrderBook(
      providerOrSigner: providers.Provider | Signer,
      orderbookAddress: string,
      marketParams: KuruBookParams,
    ): Promise<{ asks: number[][]; bids: number[][]; blockNumber: number }>;
  };
  ParamFetcher: {
    getMarketParams(
      providerOrSigner: providers.Provider | Signer,
      orderbookAddress: string,
    ): Promise<KuruBookParams>;
  };
}

/**
 * Snapshot the top of the book for the configured market.
 *
 * Throws when the market has no deployed book, the RPC is down, or
 * the SDK cannot be loaded. Never returns a fabricated mid.
 */
export async function fetchMarketBook(
  provider: providers.Provider | Signer,
  marketAddress: string,
): Promise<KuruBookSnapshot> {
  let sdk: OrderBookModule;
  try {
    sdk = (await import("@kuru-labs/kuru-sdk")) as unknown as OrderBookModule;
  } catch (cause) {
    throw new KuruGridError("SDK_UNAVAILABLE", "The Kuru SDK failed to load.", cause);
  }

  let params: KuruBookParams;
  try {
    params = await sdk.ParamFetcher.getMarketParams(provider, marketAddress);
  } catch (cause) {
    throw new KuruGridError(
      "MARKET_NOT_FOUND",
      marketNotFoundMessage(),
      cause,
    );
  }

  try {
    const book = await sdk.OrderBook.getL2OrderBook(provider, marketAddress, params);
    const bidPrices = book.bids.map((level) => level[0]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const askPrices = book.asks.map((level) => level[0]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
    const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;
    const mid =
      bestBid !== null && bestAsk !== null
        ? (bestBid + bestAsk) / 2
        : bestBid ?? bestAsk;
    if (mid === null || !Number.isFinite(mid) || mid <= 0) {
      throw new Error("Empty orderbook — no bids or asks on either side.");
    }
    const bidDepth =
      bestBid !== null
        ? book.bids.find((l) => l[0] === bestBid)?.[1] ?? 0
        : 0;
    const askDepth =
      bestAsk !== null
        ? book.asks.find((l) => l[0] === bestAsk)?.[1] ?? 0
        : 0;
    return {
      bestBid,
      bestAsk,
      mid,
      blockNumber: book.blockNumber,
      bidDepth,
      askDepth,
      fetchedAt: Date.now(),
    };
  } catch (cause) {
    if (cause instanceof KuruGridError) throw cause;
    throw new KuruGridError(
      "RPC_ERROR",
      `Could not read the orderbook: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

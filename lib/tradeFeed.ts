/**
 * Live trade ticker — the market contract's `Trade` topic, swept on a timer.
 *
 * Owner: `web3` (see .opencode/agents/web3.md Part 2)
 *
 * This is the most visceral "the market is alive" signal the terminal can
 * offer, and it is the one piece of liveness that does **not** come from our
 * own grid. The mark price is what *we* would trade at; the tape is what
 * *everyone else* is trading at, right now. On a 24/7 CLOB there is always
 * something printing, and watching it move is what separates a live terminal
 * from a screenshot.
 *
 * Two decisions worth stating, because both are about not lying:
 *
 * - **No backfill.** The first sweep starts at the current head, so a terminal
 *   opened after a busy minute does not dump 500 historical trades into the
 *   feed. A ticker is a *live* instrument; replaying history would make old
 *   prints look like they just happened, which is the exact class of dishonesty
 *   `lib/marketBook.ts` exists to avoid.
 * - **Decoded, not raw.** The `Trade` event carries `price` and `filledSize`
 *   in *precision units* — 1e8 times the human figure for an 8-decimal price.
 *   Handing those to the UI raw would print a MON/USDC trade as $50000000. The
 *   conversion happens once, here, using the market's own precisions.
 */

import { BigNumber, providers, utils } from "ethers";
import { type MarketTrade } from "./constants";
import { decimalsFromPrecision, tradeEventTopic } from "./kuruClient";

interface Precisions {
  /** Decimal places in the market's price precision (e.g. 8). */
  readonly price: number;
  /** Decimal places in the market's size precision (e.g. 4). */
  readonly size: number;
}

/**
 * Market precisions, cached per market address.
 *
 * `getMarketParams` is a contract read and the precisions are immutable for
 * the life of the deployment, so sweeping them once per session is correct.
 * Keyed by address because the address is build-time configurable and the
 * module-level cache must not leak one market's decimals into another's.
 */
const precisionCache = new Map<string, Precisions>();

/** The only two market-param fields this module reads, declared structurally. */
interface PrecisionFields {
  readonly pricePrecision: BigNumber;
  readonly sizePrecision: BigNumber;
}

async function resolvePrecisions(
  provider: providers.Provider,
  marketAddress: string,
): Promise<Precisions> {
  const cached = precisionCache.get(marketAddress);
  if (cached !== undefined) return cached;

  // SDK boundary cast: the SDK is CommonJS and its published types are not
  // trusted across versions, so the fields we need are declared structurally
  // and the dynamic import is cast at the boundary.
  const sdk = (await import("@kuru-labs/kuru-sdk")) as unknown as {
    ParamFetcher: {
      getMarketParams(
        providerOrSigner: providers.Provider,
        orderbookAddress: string,
      ): Promise<PrecisionFields>;
    };
  };
  const params = await sdk.ParamFetcher.getMarketParams(provider, marketAddress);

  const resolved: Precisions = {
    price: decimalsFromPrecision(params.pricePrecision, "pricePrecision"),
    size: decimalsFromPrecision(params.sizePrecision, "sizePrecision"),
  };
  precisionCache.set(marketAddress, resolved);
  return resolved;
}

/**
 * How many already-emitted logs to remember.
 *
 * Sized to comfortably cover one sweep interval on a busy market (a few
 * hundred prints) while staying trivially small. The purpose is narrow: a log
 * is delivered once per sweep by construction, but a provider that replays a
 * range after a transient failure would double-post into the feed, and a
 * duplicated "BUY @ $0.0431" reads as two real trades.
 */
const SEEN_CAPACITY = 512;

export interface TradeFeedHandle {
  /** Stop the sweep and release the timer. */
  readonly stop: () => void;
  /** Last sweep error, for a degraded badge. `null` while healthy. */
  readonly lastError: () => string | null;
}

/**
 * Start sweeping `Trade` logs from the market contract.
 *
 * `onTrade` is called once per newly-seen log, in block order. The loop uses
 * the same `inFlight` guard and self-rescheduling shape as every other poll in
 * this app, and never awaits inside its log loop — a `for` loop that awaits is
 * the pattern AGENTS.md §4.4 bans, and this one is a decode loop.
 */
export function startTradeFeed(
  provider: providers.Provider,
  marketAddress: string,
  onTrade: (trade: MarketTrade) => void,
  intervalMs: number,
): TradeFeedHandle {
  const iface = new utils.Interface([
    // Transcribed from the SDK's own OrderBook.json. Re-declared here rather
    // than exported from kuruClient so this module owns the *decoding* shape;
    // the filter topic is shared via `tradeEventTopic()` so the two can never
    // disagree about which logs count as trades.
    "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
  ]);
  const topic = tradeEventTopic();

  /** Insertion-ordered set; the oldest key is dropped once full. */
  const seen = new Set<string>();
  const remember = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > SEEN_CAPACITY) {
      const oldest = seen.values().next();
      if (oldest.done !== true) seen.delete(oldest.value);
    }
    return true;
  };

  let fromBlock = -1; // resolved on the first sweep
  let closed = false;
  let inFlight = false;
  let error: string | null = null;
  let precisions: { price: number; size: number } | null = null;

  const sweep = async (): Promise<void> => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const head = await provider.getBlockNumber();

      // Start from the head, not from 0: a ticker replays nothing.
      if (fromBlock < 0) {
        fromBlock = head;
        return;
      }

      const logs = await provider.getLogs({
        address: marketAddress,
        topics: [topic],
        fromBlock,
        toBlock: head,
      });
      fromBlock = head + 1;

      // Only pay for the precisions once there is something to decode.
      if (logs.length === 0) {
        error = null;
        return;
      }
      if (precisions === null) {
        precisions = await resolvePrecisions(provider, marketAddress);
      }

      for (const log of logs) {
        if (closed) return;
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed === null) continue;
          const priceRaw = parsed.args[3] as BigNumber;
          const sizeRaw = parsed.args[7] as BigNumber;
          const price = Number(priceRaw.toString()) / 10 ** precisions.price;
          const size = Number(sizeRaw.toString()) / 10 ** precisions.size;
          // A zero or non-finite print is a decoding failure, not a trade.
          // Rendering it would put "$0.00000000" in the tape.
          if (!Number.isFinite(price) || price <= 0) continue;
          if (!Number.isFinite(size) || size <= 0) continue;

          const key = `${log.transactionHash}:${log.logIndex}`;
          if (!remember(key)) continue;

          onTrade({
            orderId: (parsed.args[0] as BigNumber).toString(),
            price,
            size,
            isBuy: parsed.args[2] as boolean,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            at: Date.now(),
          });
        } catch {
          // Unparsable log — keep scanning. One malformed entry must not cost
          // us the rest of the block.
        }
      }
      error = null;
    } catch (cause) {
      // Transient RPC failure. `fromBlock` is deliberately NOT advanced, so the
      // next sweep re-reads this range — a dropped sweep is better than a
      // skipped block, and the `seen` set makes the replay idempotent.
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void sweep();
  }, intervalMs);
  // Seed the range without waiting a full interval.
  void sweep();

  return {
    stop: () => {
      closed = true;
      clearInterval(timer);
    },
    lastError: () => error,
  };
}
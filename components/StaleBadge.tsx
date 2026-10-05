import { type MarketStatusReport, type MarketTrade, BOOK_STALE_MS } from "@/lib/constants";

/**
 * Freshness and last-trade indicators.
 *
 * A terminal that cannot say *how old* its numbers are is asking to be
 * trusted on faith. These two components exist so the honest reading —
 * "last block 8s ago", "no prints yet" — is always one glance away, and so a
 * stalled feed looks stalled instead of calm.
 */

interface AgeProps {
  /** Epoch ms the underlying read completed. */
  readonly at: number | null;
  /** Label for the thing being timed. */
  readonly label: string;
  /** Above this age the reading is rendered as stale. */
  readonly staleAfterMs?: number;
  /** Now, injected so the caller controls the tick. */
  readonly now: number;
}

/**
 * Age of a reading, in human units.
 *
 * `now` is a prop rather than a `Date.now()` read so the component stays pure
 * and the caller decides the tick cadence — and so nothing here can drift out
 * of sync with the data it is describing.
 */
export function DataAge({ at, label, staleAfterMs = BOOK_STALE_MS, now }: AgeProps) {
  if (at === null) {
    return <span className="text-zinc-600">{label} —</span>;
  }

  const ageMs = Math.max(0, now - at);
  const stale = ageMs > staleAfterMs;

  return (
    <span className="tabular-nums" title={`${label} ${ageMs} ms ago`}>
      {ageMs < 1000 ? "just now" : `${(ageMs / 1000).toFixed(0)}s ago`}
      {stale ? <span className="ml-1 text-amber-400/90">· stale</span> : null}
    </span>
  );
}

/**
 * True when a market report is itself stale or has been degraded for a while.
 *
 * A `DEGRADED` verdict is often transient — one failed read while the chain
 * reorgs. Rendering it identically to a 10-minute outage would cry wolf, so the
 * caller gets the age and decides.
 */
export function isStaleReport(report: MarketStatusReport | null, now: number): boolean {
  if (report === null) return true;
  return now - report.checkedAt > BOOK_STALE_MS;
}

export interface LastTradeProps {
  readonly trade: MarketTrade | null;
}

/** The most recent print from the market, with its age. */
export function LastTrade({ trade }: LastTradeProps) {
  if (trade === null) {
    return (
      <span className="text-zinc-600">
        no prints yet — the ticker starts from the block it connects at
      </span>
    );
  }
  return (
    <span className="font-mono tabular-nums">
      <span className={trade.isBuy ? "text-emerald-400/90" : "text-rose-400/90"}>
        {trade.isBuy ? "BUY" : "SELL"}
      </span>{" "}
      <span className="text-zinc-400">${trade.price.toFixed(4)}</span>{" "}
      <span className="text-zinc-600">{trade.size.toFixed(2)} MON</span>
    </span>
  );
}
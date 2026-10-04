import { Fragment } from "react";
import { ExternalLink, LayoutGrid, Loader2 } from "lucide-react";
import {
  ORDER_STATUS_META,
  explorerTxUrl,
  type GridOrder,
} from "@/lib/constants";
import { formatPrice, formatSize, type GridSummary } from "@/lib/gridEngine";

/**
 * The depth ladder — the centrepiece of the terminal.
 *
 * Purely presentational: it renders exactly what `gridEngine` computed
 * and what `kuruClient` reported back. It never re-sorts (the engine
 * guarantees descending price order), never fetches, and never touches
 * the wallet or the SDK.
 */
export interface OrderLadderProps {
  /** Grid legs, sorted descending by price (engine guarantee). */
  readonly orders: readonly GridOrder[];
  /** Aggregate view of the same ladder. */
  readonly summary: GridSummary;
  /** Reference mark price used to split bids from asks. */
  readonly markPrice: number;
  /** True while a batch broadcast is in flight. */
  readonly isDeploying: boolean;
}

export function OrderLadder({
  orders,
  summary,
  markPrice,
  isDeploying,
}: OrderLadderProps) {
  // Depth bars are scaled to the largest notional in the ladder.
  const maxNotional = orders.reduce((max, order) => Math.max(max, order.notional), 0);

  /**
   * The ladder is sorted descending and every ask (price >= mark)
   * precedes every bid (price < mark), so the index of the first
   * bid is exactly the ask/bid boundary. `-1` means the ladder is
   * all one side (mark at a range edge) — no divider in that case.
   */
  const firstBuyIndex = orders.findIndex((order) => order.isBuy);
  const showMarkDivider = firstBuyIndex > 0;

  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 shadow-panel lg:max-h-[calc(100vh-10rem)]">
      {/* Panel header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Order Ladder
          </h2>
          {isDeploying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-500">
          <span>{summary.total} legs</span>
          <span className="text-emerald-400/80">{summary.buyCount} bids</span>
          <span className="text-rose-400/80">{summary.sellCount} asks</span>
          {summary.bestBid !== null ? (
            <span>
              best bid <span className="text-emerald-400">{formatPrice(summary.bestBid)}</span>
            </span>
          ) : null}
          {summary.bestAsk !== null ? (
            <span>
              best ask <span className="text-rose-400">{formatPrice(summary.bestAsk)}</span>
            </span>
          ) : null}
        </div>
      </header>

      {orders.length === 0 ? (
        /* Empty state — never a blank panel (frontend.md). */
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
          <LayoutGrid className="h-10 w-10 text-zinc-800" />
          <p className="text-sm font-medium text-zinc-400">No grid deployed</p>
          <p className="max-w-xs text-xs leading-relaxed text-zinc-500">
            Configure bounds and capital on the left, then broadcast the ladder
            in one parallel burst.
          </p>
        </div>
      ) : (
        <>
          {/* Column headers — same grid template as the rows. */}
          <div className="grid grid-cols-[88px_56px_minmax(0,1fr)_minmax(0,1fr)_112px_24px] gap-x-3 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
            <span className="text-right">Price</span>
            <span>Side</span>
            <span className="text-right">Size</span>
            <span className="text-right">Notional</span>
            <span className="text-right">Status</span>
            <span />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {orders.map((order, index) => (
              <Fragment key={order.id}>
                {showMarkDivider && index === firstBuyIndex ? (
                  /* Dashed mark-price divider at the best-bid / best-ask boundary. */
                  <div className="flex items-center gap-3 px-4 py-1.5" aria-hidden="true">
                    <div className="h-px flex-1 border-t border-dashed border-zinc-800" />
                    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                      mark {formatPrice(markPrice)}
                    </span>
                    <div className="h-px flex-1 border-t border-dashed border-zinc-800" />
                  </div>
                ) : null}

                <LadderRow order={order} maxNotional={maxNotional} />
              </Fragment>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * One row of the ladder
 * ------------------------------------------------------------------ */

interface LadderRowProps {
  readonly order: GridOrder;
  readonly maxNotional: number;
}

function LadderRow({ order, maxNotional }: LadderRowProps) {
  const meta = ORDER_STATUS_META[order.status];
  const depthPct = maxNotional > 0 ? (order.notional / maxNotional) * 100 : 0;

  return (
    <div className="group relative border-b border-zinc-900/70 transition-colors hover:bg-zinc-800/30">
      {/* Depth bar — weight of this leg relative to the largest.
          Bids anchor left, asks anchor right, converging on the mark. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 ${
          order.isBuy ? "left-0 bg-emerald-500/5" : "right-0 bg-rose-500/5"
        }`}
        style={{ width: `${depthPct}%` }}
      />

      <div className="relative grid grid-cols-[88px_56px_minmax(0,1fr)_minmax(0,1fr)_112px_24px] items-center gap-x-3 px-4 py-2.5">
        {/* Price — side-coloured, monospace, tabular. */}
        <span
          className={`text-right font-mono text-[13px] tabular-nums ${
            order.isBuy ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {formatPrice(order.price)}
        </span>

        {/* Side badge */}
        <span
          className={`inline-flex w-fit items-center rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${
            order.isBuy
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
              : "border-rose-500/20 bg-rose-500/10 text-rose-400"
          }`}
        >
          {order.isBuy ? "Bid" : "Ask"}
        </span>

        {/* Size */}
        <span className="text-right font-mono text-xs tabular-nums text-zinc-300">
          {formatSize(order.size)}
          <span className="ml-1 text-[10px] text-zinc-500">MON</span>
        </span>

        {/* Notional */}
        <span className="text-right font-mono text-xs tabular-nums text-zinc-400">
          ${order.notional.toFixed(2)}
        </span>

        {/* Status pill — mapping lives in constants.ts, not in JSX. */}
        <span className="flex justify-end">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
        </span>

        {/* Explorer link — only when a real receipt exists. A failed
            leg never gets a dead "#" link (frontend.md). */}
        <span className="flex justify-end">
          {order.txHash !== null ? (
            <a
              href={explorerTxUrl(order.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              title="View on Monad Explorer"
              className="text-zinc-500 transition-colors hover:text-violet-400"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </span>
      </div>

      {/* Failure reason — operators need to see why a leg died. */}
      {order.status === "FAILED" && order.error !== null ? (
        <div
          className="relative truncate px-4 pb-2 font-mono text-[11px] text-rose-400/80"
          title={order.error}
        >
          {order.error}
        </div>
      ) : null}
    </div>
  );
}

import { CheckCircle2, CircleDot, Clock, XCircle } from "lucide-react";
import type { GridOrder } from "@/lib/constants";

/**
 * Live execution timeline — one row per leg, newest batch state.
 *
 * Purely presentational: each row shows the leg's journey as
 * Pending → Confirmed/Filled → (or) Failed, mirroring the ladder.
 */
export function ExecutionTimeline({
  orders,
}: {
  readonly orders: readonly GridOrder[];
}) {
  if (orders.length === 0) return null;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <header className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
          Execution timeline
        </h2>
      </header>
      <ol className="max-h-64 divide-y divide-zinc-900 overflow-y-auto px-4 font-mono text-[12px]">
        {orders.map((order) => {
          let icon = <CircleDot className="h-3.5 w-3.5 text-zinc-600" />;
          let label = "Ready";
          if (order.status === "CONFIRMED" || order.status === "FILLED") {
            icon = <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
            label = order.status === "FILLED" ? "Filled" : "Confirmed";
          } else if (order.status === "FAILED") {
            icon = <XCircle className="h-3.5 w-3.5 text-rose-400" />;
            label = "Failed";
          } else if (order.status === "PLACING") {
            icon = <Clock className="h-3.5 w-3.5 animate-pulse text-violet-400" />;
            label = "Pending";
          }
          return (
            <li key={order.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-zinc-500">
                {order.isBuy ? "BUY" : "SELL"} @ ${order.price.toFixed(4)}
              </span>
              <span className="flex items-center gap-1.5 text-zinc-300">
                {icon}
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

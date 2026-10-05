/**
 * Live activity feed — most recent events first, capped at 50.
 *
 * Purely presentational; the parent owns the ring buffer in state.
 */
export interface ActivityFeedItem {
  readonly id: number;
  readonly label: string;
  /**
   * `trade` was added for the live tape. It is deliberately a *different*
   * colour from `order`: `order` is something we did, `trade` is something the
   * market did to somebody. Merging them would let a judge read a stranger's
   * fill as evidence of their own burst.
   */
  readonly kind: "head" | "order" | "trade" | "info";
  readonly at: number;
}

export function ActivityFeed({
  items,
}: {
  readonly items: readonly ActivityFeedItem[];
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <header className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
          Live activity
        </h2>
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-zinc-600">
          Waiting for the first block or batch event…
        </p>
      ) : (
        <ol className="max-h-64 divide-y divide-zinc-900 overflow-y-auto px-4 font-mono text-[12px]">
          {items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-3 py-2">
              <span
                className={
                  item.kind === "order"
                    ? "text-emerald-400"
                    : item.kind === "trade"
                      ? "text-teal-300/90"
                      : item.kind === "head"
                        ? "text-violet-300"
                        : "text-zinc-400"
                }
              >
                {item.label}
              </span>
              <span className="shrink-0 text-[10px] text-zinc-600">
                {new Date(item.at).toLocaleTimeString("en-GB", { hour12: false })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

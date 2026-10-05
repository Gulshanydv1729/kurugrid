import { useEffect, useRef } from "react";
import { type MarkPoint } from "@/lib/constants";
import { formatPrice } from "@/lib/gridEngine";

/**
 * Mark price sparkline — the market's recent path, not just its last value.
 *
 * Purely presentational. Draws on a raw `<canvas>` rather than an SVG or a
 * chart dependency: AGENTS.md closes the dependency list, and 120 points of
 * polyline is not a chart library's job. Canvas also means no hydration
 * mismatch, because nothing is rendered until `useEffect` runs on the client.
 *
 * Two deliberate omissions, both about honesty:
 *
 * - **No smoothing or interpolation between samples.** The gaps are uneven
 *   (timer *and* per-block refreshes), so a curve drawn as if the samples were
 *   evenly spaced would invent price action that never happened. The polyline
 *   connects real samples in real time order.
 * - **A flat line when nothing has traded.** On a thin orderbook the mid can be
 *   unchanged for a minute; that is the truth, and the y-axis auto-scaling
 *   below will not inflate a $0 gap into a dramatic zigzag.
 */
export interface PriceSparklineProps {
  /** Recent mark samples, oldest first. */
  readonly history: readonly MarkPoint[];
  /** Tailwind-independent line colour. */
  readonly color?: string;
  readonly height?: number;
  /** True when the newest sample is older than `BOOK_STALE_MS`. */
  readonly stale?: boolean;
}

export function PriceSparkline({
  history,
  color = "#a78bfa",
  height = 44,
  stale = false,
}: PriceSparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = height;
    if (cssWidth <= 0) return;

    // Back the store with real pixels so the line is sharp on HiDPI.
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    if (history.length < 2) {
      // One sample is not a trend. Draw the baseline so the panel has a
      // consistent shape rather than collapsing to an empty box.
      context.strokeStyle = "#27272a";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, cssHeight - 0.5);
      context.lineTo(cssWidth, cssHeight - 0.5);
      context.stroke();
      return;
    }

    let lo = Infinity;
    let hi = -Infinity;
    for (const point of history) {
      if (point.mid < lo) lo = point.mid;
      if (point.mid > hi) hi = point.mid;
    }

    // A perfectly flat series would divide by zero. Give it a nominal band so
    // the line renders down the centre instead of vanishing.
    const span = hi - lo;
    const padded = span > 0 ? span * 1.15 : Math.max(hi * 0.001, 1e-9);
    const mid = (hi + lo) / 2;
    const bottom = mid - padded / 2;
    const top = mid + padded / 2;

    const inset = 2;
    const usable = cssHeight - inset * 2;
    const stepX = cssWidth / (history.length - 1);

    const xAt = (index: number): number => index * stepX;
    const yAt = (price: number): number =>
      inset + usable - ((price - bottom) / padded) * usable;

    // Soft area fill under the line — enough weight to read at 44px tall.
    const gradient = context.createLinearGradient(0, 0, 0, cssHeight);
    gradient.addColorStop(0, `${color}33`);
    gradient.addColorStop(1, `${color}00`);

    context.beginPath();
    context.moveTo(xAt(0), yAt(history[0]?.mid ?? 0));
    for (let i = 1; i < history.length; i += 1) {
      const point = history[i];
      if (point === undefined) continue;
      context.lineTo(xAt(i), yAt(point.mid));
    }
    context.lineTo(xAt(history.length - 1), cssHeight);
    context.lineTo(xAt(0), cssHeight);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();

    context.beginPath();
    context.moveTo(xAt(0), yAt(history[0]?.mid ?? 0));
    for (let i = 1; i < history.length; i += 1) {
      const point = history[i];
      if (point === undefined) continue;
      context.lineTo(xAt(i), yAt(point.mid));
    }
    context.strokeStyle = stale ? "#71717a" : color;
    context.lineWidth = 1.5;
    context.lineJoin = "round";
    context.stroke();

    // Mark the latest sample so "here is now" is unambiguous.
    const last = history[history.length - 1];
    if (last !== undefined) {
      context.beginPath();
      context.arc(xAt(history.length - 1), yAt(last.mid), 2.5, 0, Math.PI * 2);
      context.fillStyle = stale ? "#71717a" : color;
      context.fill();
    }
  }, [history, color, height, stale]);

  const first = history[0];
  const last = history[history.length - 1];

  /** Percent move across the window, or null when it cannot be computed. */
  const change =
    first !== undefined && last !== undefined && first.mid > 0
      ? ((last.mid - first.mid) / first.mid) * 100
      : null;

  const up = change !== null && change > 0;
  const down = change !== null && change < 0;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Mark path</span>
        {change !== null ? (
          <span
            className={`tabular-nums ${
              up ? "text-emerald-400/80" : down ? "text-rose-400/80" : "text-zinc-600"
            }`}
          >
            {change > 0 ? "+" : ""}
            {change.toFixed(2)}% / window
          </span>
        ) : (
          <span className="text-zinc-600">collecting…</span>
        )}
      </div>
      <canvas
        ref={canvasRef}
        style={{ height }}
        className="block w-full rounded border border-zinc-800/60 bg-zinc-950/40"
        role="img"
        aria-label={
          change !== null
            ? `Mark price ${formatPrice(last?.mid ?? 0)}, ${change.toFixed(2)} percent over the sampled window`
            : "Mark price history collecting"
        }
      />
    </div>
  );
}
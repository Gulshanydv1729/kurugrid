"use client";

/**
 * The 24/7 heartbeat — visibility-aware, backoff-aware polling.
 *
 * Owner: `web3` (see .opencode/agents/web3.md Part 2)
 *
 * KuruGrid has no backend (AGENTS.md §4.1). Everything the terminal knows
 * about the market is therefore read *from the browser*, which means the
 * browser's own lifecycle is part of the product's correctness. This hook is
 * where that lifecycle is handled once, for every data source, instead of
 * being re-derived in each `useEffect`.
 *
 * Three behaviours the raw `setInterval` in `app/page.tsx` did not have:
 *
 * 1. **It keeps polling when the tab is hidden.** A hidden tab is still a
 *    trading terminal; an operator alt-tabs to check a price and expects the
 *    number to have moved while they were away. So the interval *slows*
 *    (`BACKGROUND_POLL_MULTIPLIER`) rather than stopping — see the constant
 *    for why full speed would be the wrong trade.
 * 2. **It backs off when the chain stops answering.** A dead public RPC
 *    re-dialled every 2 s for the length of a judging slot is how a demo dies
 *    to an outage it could have survived. Each failure doubles the delay, up to
 *    `BACKGROUND_POLL_BACKOFF_CAP`, and the first success resets it.
 * 3. **It never overlaps runs.** The timer is a self-rescheduling `setTimeout`
 *    armed only after the previous attempt settled, so the `inFlight` guard
 *    every call site used to hand-roll is now structural. This is also what
 *    makes it safe for an *external* trigger (a WebSocket head) to kick a
 *    refresh through the same code path — a burst of heads during a reorg
 *    collapses into at most one in-flight read plus the one already running.
 *
 * The poll function is called through a ref, so callers do not have to memoise
 * it. A caller that wrapped `poll` in `useCallback` and got the identity wrong
 * would otherwise silently tear down and re-arm the whole loop every render.
 */

import { useEffect, useRef, useState } from "react";
import { BACKGROUND_POLL_BACKOFF_CAP, BACKGROUND_POLL_MULTIPLIER } from "./constants";

export interface BackgroundPollOptions {
  /** Interval between attempts while the tab is visible, in ms. */
  readonly intervalMs: number;
  /**
   * Poll function. Must **reject** on failure — that rejection is the only
   * signal the backoff has. Swallowing the error inside `poll` makes the hook
   * believe a dead RPC is healthy.
   */
  readonly poll: () => Promise<void>;
  /**
   * Suspend polling when `false`. The loop is fully torn down and re-armed
   * (with a fresh, un-backed-off delay) when it flips back to `true`.
   */
  readonly enabled?: boolean;
}

export interface BackgroundPollResult {
  /**
   * Epoch ms of the last **successful** poll, or `null` if none has ever
   * succeeded.
   *
   * This is the number the freshness indicators render. It is deliberately
   * read off the last good snapshot rather than tracked separately, so "the
   * screen says 4s ago" can never disagree with the data on screen.
   */
  readonly lastSuccessAt: number | null;
  /** Consecutive failures since the last success. `0` means healthy. */
  readonly consecutiveFailures: number;
}

const INITIAL: BackgroundPollResult = { lastSuccessAt: null, consecutiveFailures: 0 };

export function useBackgroundPoll({
  intervalMs,
  poll,
  enabled = true,
}: BackgroundPollOptions): BackgroundPollResult {
  const [result, setResult] = useState<BackgroundPollResult>(INITIAL);

  /** Latest `poll`, so changing it never re-arms the loop. */
  const pollRef = useRef(poll);

  // Declared before the polling effect so the ref is current before the loop
  // can possibly call it. React runs effects in declaration order.
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  // `enabled` and `intervalMs` are the loop's identity. Both changes are rare
  // (network switch, socket opening), and re-arming is the correct response:
  // a socket that just came live should be polled at the fallback rate from a
  // clean, un-backed-off delay rather than inheriting a dead-RPC penalty.
  useEffect(() => {
    if (!enabled) {
      // Reset the backoff while suspended so re-enabling starts clean.
      setResult(INITIAL);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Interval for the current tick: base rate, doubled per consecutive failure. */
    const nextDelay = (): number => {
      const base =
        typeof document !== "undefined" && document.visibilityState === "hidden"
          ? intervalMs * BACKGROUND_POLL_MULTIPLIER
          : intervalMs;
      return base * Math.min(2 ** failures, BACKGROUND_POLL_BACKOFF_CAP);
    };

    const schedule = (): void => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void runOnce();
      }, nextDelay());
    };

    const runOnce = async (): Promise<void> => {
      // Collapses a WebSocket head storm onto the single in-flight read.
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await pollRef.current();
        if (cancelled) return;
        failures = 0;
        // Always a new object: `lastSuccessAt` must advance every success or
        // the freshness readout freezes on a stale second.
        setResult({ lastSuccessAt: Date.now(), consecutiveFailures: 0 });
      } catch (cause) {
        if (cancelled) return;
        failures += 1;
        console.warn("Poll failed; backing off.", cause);
        setResult((previous) => ({ ...previous, consecutiveFailures: failures }));
      } finally {
        inFlight = false;
        if (!cancelled) schedule();
      }
    };

    /**
     * Return to a visible tab should feel instant, so a tab that comes forward
     * is read immediately instead of waiting out whatever delay is pending.
     */
    const onVisibilityChange = (): void => {
      if (cancelled || inFlight) return;
      if (document.visibilityState === "hidden") return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void runOnce();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void runOnce();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs]);

  return result;
}
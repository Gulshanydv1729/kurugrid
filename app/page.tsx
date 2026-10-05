"use client";

/**
 * Composition root — the only stateful module in the app.
 *
 * It owns wallet + grid + ladder state and calls the two library
 * boundaries: `gridEngine` (pure arithmetic) and `kuruClient`
 * (wallet + SDK). It contains no grid math and no wallet code of
 * its own.
 *
 * Every `window` / `performance` / `Math.random` access lives in
 * an effect or an event handler — never at module scope, never
 * during render — so the server pass is clean (verifier.md V2).
 */

import Image from "next/image";
import confetti from "canvas-confetti";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LogOut, Radio } from "lucide-react";
import { ConfigPanel } from "@/components/ConfigPanel";
import { OrderLadder } from "@/components/OrderLadder";
import {
  ActivityFeed,
  type ActivityFeedItem,
} from "@/components/ActivityFeed";
import { ExecutionTimeline } from "@/components/ExecutionTimeline";
import { PriceSparkline } from "@/components/PriceSparkline";
import { DataAge, LastTrade, isStaleReport } from "@/components/StaleBadge";
import {
  ACTIVE_NETWORK,
  APP_NAME,
  APP_TAGLINE,
  AUTO_RECENTER_DELAY_MS,
  BOOK_STALE_MS,
  DEFAULT_GRID_CONFIG,
  DEFAULT_MARKET_ADDRESS,
  HEAD_REFRESH_MIN_INTERVAL_MS,
  LIVE_FEED_FALLBACK_POLL_MS,
  MARKET_BOOK_POLL_MS,
  MARKET_LABEL,
  MARKET_STATUS_POLL_MS,
  MARK_HISTORY_MAX,
  SYNC_BAND_PCT,
  TELEMETRY_POLL_MS,
  TICK_FLASH_MS,
  TRADE_FEED_POLL_MS,
  isUnsetMarketAddress,
  type FundingCheck,
  toKuruGridError,
  type BatchResult,
  type GridConfig,
  type GridOrder,
  type KuruBookSnapshot,
  type MarketConstraints,
  type MarketStatusReport,
  type MarketTrade,
  type MarkPoint,
  type TelemetrySample,
} from "@/lib/constants";
import {
  adaptiveBounds,
  adaptiveHalfWidthPct,
  calculateGridOrders,
  checkGridAgainstMarket,
  computeVolatility,
  minimumCapitalForMarket,
  summarizeGrid,
  validateGridConfig,
  type GridSummary,
  type GridValidationResult,
} from "@/lib/gridEngine";
import {
  checkFundingReadiness,
  checkMarketStatus,
  fetchMarketConstraints,
  getTelemetryProvider,
  pingRpcLatency,
  placeParallelKuruOrders,
  watchOrderFills,
} from "@/lib/kuruClient";
import { useWallet } from "@/lib/wallet";
import { ConnectButton } from "@/components/ConnectButton";
import { Landing } from "@/components/Landing";
import { startLiveChannel } from "@/lib/liveChannel";
import { fetchMarketBook } from "@/lib/marketBook";
import { startTradeFeed } from "@/lib/tradeFeed";
import { useBackgroundPoll } from "@/lib/useBackgroundPoll";

export default function Page() {
  /* ---------------- state (the table from PLAN.md) ---------------- */

  const [config, setConfig] = useState<GridConfig>(DEFAULT_GRID_CONFIG);
  const [orders, setOrders] = useState<GridOrder[]>([]);
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetrySample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [book, setBook] = useState<KuruBookSnapshot | null>(null);
  const [tickDir, setTickDir] = useState<"up" | "down" | null>(null);
  const [marketReport, setMarketReport] = useState<MarketStatusReport | null>(
    null,
  );
  const [funding, setFunding] = useState<FundingCheck | null>(null);
  const [feedState, setFeedState] = useState<"live" | "polling">("polling");
  const [liveBlock, setLiveBlock] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityFeedItem[]>([]);
  /** Timed-mark history for the sparkline; capped at `MARK_HISTORY_MAX`. */
  const [markHistory, setMarkHistory] = useState<MarkPoint[]>([]);
  /** Newest print from the market, for the tape readout. */
  const [lastTrade, setLastTrade] = useState<MarketTrade | null>(null);
  /** Operator opt-in: re-centre the bounds when the mark leaves the band. */
  const [autoRecenter, setAutoRecenter] = useState(false);
  /**
   * Wall clock, advanced by a 1 s interval.
   *
   * The freshness readouts ("3s ago") need to count *up* between polls, and
   * nothing else in the app renders from the current time. One interval at the
   * root re-renders the whole page once a second, which is the one cost worth
   * paying — it keeps staleness visible instead of frozen on the value it had
   * at the last successful read.
   */
  const [now, setNow] = useState(() => Date.now());
  /**
   * The market's real trading constraints, read on-chain once per session.
   *
   * Cached deliberately: these are immutable for the life of a deployment, so
   * re-reading them on every render would be pure RPC load. Everything that
   * needs them — the pre-deploy gate in `handleDeploy` and the panel notice —
   * reads this same object, which is what stops the panel and the chain from
   * disagreeing about what is legal.
   */
  const [constraints, setConstraints] = useState<MarketConstraints | null>(null);

  /** External wallet store — the single source of truth for identity. */
  const wallet = useWallet();
  const address = wallet.account?.address ?? null;
  const chainId = wallet.account?.chainId ?? null;
  const connecting = wallet.status === "connecting";
  /** Synchronous deploy-in-flight flag (avoids stale-closure races). */
  const deployingRef = useRef(false);
  /** Rolling window of recent book mids for the volatility reading. */
  const midHistoryRef = useRef<number[]>([]);
  /** Stop function for the fill watcher, so a new deploy can cancel it. */
  const stopFillWatchRef = useRef<(() => void) | null>(null);
  /** Monotonic id source for the activity feed. */
  const activitySeqRef = useRef(0);
  /** Pending auto-recenter timer, so bounds are never moved mid-keystroke. */
  const autoRecenterRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pending clear for the up/down tick flash on the mark price. */
  const tickFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Timestamp of the last book read that *started*.
   *
   * Monad blocks every ~270 ms, so re-reading on every head is ~3.7 reads/s
   * and each read is two `eth_call`s. `HEAD_REFRESH_MIN_INTERVAL_MS` throttles
   * that to a sustainable rate — see the constant for why this is load-bearing
   * rather than an optimisation.
   */
  const lastBookReadRef = useRef(0);
  /**
   * Synchronous in-flight guard for the head-triggered read.
   *
   * The poll hook guards its *own* loop, but the WebSocket path is
   * fire-and-forget and would otherwise stack reads on a slow RPC: at ~270 ms
   * blocks a 2 s response time means three overlapping reads, each two
   * `eth_call`s, and the last one to land is not necessarily the freshest —
   * which would render a *stale* mid as the current mark. A ref rather than
   * state so the check is synchronous inside the handler.
   */
  const bookReadInFlightRef = useRef(false);

  const pushActivity = (label: string, kind: ActivityFeedItem["kind"]): void => {
    activitySeqRef.current += 1;
    const id = activitySeqRef.current;
    setActivity((previous) =>
      [{ id, label, kind, at: Date.now() }, ...previous].slice(0, 50),
    );
  };

  /** Cancel any running fill watcher (new deploy, unmount). */
  const cancelFillWatch = (): void => {
    stopFillWatchRef.current?.();
    stopFillWatchRef.current = null;
  };

  /** Cancel a pending auto-recenter. */
  const cancelAutoRecenter = (): void => {
    if (autoRecenterRef.current !== null) {
      clearTimeout(autoRecenterRef.current);
      autoRecenterRef.current = null;
    }
  };

  /** Tear down every timer this component owns. */
  useEffect(() => {
    return () => {
      cancelAutoRecenter();
      if (tickFlashRef.current !== null) clearTimeout(tickFlashRef.current);
    };
  }, []);

  /* ---------------- derived state ---------------- */

  // The reference mark is the REAL Kuru book mid when healthy,
  // otherwise the midpoint of the configured range (the safe,
  // deterministic fallback — the UI never shows a stale lie).
  const markPrice =
    book !== null ? book.mid : (config.lowerBound + config.upperBound) / 2;

  // Recomputed on every book update (book drives the render), so the
  // volatility always reflects the latest window of mids.
  const volatility = computeVolatility(midHistoryRef.current);

  /** Age of the newest mark sample, or null before the first read. */
  const markAge = markHistory.length > 0 ? now - (markHistory[markHistory.length - 1]?.at ?? now) : null;
  const bookStale = markAge !== null && markAge > BOOK_STALE_MS;

  const suggestedBounds = useMemo(
    () => (book !== null ? adaptiveBounds(book.mid, volatility) : null),
    [book, volatility],
  );

  const orderCounts = useMemo(() => {
    let submitted = 0;
    let pending = 0;
    let confirmed = 0;
    let filled = 0;
    let failed = 0;
    for (const order of orders) {
      switch (order.status) {
        case "PLACING":
          pending += 1;
          submitted += 1;
          break;
        case "CONFIRMED":
          confirmed += 1;
          submitted += 1;
          break;
        case "FILLED":
          filled += 1;
          submitted += 1;
          break;
        case "FAILED":
          failed += 1;
          break;
        default:
          break;
      }
    }
    return { submitted, pending, confirmed, filled, failed };
  }, [orders]);

  const validation = useMemo<GridValidationResult>(
    () =>
      validateGridConfig(
        config.lowerBound,
        config.upperBound,
        config.gridCount,
        config.capital,
        markPrice,
      ),
    [config, markPrice],
  );

  const summary = useMemo<GridSummary>(() => summarizeGrid(orders), [orders]);

  /**
   * The grid measured against the market's own rules.
   *
   * Derived from `orders` and `constraints` rather than stored, so it can never
   * describe a ladder other than the one on screen. `null` constraints (market
   * not loaded yet, or simulation) reports `ok` with nothing checked — an absent
   * constraint is not a violation, and treating it as one would break the
   * no-wallet demo.
   */
  const conformance = useMemo(
    () => checkGridAgainstMarket(orders, constraints),
    [orders, constraints],
  );

  /** Smallest capital that would make the current ladder legal. */
  const minCapital = useMemo(
    () => minimumCapitalForMarket(markPrice, config.gridCount, constraints),
    [markPrice, config.gridCount, constraints],
  );

  const settledLegs = summary.successCount + summary.failedCount;
  const onMonad = chainId === ACTIVE_NETWORK.chainId;

  /**
   * Login gate: the charts and grid stay hidden until the operator either
   * connects a wallet or enters via the no-wallet demo (which sets dryRun).
   * No backend, no session — this is a render gate on the wallet snapshot.
   */
  const authed = address !== null || dryRun;

  /* `handleSignOut` is defined above, next to the auto-recenter effect it
 * also has to cancel. */

  /* ---------------- effects ---------------- */

  // 1. Preview regeneration: the moment the config changes (and the
  //    config is valid), rebuild the ladder with status READY. Skipped
  //    while a deploy is in flight so live per-leg updates survive.
  useEffect(() => {
    if (deployingRef.current) return;
    if (!validation.valid) return;
    try {
      setOrders(
        calculateGridOrders(
          markPrice,
          config.lowerBound,
          config.upperBound,
          config.gridCount,
          config.capital,
        ),
      );
    } catch (cause) {
      // validation.valid === true guarantees calculateGridOrders
      // cannot throw with these inputs; if it somehow does, surface it.
      setError(toKuruGridError(cause, "Could not build the grid.").message);
    }
  }, [config, markPrice, validation.valid]);

  // 2. Telemetry poll: read-only RPC ping for the header latency
  //    figure. Re-throws so `useBackgroundPoll` backs off when the
  //    node stops answering; the last good sample stays on screen
  //    regardless, because nothing here clears it on failure.
  const refreshTelemetry = useCallback(async (): Promise<void> => {
    const sample = await pingRpcLatency();
    setTelemetry(sample);
  }, []);

  useBackgroundPoll({ poll: refreshTelemetry, intervalMs: TELEMETRY_POLL_MS });

  // 2b. Real market mark — reads the configured Kuru orderbook. The
  //     book's mid is the only honest reference price: it is the
  //     contract this grid will trade on. On failure the last good
  //     snapshot stays on screen; the mark falls back to the bounds
  //     midpoint only before the first snapshot.
  //
  //     `refreshBook` is a callback rather than a poll closure because
  //     TWO things must be able to trigger a read: the poll below, and
  //     every WebSocket head in effect 2d. Sharing one function is what
  //     keeps the per-block path and the timer path from drifting into
  //     two different readers.
  //
  //     It re-throws on failure rather than swallowing, because the
  //     backoff in `useBackgroundPoll` is driven purely by rejection —
  //     a swallowed error would make a dead RPC look healthy forever.
  const refreshBook = useCallback(async (): Promise<void> => {
    if (bookReadInFlightRef.current) return;
    bookReadInFlightRef.current = true;
    try {
      const provider = wallet.provider ?? getTelemetryProvider();
      const next = await fetchMarketBook(provider, DEFAULT_MARKET_ADDRESS);
      // `fetchedAt` is the read's own completion time and is what the
      // freshness readout renders, so it must come from the snapshot rather
      // than be re-stamped here — otherwise a queued read would claim to be
      // fresher than it is.
      lastBookReadRef.current = Date.now();
      const prev = midHistoryRef.current[midHistoryRef.current.length - 1];
      // Flash only when the mid actually moved. An unchanged tick would
      // otherwise re-arm the clear timer for nothing — two extra renders per
      // poll (review B10).
      if (prev !== undefined && next.mid !== prev) {
        setTickDir(next.mid > prev ? "up" : "down");
        if (tickFlashRef.current !== null) clearTimeout(tickFlashRef.current);
        tickFlashRef.current = setTimeout(() => {
          tickFlashRef.current = null;
          setTickDir(null);
        }, TICK_FLASH_MS);
      }
      midHistoryRef.current = [...midHistoryRef.current.slice(-19), next.mid];
      setMarkHistory((previous) =>
        [...previous, { mid: next.mid, at: next.fetchedAt }].slice(-MARK_HISTORY_MAX),
      );
      setBook(next);
    } finally {
      // Cleared even on failure, or one rejected read would wedge the mark
      // for the rest of the session.
      bookReadInFlightRef.current = false;
    }
  }, [wallet.provider]);

  useEffect(() => {
    return () => {
      if (tickFlashRef.current !== null) clearTimeout(tickFlashRef.current);
    };
  }, []);

  // Poll the book. When the socket is live it drives per-block refreshes
  // instead, so the timer drops to a slow safety net.
  const bookPoll = useBackgroundPoll({
    poll: refreshBook,
    intervalMs:
      feedState === "live" && liveBlock !== null
        ? LIVE_FEED_FALLBACK_POLL_MS
        : MARKET_BOOK_POLL_MS,
  });

  // 2c. Market status — probes the Kuru market contract with the
  //     connected wallet's provider (or the read-only fallback).
  const refreshStatus = useCallback(async (): Promise<void> => {
    const provider = wallet.provider ?? getTelemetryProvider();
    const report = await checkMarketStatus(DEFAULT_MARKET_ADDRESS, provider);
    setMarketReport(report);
  }, [wallet.provider]);

  useBackgroundPoll({ poll: refreshStatus, intervalMs: MARKET_STATUS_POLL_MS });

  // 2c-bis. Market constraints, read once and cached.
  //
  // Deliberately NOT a poll: precisions, tick size and size bounds are
  // immutable for the life of a Kuru deployment, so re-reading them on a timer
  // would spend RPC calls to learn nothing. `useBackgroundPoll` with a null
  // interval would still fetch, so this is a plain effect that fetches once and
  // re-fetches only when the provider changes (wallet connect / network switch).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (isUnsetMarketAddress(DEFAULT_MARKET_ADDRESS)) {
          if (!cancelled) setConstraints(null);
          return;
        }
        const provider = wallet.provider ?? getTelemetryProvider();
        const result = await fetchMarketConstraints(provider, DEFAULT_MARKET_ADDRESS);
        if (!cancelled) setConstraints(result);
      } catch (cause) {
        // No constraints is NOT a crash: the market-status probe owns the
        // "is this market readable" message. Staying null here keeps live
        // deploy blocked with the actionable status error rather than a
        // second, redundant one.
        if (!cancelled) setConstraints(null);
        console.warn("Could not read market constraints.", cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.provider]);

  // 2d. Live block feed over the WSS endpoint (QuickNode). If the
  //     endpoint is unset or the socket dies, the app keeps the
  //     polling path and badges the feed POLLING — never an error.
  useEffect(() => {
    const stop = startLiveChannel({
      onOpen: () => setFeedState("live"),
      onClose: () => setFeedState("polling"),
      onError: () => setFeedState("polling"),
      // An open-but-silent socket must not keep reporting LIVE: it would
      // also keep the book poll on its slow safety-net interval, so the
      // mark would quietly freeze. Demoting to POLLING restores both.
      onStale: () => setFeedState("polling"),
      onHead: (blockNumber) => {
        setLiveBlock(blockNumber);
        setFeedState("live");
        // A head is proof the book may have moved, so re-read it. Throttled
        // to HEAD_REFRESH_MIN_INTERVAL_MS because Monad blocks far faster than
        // the book is worth re-reading; unthrottled this is ~7 RPC calls a
        // second, which rate-limits the free endpoint and turns a healthy
        // terminal into a DEGRADED one.
        const sinceLast = Date.now() - lastBookReadRef.current;
        if (sinceLast < HEAD_REFRESH_MIN_INTERVAL_MS) return;
        lastBookReadRef.current = Date.now();
        void refreshBook().catch((cause: unknown) => {
          // Expected when the RPC is briefly unavailable; the poll loop's
          // own backoff is the recovery path. Not re-thrown here because
          // this path has no backoff owner — the throttled read is a bonus,
          // the timer poll remains the guarantee.
          console.warn("Per-block book read failed.", cause);
        });
      },
    });
    return stop;
  }, [refreshBook]);

  // 2f. Live trade tape — sweeps the market contract's `Trade` topic.
  //     Starts from the block it connects at, so it shows what is
  //     printing *now*, never a replay of history.
  useEffect(() => {
    const feed = startTradeFeed(
      getTelemetryProvider(),
      DEFAULT_MARKET_ADDRESS,
      (trade) => {
        setLastTrade(trade);
        pushActivity(
          `${trade.isBuy ? "BUY" : "SELL"} @ $${trade.price.toFixed(4)} · ${trade.size.toFixed(2)} MON`,
          "trade",
        );
      },
      TRADE_FEED_POLL_MS,
    );
    return feed.stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2g. Clock tick for the freshness readouts. One interval at the root
  //     rather than one per indicator, so the tick cost is paid once.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 2e. Funding preflight: only once a wallet is connected and the
  //     market is configured do we check whether the account actually
  //     holds enough USDC/MON for this grid. An under-funded account
  //     sees SIMULATION, not 20 doomed signatures.
  useEffect(() => {
    if (dryRun || address === null || wallet.provider === null) {
      setFunding(null);
      return;
    }
    if (!validation.valid || orders.length === 0) {
      setFunding(null);
      return;
    }
    const provider = wallet.provider;
    if (provider === null || address === null) {
      setFunding(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await checkFundingReadiness(
          provider,
          DEFAULT_MARKET_ADDRESS,
          address,
          orders,
        );
        if (!cancelled) setFunding(result);
      } catch (cause) {
        if (!cancelled) {
          setFunding({
            ok: false,
            quoteRequired: 0,
            quoteBalance: 0,
            baseRequired: 0,
            baseBalance: 0,
            reason: cause instanceof Error ? cause.message : "Funding check failed.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId, dryRun, orders, validation.valid]);

  /* ---------------- handlers ---------------- */

  const handleDeploy = async (): Promise<void> => {
    // Synchronous guard: a double-click before the re-render must
    // not start a second batch.
    if (deployingRef.current) return;
    setError(null);

    // Simulation mode never touches the wallet or the chain.
    if (!dryRun) {
      if (address === null || wallet.provider === null) {
        setError("Connect a wallet first.");
        return;
      }
      if (chainId !== ACTIVE_NETWORK.chainId) {
        setError(
          `Switch to ${ACTIVE_NETWORK.chainName} (chain ${ACTIVE_NETWORK.chainId}) first.`,
        );
        return;
      }
      if (isUnsetMarketAddress(DEFAULT_MARKET_ADDRESS)) {
        // AGENTS.md §7.4: fail fast, zero broadcasts.
        setError(
          "No Kuru market configured. Set NEXT_PUBLIC_KURU_MARKET_ADDRESS in .env.local (see .env.example), or enable Simulation mode.",
        );
        return;
      }
    }
    if (!validation.valid) {
      setError("Fix the grid configuration before deploying.");
      return;
    }

    // Market-conformance gate: every leg here is a separate wallet
    // signature on mainnet. If the market would reject a leg on its size or
    // tick rules, refuse the whole batch rather than spend a queue of
    // prompts to find out. Simulation is exempt — a mock book imposes no
    // constraints, and the demo must not depend on real market parameters.
    if (!dryRun && !conformance.ok) {
      // Only *fatal* violations block. An off-tick price is repaired by the
      // broadcast's own snap, so reporting it as a reason to refuse would
      // block a deploy that would in fact succeed.
      const fatal = conformance.violations.filter((v) => v.fatal);
      const first = fatal[0];
      setError(
        first === undefined
          ? "The generated grid does not satisfy the Kuru market's order constraints."
          : `${first.reason} ${fatal.length} of ${conformance.checked} orders are affected — fund at least $${minCapital.toFixed(2)}, or use fewer levels.`,
      );
      return;
    }

    // Live mode hard-gate: the connected account must actually hold
    // enough USDC/MON for this grid, otherwise the run is a wall of
    // reverts in front of judges. Simulation mode is always allowed.
    if (!dryRun && funding !== null && !funding.ok) {
      setError(
        `Wallet cannot cover this grid: ${funding.reason}. Fund the wallet, or enable Simulation mode.`,
      );
      return;
    }

    deployingRef.current = true;
    setDeploying(true);
    cancelFillWatch();
    try {
      // Rebuild from the exact config the user sees, so the preview
      // and the broadcast are the same ladder.
      const ladder = calculateGridOrders(
        markPrice,
        config.lowerBound,
        config.upperBound,
        config.gridCount,
        config.capital,
      );
      setOrders(ladder);

      // dryRun returns before the provider is touched; when no wallet
      // is connected a read-only provider is a harmless placeholder.
      const provider = wallet.provider ?? getTelemetryProvider();

      const result = await placeParallelKuruOrders(
        provider,
        DEFAULT_MARKET_ADDRESS,
        ladder,
        (next) => setOrders([...next]),
        { dryRun },
      );

      setBatch(result);

      // Live runs: watch the market contract for Trade events that
      // fill our resting legs. Patched rows flip CONFIRMED → FILLED
      // and each fill lands in the activity feed.
      cancelFillWatch();
      const orderIds = ladder.map((o) => o.orderId).filter((id): id is string => id !== null);
      if (!result.dryRun && orderIds.length > 0) {
        const telemetryProvider = getTelemetryProvider();
        stopFillWatchRef.current = watchOrderFills(
          telemetryProvider,
          DEFAULT_MARKET_ADDRESS,
          orderIds,
          (orderId, tradeTxHash) => {
            setOrders((previous) =>
              previous.map((order) =>
                order.orderId === orderId ? { ...order, status: "FILLED" } : order,
              ),
            );
            const leg = ladder.find((o) => o.orderId === orderId);
            const side = leg?.isBuy === true ? "BUY" : "SELL";
            pushActivity(
              `${side} @ $${leg ? leg.price.toFixed(4) : "?"} filled (${tradeTxHash.slice(0, 10)}…)`,
              "order",
            );
          },
        );
      }
      pushActivity(
        `batch settled: ${result.successCount}/${result.totalCount} legs · ${result.durationMs} ms · ${result.throughput} legs/s`,
        "info",
      );

      // Celebration fires exactly once, only on a real success —
      // in the handler, not an effect, so StrictMode cannot double it.
      if (result.successCount > 0) {
        confetti({
          particleCount: 90,
          spread: 70,
          origin: { y: 0.6 },
          colors: ["#8b5cf6", "#10b981", "#f43f5e"],
        });
      }
    } catch (cause) {
      const gridError = toKuruGridError(cause, "Deploy failed.");
      setError(gridError.message);
      setBatch(null);
      // No orphaned "Broadcasting" pills: any leg still in flight
      // is marked FAILED with the reason.
      setOrders((previous) =>
        previous.map((order) =>
          order.status === "PLACING"
            ? { ...order, status: "FAILED", error: gridError.message }
            : order,
        ),
      );
    } finally {
      deployingRef.current = false;
      setDeploying(false);
    }
  };

  /** Recenter the grid bounds ±SYNC_BAND_PCT around the live mark. */
  const handleSyncToMarket = useCallback((): void => {
    const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;
    setConfig((previous) => ({
      ...previous,
      lowerBound: round4(markPrice * (1 - SYNC_BAND_PCT)),
      upperBound: round4(markPrice * (1 + SYNC_BAND_PCT)),
    }));
  }, [markPrice]);

  /**
   * Auto-recenter: the grid follows the market while it is left alone.
   *
   * A grid whose bounds have been overtaken is not a grid — it is one-sided,
   * and `validateGridConfig` is already reporting `markInRange: false`. This
   * closes that gap on its own, but only when the operator asked for it and
   * only after the mark has *settled* outside the band. The debounce is the
   * whole feature: re-centring on the first out-of-range tick would let one
   * block of noise yank the bounds out from under someone mid-keystroke.
   *
   * Never fires during a deploy — moving the bounds while a burst is in flight
   * would desync the preview the operator approved from the batch they signed.
   */
  useEffect(() => {
    cancelAutoRecenter();
    if (!autoRecenter || book === null) return;
    if (!validation.valid) return;
    if (deployingRef.current) return;
    // Inside the band: nothing to do. This also resets the pending timer, so
    // a mark that dips out and back does not accumulate a debt.
    if (validation.markInRange) return;

    autoRecenterRef.current = setTimeout(() => {
      autoRecenterRef.current = null;
      if (deployingRef.current) return;
      handleSyncToMarket();
      pushActivity(
        `auto-recentred to ${markPrice.toFixed(4)} (mark left the band)`,
        "info",
      );
    }, AUTO_RECENTER_DELAY_MS);

    return cancelAutoRecenter;
  }, [
    autoRecenter,
    book,
    validation.valid,
    validation.markInRange,
    handleSyncToMarket,
    markPrice,
  ]);

  /** Re-sign-out must also stop any pending auto-recenter. */
  const handleSignOut = (): void => {
    cancelAutoRecenter();
    wallet.disconnect();
    setDryRun(false);
    setAutoRecenter(false);
    setError(null);
    setBatch(null);
    setOrders([]);
    setBook(null);
    setMarkHistory([]);
    setLastTrade(null);
  };

  /** One-click demo grid: small, tight, dry-run. No wallet needed. */
  const handleLoadDemo = (): void => {
    setDryRun(true);
    setError(null);
    setBatch(null);
    setConfig({
      lowerBound: Number((markPrice * 0.99).toFixed(4)),
      upperBound: Number((markPrice * 1.01).toFixed(4)),
      gridCount: 6,
      capital: 60,
    });
    pushActivity("demo grid loaded (dry run)", "info");
  };

  /** Apply the adaptive suggestion for the current volatility. */
  const handleApplyAdaptive = (): void => {
    if (suggestedBounds === null) return;
    setConfig({ ...config, ...suggestedBounds });
    pushActivity(
      `adaptive bounds applied (±${(adaptiveHalfWidthPct(volatility) * 100).toFixed(1)}%)`,
      "info",
    );
  };

  /* ---------------- render ---------------- */

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-violet-500/30 bg-violet-500/10 p-0.5">
              <Image
                src="/logo.png"
                alt=""
                width={28}
                height={23}
                // Static export emits no optimiser, so this has to be told.
                unoptimized
                className="h-auto w-full object-contain"
              />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-zinc-100">{APP_NAME}</h1>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {APP_TAGLINE}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Target chain badge (disconnected) or actual chain state */}
            {address === null ? (
              <span className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400 sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
                {ACTIVE_NETWORK.chainName} · {ACTIVE_NETWORK.chainId}
              </span>
            ) : (
              <span
                className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider sm:inline-flex ${
                  onMonad
                    ? "border-zinc-800 bg-zinc-900 text-zinc-400"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    onMonad ? "bg-violet-400" : "bg-rose-400"
                  }`}
                />
                {onMonad
                  ? `${ACTIVE_NETWORK.chainName} · ${ACTIVE_NETWORK.chainId}`
                  : `Chain ${chainId ?? "?"}`}
              </span>
            )}

            <span className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400 md:inline-flex">
              {MARKET_LABEL}
            </span>

            {/* Live RPC latency — the other half of the evidence. */}
            {telemetry !== null ? (
              <span
                className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] tabular-nums text-zinc-400 md:inline-flex"
                title="Read-only RPC round-trip"
              >
                <Radio className="h-3 w-3 text-violet-400" />
                {telemetry.latencyMs} ms
              </span>
            ) : null}

            <ConnectButton />
            {authed ? (
              <button
                type="button"
                onClick={handleSignOut}
                title="Disconnect and return to the login screen"
                className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {/* Error banner — every failure surfaces here, styled rose */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-10 pt-6">
        {!authed ? (
          <Landing
            fullPage
            onLoadDemo={handleLoadDemo}
            authError={wallet.error}
          />
        ) : (
          <>
            {error !== null ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs leading-relaxed text-rose-300"
          >
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <p>{error}</p>
          </div>
        ) : null}

        {/* Live market banner */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
          <div className="flex items-center gap-2">
            {marketReport?.status === "LIVE" ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                <span className="text-[11px] font-medium uppercase tracking-wider text-emerald-400">
                  Market: OPEN (24/7 Onchain)
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex h-2 w-2 rounded-full bg-amber-400" />
                <span className="text-[11px] font-medium uppercase tracking-wider text-amber-400">
                  HALTED / OFFLINE — SIMULATION
                </span>
              </>
            )}
          </div>

          <div className="flex items-baseline gap-3 font-mono text-sm tabular-nums">
            {book !== null ? (
              <span
                className={
                  bookStale
                    ? "text-zinc-500"
                    : tickDir === "up"
                      ? "text-emerald-400"
                      : tickDir === "down"
                        ? "text-rose-400"
                        : "text-zinc-100"
                }
              >
                ${book.mid.toFixed(4)}
              </span>
            ) : (
              <span className="text-zinc-600">mark unavailable</span>
            )}
            {/* Freshness, always. A price with no age attached is a price
                nobody can tell is 40 seconds old. */}
            <span className="font-mono text-[10px] text-zinc-600">
              <DataAge at={markAge} label="mark" now={now} />
            </span>
            {liveBlock !== null ? (
              <span className="font-mono text-[10px] text-zinc-600">
                block {liveBlock} · feed {feedState === "live" ? "LIVE" : "POLLING"}
              </span>
            ) : null}
          </div>

          {book !== null ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-500">
              <span>
                bid <span className="text-emerald-400/80">${book.bestBid?.toFixed(4) ?? "—"}</span>
                {" · "}
                ask <span className="text-rose-400/80">${book.bestAsk?.toFixed(4) ?? "—"}</span>
              </span>
              <span className="text-zinc-700">·</span>
              <span>vol {(volatility * 100).toFixed(2)}%</span>
              <span className="text-zinc-700">·</span>
              {/* The newest print from anyone, not just our own ladder. */}
              <span className="flex items-center gap-1.5">
                <span className="text-zinc-600">last</span>
                <LastTrade trade={lastTrade} />
              </span>
              {marketReport !== null && isStaleReport(marketReport, now) ? (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-amber-400/80">
                    status {Math.round((now - marketReport.checkedAt) / 1000)}s ago
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Mark path — the recent trend, so the terminal shows a market
            moving rather than a single number with no memory. */}
        {book !== null ? (
          <div className="mb-4 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
            <PriceSparkline history={markHistory} stale={bookStale} />
          </div>
        ) : null}

        <div id="terminal" className="grid scroll-mt-20 gap-6 lg:grid-cols-[380px_1fr]">
          <ConfigPanel
            config={config}
            onConfigChange={setConfig}
            validation={validation}
            markPrice={markPrice}
            address={address}
            chainId={chainId}
            isDeploying={deploying}
            settledLegs={settledLegs}
            totalLegs={orders.length}
            batch={batch}
            telemetry={telemetry}
            dryRun={dryRun}
            onDryRunChange={setDryRun}
            livePrice={book !== null ? book.mid : null}
            onSyncToMarket={handleSyncToMarket}
            onConnect={() => void wallet.connect()}
            onDeploy={handleDeploy}
            orderCounts={orderCounts}
            volatility={volatility}
            suggestedBounds={suggestedBounds}
            onApplyAdaptive={handleApplyAdaptive}
            onLoadDemo={handleLoadDemo}
            funding={funding}
            autoRecenter={autoRecenter}
            onAutoRecenterChange={setAutoRecenter}
            markInRange={validation.markInRange}
            conformance={conformance}
            minSizeHuman={constraints !== null ? constraints.minSizeHuman : null}
            minCapital={conformance.ok ? null : minCapital}
          />
          <div className="space-y-4">
            <OrderLadder
              orders={orders}
              summary={summary}
              markPrice={markPrice}
              isDeploying={deploying}
            />
            <ExecutionTimeline orders={orders} />
            <ActivityFeed items={activity} />
          </div>
        </div>
          </>
        )}
      </main>

      <footer className="mx-auto w-full max-w-7xl px-4 pb-8">
        <p className="text-center text-[11px] text-zinc-600">
          {APP_NAME} is client-only — keys never leave your wallet. Orders
          settle on the Kuru CLOB, {ACTIVE_NETWORK.chainName} (chain{" "}
          {ACTIVE_NETWORK.chainId}).
        </p>
      </footer>
    </div>
  );
}

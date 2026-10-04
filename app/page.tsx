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

import confetti from "canvas-confetti";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Radio, Wallet, Zap } from "lucide-react";
import { ConfigPanel } from "@/components/ConfigPanel";
import { OrderLadder } from "@/components/OrderLadder";
import {
  APP_NAME,
  APP_TAGLINE,
  DEFAULT_GRID_CONFIG,
  DEFAULT_MARKET_ADDRESS,
  MARKET_LABEL,
  MONAD_TESTNET,
  MARKET_FEED_POLL_MS,
  MARKET_STATUS_POLL_MS,
  TELEMETRY_POLL_MS,
  isUnsetMarketAddress,
  toKuruGridError,
  type BatchResult,
  type GridConfig,
  type GridOrder,
  type MarketStatusReport,
  type TelemetrySample,
} from "@/lib/constants";
import {
  calculateGridOrders,
  summarizeGrid,
  validateGridConfig,
  type GridSummary,
  type GridValidationResult,
} from "@/lib/gridEngine";
import {
  checkAndSwitchNetwork,
  checkMarketStatus,
  connectWallet,
  getTelemetryProvider,
  pingRpcLatency,
  placeParallelKuruOrders,
  type WalletConnection,
} from "@/lib/kuruClient";
import {
  fetchLiveTicker,
  type MarketTicker,
} from "@/lib/marketFeed";

export default function Page() {
  /* ---------------- state (the table from PLAN.md) ---------------- */

  const [config, setConfig] = useState<GridConfig>(DEFAULT_GRID_CONFIG);
  const [orders, setOrders] = useState<GridOrder[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetrySample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [ticker, setTicker] = useState<MarketTicker | null>(null);
  const [tickDir, setTickDir] = useState<"up" | "down" | null>(null);
  const [marketReport, setMarketReport] = useState<MarketStatusReport | null>(
    null,
  );

  /** The connected wallet's ethers provider — never rendered, so a ref. */
  const walletRef = useRef<WalletConnection | null>(null);
  /** Synchronous deploy-in-flight flag (avoids stale-closure races). */
  const deployingRef = useRef(false);

  /* ---------------- derived state ---------------- */

  // The reference mark is the live ticker when it is healthy,
  // otherwise the midpoint of the configured range (the safe,
  // deterministic fallback — the UI never shows a stale lie).
  const markPrice =
    ticker !== null ? ticker.price : (config.lowerBound + config.upperBound) / 2;

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

  const settledLegs = summary.successCount + summary.failedCount;
  const onMonad = chainId === MONAD_TESTNET.chainId;

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
  //    figure. Cleared on unmount — a leaked interval burns RPC
  //    quota mid-demo.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const sample = await pingRpcLatency();
        if (!cancelled) setTelemetry(sample);
      } catch (cause) {
        // Keep the last good sample on screen; the next tick retries.
        console.warn("Telemetry ping failed; keeping last sample.", cause);
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, TELEMETRY_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 2b. Live market ticker — polls every 3 s, flashes the mark
  //     green/red on direction change, keeps the last good sample
  //     on failure (fetchLiveTicker already falls back to cache).
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let previousPrice: number | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchLiveTicker();
        if (cancelled) return;
        if (previousPrice !== null) {
          if (next.price > previousPrice) setTickDir("up");
          else if (next.price < previousPrice) setTickDir("down");
          clearTimeout(flashTimer);
          flashTimer = setTimeout(() => setTickDir(null), 800);
        }
        previousPrice = next.price;
        setTicker(next);
      } catch (cause) {
        console.warn("Market ticker fetch failed; keeping last sample.", cause);
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, MARKET_FEED_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(flashTimer);
    };
  }, []);

  // 2c. Market status — probes the Kuru market contract with the
  //     connected wallet's provider (or the read-only fallback).
  useEffect(() => {
    let cancelled = false;

    const probe = async (): Promise<void> => {
      try {
        const provider =
          walletRef.current !== null
            ? walletRef.current.provider
            : getTelemetryProvider();
        const report = await checkMarketStatus(DEFAULT_MARKET_ADDRESS, provider);
        if (!cancelled) setMarketReport(report);
      } catch (cause) {
        if (!cancelled) {
          setMarketReport({
            status: "DEGRADED",
            detail: cause instanceof Error ? cause.message : "Status probe failed.",
            checkedAt: Date.now(),
          });
        }
      }
    };

    void probe();
    const timer = setInterval(() => {
      void probe();
    }, MARKET_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 3. Wallet event listeners, removed on cleanup.
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const injected = window.ethereum;

    const onAccountsChanged = (...args: unknown[]): void => {
      const accounts = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
      const first = accounts[0];
      if (typeof first === "string" && first !== "") {
        setAddress(first);
      } else {
        // Wallet disconnected or locked — drop the session.
        setAddress(null);
        walletRef.current = null;
      }
    };

    const onChainChanged = (...args: unknown[]): void => {
      const raw = args[0];
      if (typeof raw !== "string") return;
      // EIP-1193 delivers chain ids as hex strings ("0x279f").
      const next = Number.parseInt(raw, 16);
      setChainId(Number.isFinite(next) ? next : null);
    };

    injected.on?.("accountsChanged", onAccountsChanged);
    injected.on?.("chainChanged", onChainChanged);

    return () => {
      injected.removeListener?.("accountsChanged", onAccountsChanged);
      injected.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  /* ---------------- handlers ---------------- */

  const handleConnect = async (): Promise<void> => {
    setError(null);
    setConnecting(true);
    try {
      const wallet = await connectWallet();
      walletRef.current = wallet;
      setAddress(wallet.address);
      const check = await checkAndSwitchNetwork();
      setChainId(check.chainId);
    } catch (cause) {
      // Includes EIP-1193 4001 — "you rejected", not an app error,
      // and never auto-retried.
      setError(toKuruGridError(cause, "Wallet connection failed.").message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDeploy = async (): Promise<void> => {
    // Synchronous guard: a double-click before the re-render must
    // not start a second batch.
    if (deployingRef.current) return;
    setError(null);

    // Simulation mode never touches the wallet or the chain.
    if (!dryRun) {
      if (address === null || walletRef.current === null) {
        setError("Connect a wallet first.");
        return;
      }
      if (chainId !== MONAD_TESTNET.chainId) {
        setError(
          `Switch to ${MONAD_TESTNET.chainName} (chain ${MONAD_TESTNET.chainId}) first.`,
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

    deployingRef.current = true;
    setDeploying(true);
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
      const provider =
        walletRef.current !== null
          ? walletRef.current.provider
          : getTelemetryProvider();

      const result = await placeParallelKuruOrders(
        provider,
        DEFAULT_MARKET_ADDRESS,
        ladder,
        (next) => setOrders([...next]),
        { dryRun },
      );

      setBatch(result);

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

  /** Recenter the grid bounds ±15% around the live mark. */
  const handleSyncToMarket = (): void => {
    if (ticker === null) return;
    const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;
    setConfig({
      ...config,
      lowerBound: round4(ticker.price * 0.85),
      upperBound: round4(ticker.price * 1.15),
    });
  };

  /* ---------------- render ---------------- */

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-violet-500/30 bg-violet-500/10">
              <Zap className="h-4 w-4 text-violet-400" />
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
                {MONAD_TESTNET.chainName} · {MONAD_TESTNET.chainId}
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
                  ? `${MONAD_TESTNET.chainName} · ${MONAD_TESTNET.chainId}`
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

            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="flex items-center gap-2 rounded-md border border-violet-500/50 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-300 transition-colors hover:bg-violet-500/20 disabled:cursor-wait disabled:opacity-60"
            >
              <Wallet className="h-3.5 w-3.5" />
              {connecting
                ? "Connecting…"
                : address !== null
                  ? `${address.slice(0, 6)}…${address.slice(-4)}`
                  : "Connect"}
            </button>
          </div>
        </div>
      </header>

      {/* Error banner — every failure surfaces here, styled rose */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-10 pt-6">
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

          <div className="font-mono text-sm tabular-nums">
            {ticker !== null ? (
              <span
                className={
                  tickDir === "up"
                    ? "text-emerald-400"
                    : tickDir === "down"
                      ? "text-rose-400"
                      : "text-zinc-100"
                }
              >
                ${ticker.price.toFixed(2)}
              </span>
            ) : (
              <span className="text-zinc-600">mark unavailable</span>
            )}
          </div>

          {ticker !== null ? (
            <div className="font-mono text-[11px] tabular-nums text-zinc-500">
              24h{" "}
              <span className="text-rose-400/80">${ticker.low24h.toFixed(2)}</span>
              {" – "}
              <span className="text-emerald-400/80">${ticker.high24h.toFixed(2)}</span>
              <span className="mx-2 text-zinc-700">·</span>
              <span className={ticker.change24h >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {ticker.change24h >= 0 ? "+" : ""}
                {ticker.change24h.toFixed(2)}%
              </span>
            </div>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
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
            livePrice={ticker !== null ? ticker.price : null}
            onSyncToMarket={handleSyncToMarket}
            onConnect={handleConnect}
            onDeploy={handleDeploy}
          />
          <OrderLadder
            orders={orders}
            summary={summary}
            markPrice={markPrice}
            isDeploying={deploying}
          />
        </div>
      </main>

      <footer className="mx-auto w-full max-w-7xl px-4 pb-8">
        <p className="text-center text-[11px] text-zinc-600">
          {APP_NAME} is client-only — keys never leave your wallet. Orders
          settle on the Kuru CLOB, {MONAD_TESTNET.chainName} (chain{" "}
          {MONAD_TESTNET.chainId}).
        </p>
      </footer>
    </div>
  );
}

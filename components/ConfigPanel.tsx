import { AlertTriangle, Info, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ACTIVE_NETWORK,
  AUTO_RECENTER_DELAY_MS,
  DEFAULT_MARKET_ADDRESS,
  MAX_GRID_COUNT,
  MIN_GRID_COUNT,
  isUnsetMarketAddress,
  type BatchResult,
  type GridConfig,
  type MarketConformance,
  type TelemetrySample,
} from "@/lib/constants";
import { type FundingCheck } from "@/lib/constants";
import { formatPrice, type GridValidationResult } from "@/lib/gridEngine";

/**
 * Left panel — grid configuration, derived funding preconditions,
 * the deploy button state machine, and the telemetry card.
 *
 * Purely presentational: every input is controlled and writes straight
 * into `app/page.tsx` state via `config` + `onConfigChange`. No grid
 * math, no wallet code, no SDK.
 */
export interface ConfigPanelProps {
  readonly config: GridConfig;
  readonly onConfigChange: (config: GridConfig) => void;
  /** Live validation — drives inline errors and the deploy gate. */
  readonly validation: GridValidationResult;
  /** Reference mark price (live ticker, falling back to range midpoint). */
  readonly markPrice: number;
  readonly address: string | null;
  readonly chainId: number | null;
  readonly isDeploying: boolean;
  /** Settled legs (confirmed + failed) for the live progress label. */
  readonly settledLegs: number;
  readonly totalLegs: number;
  readonly batch: BatchResult | null;
  readonly telemetry: TelemetrySample | null;
  readonly dryRun: boolean;
  readonly onDryRunChange: (value: boolean) => void;
  /** Live mark price, or null before the first ticker sample. */
  readonly livePrice: number | null;
  /** Recenter the grid bounds ±15% around the live mark. */
  readonly onSyncToMarket: () => void;
  /** Triggers the wallet connect / network-switch flow. */
  readonly onConnect: () => void;
  readonly onDeploy: () => void;
  /**
   * Verdict from checking the grid against the market's real constraints.
   *
   * `null` when the market has not loaded (or in simulation), which is
   * explicitly *not* a failure: a mock book has no constraints.
   */
  readonly conformance: MarketConformance | null;
  /** Market's minimum order size in MON, for the "how to fix it" copy. */
  readonly minSizeHuman: number | null;
  /** Smallest capital that would make this grid legal. */
  readonly minCapital: number | null;
  /** Live counts of legs by lifecycle bucket. */
  readonly orderCounts: {
    readonly submitted: number;
    readonly pending: number;
    readonly confirmed: number;
    readonly filled: number;
    readonly failed: number;
  };
  /** Current volatility reading (stdev of log returns), 0–1. */
  readonly volatility: number;
  /** Suggested bounds from the adaptive model; null without a book. */
  readonly suggestedBounds: { lowerBound: number; upperBound: number } | null;
  /** Apply the adaptive suggestion to the config. */
  readonly onApplyAdaptive: () => void;
  /** One-click dry-run demo preset. */
  readonly onLoadDemo: () => void;
  /** Preflight funding verdict for the connected wallet. */
  readonly funding: FundingCheck | null;
  /** Auto-recenter enabled: the bounds follow the mark when it leaves the band. */
  readonly autoRecenter: boolean;
  /** Toggle auto-recenter. */
  readonly onAutoRecenterChange: (value: boolean) => void;
  /** False while the mark sits outside the configured range. */
  readonly markInRange: boolean;
}

export function ConfigPanel({
  config,
  onConfigChange,
  validation,
  markPrice,
  address,
  chainId,
  isDeploying,
  settledLegs,
  totalLegs,
  batch,
  telemetry,
  dryRun,
  onDryRunChange,
  livePrice,
  onSyncToMarket,
  onConnect,
  onDeploy,
  orderCounts,
  volatility,
  suggestedBounds,
  onApplyAdaptive,
  onLoadDemo,
  funding,
  autoRecenter,
  onAutoRecenterChange,
  markInRange,
  conformance,
  minSizeHuman,
  minCapital,
}: ConfigPanelProps) {
  const onMonad = chainId === ACTIVE_NETWORK.chainId;
  const marketConfigured = !isUnsetMarketAddress(DEFAULT_MARKET_ADDRESS);
  /** Live deploy needs a real market address; simulation does not. */
  const deployBlocked = !marketConfigured && !dryRun;
  /**
   * Live deploy is also blocked while the grid violates the market's own
   * size/tick rules.
   *
   * This is the pre-flight that keeps real money out of doomed signatures.
   * Every one of those legs is a separate wallet prompt on mainnet, so
   * discovering the min-size rule only after signing would burn the
   * operator's patience and their gas. Simulation is exempt on purpose —
   * a mock orderbook has no minimum size to violate.
   */
  const conformanceBlocked = !dryRun && conformance !== null && !conformance.ok;
  /**
   * Only the *fatal* findings — the ones the market will actually reject.
   *
   * `violations` also carries tick-snap entries, which are repaired by the
   * broadcast path and are not a reason to refuse anything. Counting them here
   * would tell the operator "8 orders rejected" when the chain would have
   * accepted 11 of them and snapped 7 prices by $3e-8.
   */
  const fatalViolations =
    conformance === null ? [] : conformance.violations.filter((v) => v.fatal);

  /**
   * Deploy button state machine (frontend.md), in precedence order:
   * deploying → no wallet → wrong chain → invalid/blocked → default.
   * The wrong-chain state is actionable — clicking it re-runs the
   * connect flow, which prompts the network switch.
   */
  let buttonLabel = "Deploy Parallel Grid";
  let buttonDisabled = false;
  let buttonAction = onDeploy;
  let buttonClass =
    "bg-violet-500 text-white hover:bg-violet-400 focus-visible:ring-2 focus-visible:ring-violet-500/50";

  if (isDeploying) {
    buttonLabel = `Broadcasting ${settledLegs}/${totalLegs}…`;
    buttonDisabled = true;
    buttonClass =
      "cursor-wait bg-violet-500/70 text-white";
  } else if (address === null && !dryRun) {
    buttonLabel = "Connect Wallet First";
    buttonDisabled = true;
    buttonClass = "cursor-not-allowed bg-zinc-800 text-zinc-500";
  } else if (!dryRun && !onMonad) {
    buttonLabel = `Switch to ${ACTIVE_NETWORK.chainName}`;
    buttonAction = onConnect;
    buttonClass =
      "border border-rose-500/50 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 focus-visible:ring-2 focus-visible:ring-rose-500/50";
  } else if (!validation.valid || deployBlocked) {
    buttonLabel = "Deploy Parallel Grid";
    buttonDisabled = true;
    buttonClass = "cursor-not-allowed bg-violet-500/20 text-violet-300/50";
  } else if (conformanceBlocked) {
    // Say what is wrong, not just "no". An operator who is told only that
    // deploy is unavailable has no idea which knob to turn. The count is of
    // *fatal* findings, because those are the legs the chain will reject.
    buttonLabel =
      fatalViolations.length > 0
        ? `${fatalViolations.length} Orders Fail Market Rules`
        : "Fix Market Constraints";
    buttonDisabled = true;
    buttonClass = "cursor-not-allowed bg-amber-500/20 text-amber-300/60";
  } else if (!dryRun && funding !== null && !funding.ok) {
    buttonLabel = "Fund Wallet to Go Live";
    buttonDisabled = true;
    buttonClass = "cursor-not-allowed bg-amber-500/20 text-amber-300/60";
  } else if (batch !== null) {
    buttonLabel = "Deploy Another Grid";
    buttonClass =
      "border border-violet-500/50 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 focus-visible:ring-2 focus-visible:ring-violet-500/50";
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 shadow-panel">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Grid Config
          </h2>
          <span className="font-mono text-[11px] tabular-nums text-zinc-500">
            mark <span className="text-zinc-300">{formatPrice(markPrice)}</span>
          </span>
        </header>

        <div className="space-y-4 p-4">
          {/* Bounds */}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Lower Bound"
              hint="$"
              error={validation.errors.lowerBound}
            >
              <NumberField
                value={config.lowerBound}
                onChange={(value) => onConfigChange({ ...config, lowerBound: value })}
                step="0.0001"
                min="0"
                ariaLabel="Lower bound in USDC"
                invalid={Boolean(validation.errors.lowerBound)}
              />
            </Field>
            <Field
              label="Upper Bound"
              hint="$"
              error={validation.errors.upperBound}
            >
              <NumberField
                value={config.upperBound}
                onChange={(value) => onConfigChange({ ...config, upperBound: value })}
                step="0.0001"
                min="0"
                ariaLabel="Upper bound in USDC"
                invalid={Boolean(validation.errors.upperBound)}
              />
            </Field>
          </div>

          {/* Sync bounds to the live mark, centered ±SYNC_BAND_PCT */}
          <button
            type="button"
            onClick={onSyncToMarket}
            disabled={livePrice === null || isDeploying}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3" />
            {livePrice !== null
              ? `Sync to Market — ${livePrice.toFixed(4)}`
              : "Sync to Market"}
          </button>

          {/* Auto-recenter — the grid follows the mark on its own.
              Off by default: silently moving an operator's bounds is the
              kind of help that costs trust, so this has to be asked for. */}
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                <RefreshCw
                  className={`h-3.5 w-3.5 shrink-0 ${
                    autoRecenter ? "text-violet-400" : "text-zinc-600"
                  }`}
                />
                Auto-recenter
              </span>
              <span className="text-[10px] leading-snug text-zinc-600">
                Re-centre the band on the mark when it leaves the range
                {" · "}
                {AUTO_RECENTER_DELAY_MS / 1000}s debounce
              </span>
            </span>
            <span className="relative inline-flex h-5 w-9 shrink-0">
              <input
                type="checkbox"
                role="switch"
                aria-label="Auto-recenter grid bounds on the live mark"
                checked={autoRecenter}
                onChange={(event) => onAutoRecenterChange(event.target.checked)}
                className="peer sr-only"
              />
              <span className="absolute inset-0 rounded-full bg-zinc-700 transition-colors peer-checked:bg-violet-500" />
              <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-[18px]" />
            </span>
          </label>

          {/* The mark left the band — say so, and say what it costs. */}
          {!markInRange ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-300">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <p>
                The mark has left your range, so the ladder is one-sided.
                {autoRecenter
                  ? ` It will re-centre on its own in ${AUTO_RECENTER_DELAY_MS / 1000}s.`
                  : " Sync to Market to re-centre it."}
              </p>
            </div>
          ) : null}

          {/* Grid count — slider with live integer readout + derived step */}
          <Field
            label="Grid Count"
            error={validation.errors.gridCount}
            hint={
              <span className="font-mono text-sm tabular-nums text-zinc-200">
                {config.gridCount}
              </span>
            }
          >
            <input
              type="range"
              min={MIN_GRID_COUNT}
              max={MAX_GRID_COUNT}
              step={1}
              value={config.gridCount}
              onChange={(event) =>
                onConfigChange({ ...config, gridCount: Number(event.target.value) })
              }
              aria-label="Grid count"
              className="w-full accent-violet-500"
            />
            <p className="font-mono text-[11px] tabular-nums text-zinc-500">
              step <span className="text-zinc-300">{formatPrice(validation.stepPrice)}</span>
              <span className="mx-2 text-zinc-700">·</span>
              <span className="text-emerald-400/80">{validation.buyLegs} bids</span>
              <span className="mx-1 text-zinc-700">·</span>
              <span className="text-rose-400/80">{validation.sellLegs} asks</span>
            </p>
          </Field>

          {/* Capital */}
          <Field label="Capital" hint="USDC" error={validation.errors.capital}>
            <NumberField
              value={config.capital}
              onChange={(value) => onConfigChange({ ...config, capital: value })}
              step="1"
              min="0"
              ariaLabel="Capital in USDC"
              invalid={Boolean(validation.errors.capital)}
            />
          </Field>

          {/* Derived funding preconditions — the numbers a judge
              needs before a live deploy can possibly succeed. */}
          <div className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 font-mono text-[11px] tabular-nums text-zinc-500">
            <div className="flex items-center justify-between gap-3">
              <span>USDC per level</span>
              <span className="text-zinc-300">${validation.notionalPerLevel.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <Info className="h-3 w-3 text-zinc-600" />
                Required MON inventory
              </span>
              <span className="text-zinc-300">
                {validation.requiredMonInventory.toFixed(4)} MON
              </span>
            </div>
          </div>

          {/* Market constraints — read from the market, never assumed.
              Shown even when the grid is legal, because "200 MON minimum"
              is the single fact that explains why the ladder looks the way
              it does. */}
          {minSizeHuman !== null && !dryRun ? (
            <div className="space-y-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 font-mono text-[10px] tabular-nums text-zinc-600">
              <div className="flex items-center justify-between gap-3">
                <span>Market min size</span>
                <span className="text-zinc-400">
                  {minSizeHuman.toLocaleString("en-US", { maximumFractionDigits: 4 })} MON
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Smallest order</span>
                <span className="text-zinc-400">
                  ≈$
                  {(minSizeHuman * markPrice).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            </div>
          ) : null}

          {/* Non-conforming grid — the pre-flight that prevents signing a
              batch the market will reject. */}
          {conformance !== null && !conformance.ok ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-300"
            >
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">
                  The generated grid contains{" "}
                  {fatalViolations.length}{" "}
                  {fatalViolations.length === 1 ? "order" : "orders"} the Kuru
                  market would reject
                  {conformance.checked > 0
                    ? ` (${conformance.conforming}/${conformance.checked} legal).`
                    : "."}
                </p>
                {fatalViolations[0] !== undefined ? (
                  <p className="text-amber-200/80">{fatalViolations[0].reason}</p>
                ) : null}
                {minCapital !== null && minCapital > 0 ? (
                  <p className="text-amber-200/80">
                    Raise capital to about ${minCapital.toFixed(2)} (
                    {config.gridCount} levels × $
                    {(minSizeHuman !== null
                      ? minSizeHuman * markPrice
                      : minCapital / config.gridCount
                    ).toFixed(2)}{" "}
                    a leg) or reduce the level count.
                  </p>
                ) : null}
                <p className="text-zinc-500">
                  Live deploy is blocked until these conform. Simulation is
                  unaffected.
                </p>
              </div>
            </div>
          ) : null}

          {/* Tick-snap disclosure — shown when the ladder is deployable but the
              market's tick grid will move a few prices. Not a warning: the
              broadcast path snaps them deterministically and by at most half a
              tick. Disclosed because a ladder the operator approved and a ladder
              the chain receives should never differ without saying so. */}
          {conformance !== null && conformance.ok && conformance.snaps > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-500">
              <Info className="mt-px h-3.5 w-3.5 shrink-0 text-zinc-600" />
              <p>
                {conformance.snaps} of {conformance.checked} prices sit off the
                market&apos;s tick grid and will be snapped to it on broadcast —
                a sub-cent rounding on each.
              </p>
            </div>
          ) : null}

          {/* Market address — honest fail-fast notice (AGENTS.md §7) */}
          {!marketConfigured ? (
            <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-rose-300">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <p>
                No Kuru market configured. Set{" "}
                <code className="rounded bg-zinc-900 px-1 font-mono">
                  NEXT_PUBLIC_KURU_MARKET_ADDRESS
                </code>{" "}
                (see <code className="rounded bg-zinc-900 px-1 font-mono">.env.example</code>)
                or enable Simulation mode below.
              </p>
            </div>
          ) : null}

          {/* Funding preflight — an unfunded account must see
              simulation, never a wall of reverted legs. */}
          {funding !== null && !funding.ok ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-300">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <p>
                Live mode blocked: {funding.reason}. Fund the wallet, or enable
                Simulation mode below — the dry run always works.
              </p>
            </div>
          ) : null}

          {/* Simulation mode — opt-in dry run, no wallet needed */}
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
            <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
              <Sparkles className="h-3.5 w-3.5 text-violet-400" />
              Simulation mode
            </span>
            <span className="flex items-center gap-2">
              <span
                className={`font-mono text-[10px] uppercase tracking-wider ${
                  dryRun ? "text-violet-400" : "text-zinc-500"
                }`}
              >
                {dryRun ? "Simulated" : "Live"}
              </span>
              <span className="relative inline-flex h-5 w-9 shrink-0">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Simulation mode"
                  checked={dryRun}
                  onChange={(event) => onDryRunChange(event.target.checked)}
                  className="peer sr-only"
                />
                <span className="absolute inset-0 rounded-full bg-zinc-700 transition-colors peer-checked:bg-violet-500" />
                <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-[18px]" />
              </span>
            </span>
          </label>
        </div>

        {/* Deploy button */}
        <div className="border-t border-zinc-800 p-4">
          <button
            type="button"
            onClick={buttonAction}
            disabled={buttonDisabled}
            className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition-colors ${buttonClass}`}
          >
            {isDeploying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {buttonLabel}
          </button>
          {address === null && !dryRun ? (
            <p className="mt-2 text-center text-[11px] text-zinc-500">
              Connect MetaMask to broadcast live. Simulation mode works without a
              wallet.
            </p>
          ) : null}
        </div>
      </section>

      {/* Telemetry card — the proof of the parallelism claim */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 shadow-panel">
        <header className="border-b border-zinc-800 px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Telemetry
          </h2>
        </header>
        <dl className="divide-y divide-zinc-900 px-4 font-mono text-[12px] tabular-nums">
          <TelemetryRow
            label="RPC latency"
            value={telemetry !== null ? `${telemetry.latencyMs} ms` : "—"}
            sub={telemetry !== null ? `block ${telemetry.blockNumber}` : undefined}
          />
          <TelemetryRow
            label="Batch duration"
            value={batch !== null ? `${batch.durationMs} ms` : "—"}
          />
          <TelemetryRow label="Legs settled" value={`${settledLegs}/${totalLegs}`} />
          <TelemetryRow
            label="Throughput"
            value={batch !== null ? `${batch.throughput} legs/s` : "—"}
          />
          <TelemetryRow
            label="Mode"
            value={
              batch !== null
                ? batch.dryRun
                  ? "SIMULATED"
                  : "LIVE"
                : dryRun
                  ? "SIMULATED"
                  : "LIVE"
            }
            valueClass={
              batch !== null
                ? batch.dryRun
                  ? "text-violet-400"
                  : "text-zinc-300"
                : dryRun
                  ? "text-violet-400"
                  : "text-zinc-300"
            }
          />
          <TelemetryRow label="Orders submitted" value={String(orderCounts.submitted)} />
          <TelemetryRow label="Confirmed" value={String(orderCounts.confirmed)} />
          <TelemetryRow label="Filled" value={String(orderCounts.filled)} />
          <TelemetryRow label="Pending" value={String(orderCounts.pending)} />
          <TelemetryRow label="Failed" value={String(orderCounts.failed)} />
          <TelemetryRow
            label="Volatility"
            value={`${(volatility * 100).toFixed(2)}%`}
            sub="stdev of mid returns"
          />
          {suggestedBounds !== null ? (
            <div className="py-2">
              <button
                type="button"
                onClick={onApplyAdaptive}
                className="w-full rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-violet-300 transition-colors hover:bg-violet-500/20"
              >
                Apply adaptive bounds {suggestedBounds.lowerBound.toFixed(4)}–
                {suggestedBounds.upperBound.toFixed(4)}
              </button>
            </div>
          ) : null}
          <div className="py-2">
            <button
              type="button"
              onClick={onLoadDemo}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
            >
              One-click demo grid (dry run)
            </button>
          </div>
          {batch !== null && batch.dryRun && !dryRun ? (
            <p className="py-2 text-[11px] text-violet-300">
              This run was simulated (SDK unavailable) — the figures above are not
              from the chain.
            </p>
          ) : null}
        </dl>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small presentational pieces
 * ------------------------------------------------------------------ */

interface FieldProps {
  readonly label: string;
  readonly hint?: React.ReactNode;
  readonly error?: string;
  readonly children: React.ReactNode;
}

function Field({ label, hint, error, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          {label}
        </label>
        {hint}
      </div>
      {children}
      {error !== undefined ? (
        <p className="text-[11px] leading-snug text-rose-400">{error}</p>
      ) : null}
    </div>
  );
}

interface NumberFieldProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly step: string;
  readonly min: string;
  readonly ariaLabel: string;
  readonly invalid: boolean;
}

/**
 * A controlled number input that keeps its own text mirror while
 * focused, so typing decimals is not eaten by the numeric value
 * (React would otherwise reset "0.0" back to "0" mid-keystroke).
 * The store only ever receives a finite number.
 */
function NumberField({
  value,
  onChange,
  step,
  min,
  ariaLabel,
  invalid,
}: NumberFieldProps) {
  const [text, setText] = useState<string>(String(value));
  const [focused, setFocused] = useState(false);

  // Re-sync the mirror whenever the store changes and the user is
  // not mid-edit.
  useEffect(() => {
    if (!focused) setText(Number.isFinite(value) ? String(value) : "");
  }, [value, focused]);

  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      aria-label={ariaLabel}
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next === "") {
          onChange(0);
          return;
        }
        const parsed = Number(next);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      className={`w-full rounded-md border bg-zinc-950 px-3 py-2 font-mono text-sm tabular-nums text-zinc-200 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40 ${
        invalid ? "border-rose-500/50" : "border-zinc-800"
      }`}
    />
  );
}

interface TelemetryRowProps {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly valueClass?: string;
}

function TelemetryRow({ label, value, sub, valueClass }: TelemetryRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd className={`tabular-nums text-zinc-200 ${valueClass ?? ""}`}>
        {value}
        {sub !== undefined ? (
          <span className="ml-2 text-[10px] text-zinc-600">{sub}</span>
        ) : null}
      </dd>
    </div>
  );
}

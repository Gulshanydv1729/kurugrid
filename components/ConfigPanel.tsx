import { AlertTriangle, Info, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DEFAULT_MARKET_ADDRESS,
  MAX_GRID_COUNT,
  MIN_GRID_COUNT,
  MONAD_TESTNET,
  isUnsetMarketAddress,
  type BatchResult,
  type GridConfig,
  type TelemetrySample,
} from "@/lib/constants";
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
}: ConfigPanelProps) {
  const onMonad = chainId === MONAD_TESTNET.chainId;
  const marketConfigured = !isUnsetMarketAddress(DEFAULT_MARKET_ADDRESS);
  /** Live deploy needs a real market address; simulation does not. */
  const deployBlocked = !marketConfigured && !dryRun;

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
    buttonLabel = "Switch to Monad Testnet";
    buttonAction = onConnect;
    buttonClass =
      "border border-rose-500/50 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 focus-visible:ring-2 focus-visible:ring-rose-500/50";
  } else if (!validation.valid || deployBlocked) {
    buttonLabel = "Deploy Parallel Grid";
    buttonDisabled = true;
    buttonClass = "cursor-not-allowed bg-violet-500/20 text-violet-300/50";
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

          {/* Sync bounds to the live mark, centered ±15% */}
          <button
            type="button"
            onClick={onSyncToMarket}
            disabled={livePrice === null || isDeploying}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3" />
            {livePrice !== null
              ? `Sync to Market — ${livePrice.toFixed(2)}`
              : "Sync to Market"}
          </button>

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
            value={dryRun ? "SIMULATED" : "LIVE"}
            valueClass={dryRun ? "text-violet-400" : "text-zinc-300"}
          />
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

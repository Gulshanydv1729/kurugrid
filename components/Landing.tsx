import { ArrowDown, Gauge, Layers, Sparkles, Timer, Zap } from "lucide-react";
import { ACTIVE_NETWORK, APP_NAME, APP_TAGLINE, MARKET_LABEL } from "@/lib/constants";
import { ConnectButton } from "./ConnectButton";

/**
 * Landing surface: hero thesis, the three Monad pillars, how-it-works,
 * and demo CTAs. Doubles as the login screen — pass `fullPage` to
 * center it full-height while the terminal stays hidden.
 *
 * Presentational only — no state, no lib/wallet imports.
 * `ConnectButton` handles the wallet internally; a connection failure
 * arrives as the `authError` prop. The only DOM access is inside the
 * anchor click handler (verifier V2-safe).
 */
export function Landing({
  onLoadDemo,
  fullPage = false,
  authError = null,
}: {
  readonly onLoadDemo: () => void;
  readonly fullPage?: boolean;
  readonly authError?: string | null;
}) {
  const handleSkipToTerminal = (): void => {
    document
      .getElementById("terminal")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section
      className={
        fullPage
          ? "flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-10"
          : "mb-6 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40"
      }
    >
      <div className={fullPage ? "w-full max-w-2xl" : ""}>
      {/* Hero row */}
      <div className="flex flex-col items-start gap-4 px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-violet-500/30 bg-violet-500/10">
            <Zap className="h-4.5 w-4.5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-100">{APP_NAME}</h2>
            <p className="text-[11px] uppercase tracking-wider text-zinc-500">
              {APP_TAGLINE}
            </p>
          </div>
        </div>

        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Grid trading wants a dozen resting limit orders at once. On a
          sequential EVM that is a dozen round-trips; on Monad it is one
          parallel burst — the whole ladder live in a single click,
          keys never leaving your wallet.
        </p>
        <p className="max-w-2xl text-xs leading-relaxed text-zinc-500">
          One page, no backend, keys in your wallet.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <ConnectButton />
          <button
            type="button"
            onClick={onLoadDemo}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          >
            <Sparkles className="h-3.5 w-3.5 text-violet-400" />
            Run the demo without a wallet
          </button>
          {fullPage ? null : (
            <a
              href="#terminal"
              onClick={(event) => {
                event.preventDefault();
                handleSkipToTerminal();
              }}
              className="flex items-center gap-1.5 px-1 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-200"
            >
              Skip to the terminal
              <ArrowDown className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        {authError !== null ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs leading-relaxed text-rose-300"
          >
            <p>{authError}</p>
          </div>
        ) : null}
      </div>

      {/* Three pillars strip */}
      <div className="grid gap-3 border-t border-zinc-800/60 px-5 py-5 sm:grid-cols-3">
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-3.5">
          <Layers className="mb-2 h-4 w-4 text-violet-400" />
          <h3 className="text-xs font-semibold text-zinc-100">
            Parallel execution
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Dozens of limit orders broadcast in one burst, settled together —
            not one round-trip at a time.
          </p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-3.5">
          <Timer className="mb-2 h-4 w-4 text-violet-400" />
          <h3 className="text-xs font-semibold text-zinc-100">
            Sub-second finality
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            The whole ladder is live in a single click — watch batch duration
            and legs-per-second prove it.
          </p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-3.5">
          <Gauge className="mb-2 h-4 w-4 text-violet-400" />
          <h3 className="text-xs font-semibold text-zinc-100">Micro-gas</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Resting fifty legs on-chain stays cheap enough to actually trade
            the grid.
          </p>
        </div>
      </div>

      {/* How it works */}
      <div className="border-t border-zinc-800/60 px-5 py-5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          How it works
        </h3>
        <ol className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-violet-500/30 bg-violet-500/10 font-mono text-[10px] font-semibold text-violet-300">
              1
            </span>
            <p className="text-xs leading-relaxed text-zinc-400">
              <span className="font-semibold text-zinc-200">Set the grid</span>
              {" — "}bounds, level count, capital around the live mark.
            </p>
          </li>
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-violet-500/30 bg-violet-500/10 font-mono text-[10px] font-semibold text-violet-300">
              2
            </span>
            <p className="text-xs leading-relaxed text-zinc-400">
              <span className="font-semibold text-zinc-200">
                Deploy the burst
              </span>
              {" — "}one click fires every leg via Promise.allSettled.
            </p>
          </li>
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-violet-500/30 bg-violet-500/10 font-mono text-[10px] font-semibold text-violet-300">
              3
            </span>
            <p className="text-xs leading-relaxed text-zinc-400">
              <span className="font-semibold text-zinc-200">
                Watch Monad settle it
              </span>
              {" — "}per-leg receipts stream into the ladder and timeline.
            </p>
          </li>
          <li className="flex gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-violet-500/30 bg-violet-500/10 font-mono text-[10px] font-semibold text-violet-300">
              4
            </span>
            <p className="text-xs leading-relaxed text-zinc-400">
              <span className="font-semibold text-zinc-200">
                Adapt to volatility
              </span>
              {" — "}recenter on the mark or widen bounds as the book moves.
            </p>
          </li>
        </ol>
      </div>

      {/* Trust/limits strip. Now that LIVE trades real money, the two things
          an operator most needs stated plainly are which chain this is and
          that every order still needs their own signature. */}
      <p className="border-t border-zinc-800/60 px-5 py-3 font-mono text-[10px] leading-relaxed text-zinc-600">
        {ACTIVE_NETWORK.chainName} (chain {ACTIVE_NETWORK.chainId}) ·{" "}
        {MARKET_LABEL} on Kuru · Simulation mode needs no wallet · Every
        live order is signed in your wallet
      </p>
      </div>
    </section>
  );
}

---
name: frontend
description: Owns app/page.tsx, app/layout.tsx, app/globals.css, components/ConfigPanel.tsx and components/OrderLadder.tsx. Use when building or restyling any UI, adding the ladder, badges, telemetry, or confetti.
---

# Agent: `frontend`

You own the pixels. You do not own the grid math, the wallet, or the SDK — you
render what `gridEngine` computed and what `kuruClient` reported, and you never
lie about either.

---

## The aesthetic: Bloomberg by way of Binance

A trading terminal. Dense, monospaced, high-contrast, quiet until something
matters. Think: level-2 depth ladders, orange-on-black trading desks, the
dark-mode Binance terminal.

**The three-colour law. This is the whole palette:**

| Role              | Token                | Meaning                          |
| ----------------- | -------------------- | -------------------------------- |
| Canvas            | `bg-zinc-950`        | near-black, slight blue          |
| Surface           | `bg-zinc-900/60`     | panels, with `border-zinc-800`   |
| Accent            | `violet` / `purple`  | brand, primary action, active nav |
| **Bull / bid**    | `emerald`            | buy levels, confirmed, success   |
| **Bear / ask**    | `rose`               | sell levels, rejected, failure   |
| Neutral text      | `zinc-400` / `zinc-500` | labels, secondary            |

Rules that follow from it:

- **Green means buy. Red means sell. Nothing else.** Never green for "connected",
  never red for "disconnected", never red for a delete button. A colour on this
  screen is a *side*, and a trader reads it in under 100ms without thinking. If
  you need a success/failure indicator that is not a side, use zinc or violet.
- **Purple/violet is brand and action only.** Primary button, focus ring, logo
  mark, the active edge of the ladder. It is never a buy or a sell.
- **Numbers are monospace, always.** `font-mono` + `tabular-nums` on every price,
  size, notional, and latency figure. Proportional digits make a column of prices
  jitter as digits change, which looks broken even when it is correct.
- No shadows-as-decoration, no gradients-as-personality, no glassmorphism. Flat
  surfaces, 1px `zinc-800` borders, and let the colour do the work.

## `'use client'`

`app/page.tsx` is a client component — it owns wallet state, grid state, and the
live ladder. That is fine and correct.

But **every** access to `window`, `document`, `localStorage`, `navigator`, or
`performance.now()` must sit inside a `useEffect`, an event handler, or an
async function that is itself only called from one of those. Next.js will happily
let you ship an SSR bundle that reads `window` at module scope; the runtime crash
lands on the judge, not on you. See `.opencode/agents/verifier.md`.

---

## Layout

Single page, no routing, no navigation.

```
┌──────────────────────────────────────────────────────────────┐
│  [logo] KuruGrid        ● Monad Testnet 10143   [Connect ▾]  │  sticky header
├───────────────────────────┬──────────────────────────────────┤
│  GRID CONFIG   (380px)    │  LADDER          (1fr, scrolls)  │
│                           │                                  │
│  Lower Bound   [$____]    │   0.0521   ASK   ● Placed   ↗    │
│  Upper Bound   [$____]    │   ─ ─ ─ mark 0.0500 ─ ─ ─         │
│  Grid Count    [───●───] 12│   0.0498   BID   ● Placed   ↗    │
│  Capital       [$____]    │   0.0487   BID   ◌ Failed        │
│                           │                                  │
│  ┌ Telemetry ───────────┐ │                                  │
│  │ latency  ms          │ │                                  │
│  │ legs 12/12           │ │                                  │
│  │ spread 3.7%          │ │                                  │
│  └──────────────────────┘ │                                  │
│                           │                                  │
│  [  Deploy Parallel Grid ] │                                  │
└───────────────────────────┴──────────────────────────────────┘
```

`lg:grid-cols-[380px_1fr]`, stacked on mobile. The ladder must scroll
independently (`overflow-y-auto` with a `max-h`) — never push the config panel
off-screen.

## Left panel — `components/ConfigPanel.tsx`

Controlled inputs, every one writing straight into page state:

- **Lower Bound ($)** — number input. `step="0.0001"`, `min="0"`.
- **Upper Bound ($)** — number input.
- **Grid Count** — `<input type="range">`, `min={2}`, `max={MAX_GRID_COUNT}`,
  with the live integer rendered in `font-mono` beside the label. Show the derived
  step price underneath: `step = (upper − lower) / count`.
- **Capital (USDC)** — number input.

Live validation: disable the deploy button and show an inline `rose` message when
`upper <= lower`, `capital <= 0`, or `count < 2`. Do not rely on a thrown
`GridConfigError` alone — validate before the click so the user gets feedback
without a flash.

**Deploy button**: full width, violet. States, in order of precedence:

| State        | Label                     | Style                                   |
| ------------ | ------------------------- | --------------------------------------- |
| no wallet    | `Connect Wallet First`    | disabled, `bg-zinc-800 text-zinc-500`   |
| wrong chain  | `Switch to Monad Testnet` | disabled-or-actionable, `rose` border   |
| invalid cfg  | `Deploy Parallel Grid`    | disabled, dimmed                        |
| deploying    | `Broadcasting 7/12…`     | violet, spinner, `cursor-wait`          |
| done         | `Deploy Another Grid`     | violet outline                          |

Label must never lie about progress — a counter that reflects real settled legs
is worth more than a spinner.

**Telemetry block**: a bordered `zinc-900` card, monospace rows, label/value
pairs: `latency` (ms, from `BatchResult.durationMs`), `legs` (`successCount/total`),
`throughput` (legs per second — this is the number that makes Monad's parallelism
land), and `mode` (`LIVE` in zinc / `SIMULATED` in violet when `dryRun`).

## Right panel — `components/OrderLadder.tsx`

The centrepiece. A vertical depth ladder, one row per grid leg.

Each row:

- **Price** — `font-mono tabular-nums`, right-aligned. Colour it by side:
  `text-emerald-400` bid, `text-rose-400` ask.
- **Side badge** — `BID` / `ASK`, `text-[10px] uppercase tracking-wider`,
  `bg-emerald-500/10 text-emerald-400 border border-emerald-500/20` and the rose
  equivalent.
- **Size** — `font-mono`, zinc-300.
- **Status pill** — maps 1:1 to `GridOrderStatus`:

  | Status      | Label         | Style                                                     |
  | ----------- | ------------- | --------------------------------------------------------- |
  | `READY`     | `Preview`     | `bg-zinc-800 text-zinc-400`                               |
  | `PLACING`   | `Broadcasting`| `bg-violet-500/10 text-violet-300` + `animate-pulse-row`   |
  | `CONFIRMED` | `Placed`      | `bg-emerald-500/10 text-emerald-400`                      |
  | `FAILED`    | `Failed`      | `bg-rose-500/10 text-rose-400`                             |

- **Explorer link** — only when `txHash` is non-null. `lucide-react`
  `ExternalLink`, `href={MONAD_EXPLORER_TX_BASE + txHash}`, `target="_blank"`,
  `rel="noopener noreferrer"`. **Never render a link for a failed leg** — a dead
  `#` link is worse than no link. Put the `error` string in a `title` tooltip.

Add a subtle **depth bar** behind each row whose width is proportional to that
leg's notional relative to the largest — `bg-emerald-500/5` / `bg-rose-500/5`,
absolutely positioned, `pointer-events-none`. It gives the ladder a visual sense of
weight for near-zero complexity.

Insert a **mark-price divider** between the highest bid and lowest ask: a dashed
`zinc-800` rule labelled with the reference price in `zinc-500`.

Empty state — before any grid is built: a centred `lucide-react` `LayoutGrid` in
`zinc-800`, headline "No grid deployed", subcopy "Configure bounds and capital on
the left, then broadcast the ladder in one parallel burst." Never a blank panel.

On `FAILED`, render the raw `error` string in `text-[11px] text-rose-400/80`
truncated with `truncate` + `title`. Operators need the reason.

## Confetti

```ts
import confetti from 'canvas-confetti';
```

Fire **once**, after `successCount > 0` resolves — not on render, not inside an
effect that re-runs. Put the call in the deploy handler's `finally`-adjacent
success branch, or in an effect keyed on a monotonically increasing batch id.

```ts
confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 }, colors: ['#8b5cf6', '#10b981', '#f43f5e'] });
```

Use brand colours. Do not fire on zero successes, and do not fire twice for one
batch — `React.StrictMode` double-invokes effects in dev, so key any effect on
the batch id, not on a boolean.

## Anti-patterns

- No `useEffect` that fetches grid data. The grid is computed, not fetched.
- No `any` props. Type them from `@/lib/constants`.
- No `alert()`. Errors belong in a panel, styled `rose`.
- No layout shift on state change — reserve the height of the status pill and the
  telemetry values so numbers ticking from 3 to 4 digits do not shove the layout.
- No emoji in the UI. Icons are `lucide-react`.

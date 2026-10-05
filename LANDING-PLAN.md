# Plan — Landing Page

## Objective

Replace the compact in-page `Landing` banner with a full landing *surface*: hero thesis, the three Monad pillars, how-it-works, and a demo CTA — while keeping the trading terminal the first interactive thing on the page and adding no new routes, no backend, no persistence.

## Current State

- `components/Landing.tsx` (53 lines) — one `<section>` rendered above the terminal grid in `app/page.tsx` (line 684). Contains a small logo, one paragraph, `ConnectButton`, and the dry-run demo button.
- The page below it is the entire product: ConfigPanel + OrderLadder + ExecutionTimeline + ActivityFeed.
- `app/` has only `page.tsx` — no route for a separate landing, and `output: "export"` keeps it that way.
- The judges' path is `open URL → see thesis → click demo or connect → watch the ladder deploy`. Every second before the ladder matters.

**Ambiguity to flag:** "Landing page" could mean a standalone marketing route (`/landing`, `/` redirects). Under a static export this is possible, but it would bury the terminal behind a click — the exact opposite of a demo. This plan assumes the landing lives **in-page above the terminal**, upgraded to a real hero, with a "skip to the terminal" anchor. If a standalone marketing page is actually wanted, that's a different plan and needs an `agent1` decision.

## Proposed Architecture

```
app/page.tsx
  └── components/Landing.tsx        — REWRITE (hero, pillars, how-it-works, CTAs)
        ├── same props: { onLoadDemo }
        ├── presentational only — no state, no lib/wallet imports
        └── anchor #terminal → smooth-scroll to the grid section
  └── <div id="terminal"> …existing grid…  unchanged
```

No new files, no new routes, no deps. Static export unchanged.

## Implementation Steps

**1. `components/Landing.tsx`** — full rewrite, four blocks:

- **Hero row.** `Zap` mark, `APP_NAME` + `APP_TAGLINE`, one-line thesis (keep the existing sentence — it's already the bounty claim), second line of sub-copy: "One page, no backend, keys in your wallet." CTAs: `ConnectButton` (verbatim extraction) + "Run the demo without a wallet" (existing `onLoadDemo`) + tertiary `Skip to the terminal ↓` anchor to `#terminal`.
- **Three pillars strip** (reuses the README language): Parallel execution · Sub-second finality · Micro-gas — three `zinc-900/60` cards, lucide icons (`Layers`, `Timer`, `Gauge` — verify they exist in lucide-react v1.52 before use, R-15 rule).
- **How it works** — 4 steps with the existing copy: `1 Set the grid → 2 Deploy the burst → 3 Watch Monad settle it → 4 Adapt to volatility`.
- **Trust/limits strip** — one muted line: "Testnet only · Simulation mode needs no wallet · Market address configured via `NEXT_PUBLIC_KURU_MARKET_ADDRESS`." Keeps honesty visible on the landing itself.

**2. `app/page.tsx`** — two edits only:
- Wrap the existing grid div with `<div id="terminal" className="scroll-mt-20">` (sticky header offset).
- Add `scroll-behavior: smooth` is **not** allowed at the HTML level in globals without care — instead use `document.getElementById('terminal')?.scrollIntoView({ behavior: 'smooth' })` in the CTA handler (a click handler, so it's V2-safe). Keep the anchor as a plain `<a href="#terminal">` fallback.

**3. `components/Landing.tsx` props** — unchanged: `{ onLoadDemo: () => void }`. No wallet imports — `ConnectButton` already handles that internally.

## Testing

- Gates: `npm run typecheck`, `npm run lint`, `npm run build`.
- V2 SSR grep: no `window`/`document` in the component body except the click handler; no hydration mismatch — all copy is static.
- Manual: `npx serve out` → landing renders, demo button runs the dry-run ladder, connect button opens the wallet, "Skip to the terminal" scrolls, banner market state (LIVE / DEGRADED / checking…) is unchanged under the landing.
- No test runner exists; grid-engine/unit-level behavior is untouched.

## Risks

- **Landing buries the demo** — mitigated: the terminal is one scroll away, anchored, and the demo CTA is in the hero row.
- **Icon availability in lucide-react v1.52** — verify `Layers`, `Timer`, `Gauge` exist before importing; fall back to already-used `Zap`/`Sparkles`/`Radio` if not (R-15: never `@ts-ignore`).
- **Copy drift from the README** — the pillars sentence should match README §"Why Monad?"; keep it identical to avoid the "docs lie about the code" failure mode.

## Files To Change

| File | Change |
| --- | --- |
| `components/Landing.tsx` | Full rewrite — hero, pillars, how-it-works, trust line, anchor CTA |
| `app/page.tsx` | Add `id="terminal"` wrapper + smooth-scroll handler for the anchor |
| (none else) | `ConfigPanel`, `OrderLadder`, `lib/*`, `app/layout.tsx` untouched |

## Execution Order

1. Verify lucide icon names (30 s grep in `node_modules/lucide-react`).
2. Rewrite `Landing.tsx` → gates.
3. Edit `page.tsx` (anchor + scroll handler) → gates + `npx serve out` smoke test.

## Work Split Across 3 Agents

**`frontend` (owner of `components/` + `app/`)**

| Task | File | Acceptance |
| --- | --- | --- |
| 1. Rewrite the Landing hero (logo, thesis, sub-copy, 3 CTAs) | `components/Landing.tsx` | Copy matches README §Why Monad?; CTAs wired to `ConnectButton` + `onLoadDemo` + `#terminal` |
| 2. Add the pillars strip, 4-step how-it-works, trust line | `components/Landing.tsx` | Three cards, icon names verified against lucide v1.52, one-line honesty strip |
| 3. Anchor the terminal + smooth-scroll handler | `app/page.tsx` | `id="terminal"` present, sticky-header offset, demo gate path unchanged |

**`verifier` (adversarial, then back to frontend)**

| Task | File | Acceptance |
| --- | --- | --- |
| 4. Run V1–V4 against the new Landing | `components/Landing.tsx`, `app/page.tsx` | zero `npm run typecheck` errors, no `window`/`document` outside a click handler, no `: any`, no hydration-risk copy |
| 5. Manual pass with `npx serve out` | the built `out/` bundle | landing renders, demo button simulates the ladder, SIMULATED badge shows, anchor scrolls, market banner state unchanged, no address in view-source |

**`pitch` (docs only)**

| Task | File | Acceptance |
| --- | --- | --- |
| 6. Screenshot / describe the new landing in README | `README.md` | Quick start still accurate; if the landing's copy changed, README "What it does" matches it verbatim |

**`agent1` (self)**

| Task | File | Acceptance |
| --- | --- | --- |
| 7. Reconcile the master status table + decision log | `.opencode/agents/agent1.md` | New row for the landing work; one decision-log line: landing is in-page, no `/landing` route, reason |

**Sequence:** `frontend` tasks 1–3 → `verifier` 4–5 → `frontend` fixes anything flagged → `pitch` 6 → `agent1` 7. One agent at a time; every handoff runs `typecheck` + `lint` + `build`.


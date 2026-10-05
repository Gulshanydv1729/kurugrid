# Paper2Agent: Research-to-Agent Framework

## Overview

Paper2Agent is a research-to-agent framework that transforms scientific research papers and repositories into MCP (Model Context Protocol) tools. It implements a 10-phase pipeline that:

1. Analyzes research papers to understand scientific problems
2. Inspects research repositories to identify implementable operations
3. Determines runtime requirements and dependencies
4. Selects meaningful scientific operations for tool generation
5. Validates original implementations through reference execution
6. Generates thin MCP adapter tools that wrap original code
7. Tests all generated tools comprehensively
8. Independently verifies tool correctness
9. Repairs issues (max 3 attempts)
10. Packages complete, independently runnable projects

The framework ensures that generated MCP tools are thin adapters that call original repository implementations - never fabricating or duplicating scientific functionality.

## Landing Surface (KuruGrid Terminal)

The root page is the KuruGrid trading terminal, and it opens with a
login screen (`components/Landing.tsx` in `fullPage` mode) — no wallet,
no charts. Connecting a wallet, or *Run the demo without a wallet*
(dry-run simulation), unlocks the terminal: market banner, config
panel, order ladder, execution timeline, and activity feed. There is no
backend and no session: the gate is a render condition on the wallet
snapshot (`address !== null || dryRun`), and *Sign out* in the header
disconnects and returns to login. A failed connect surfaces as a rose
error on the login screen itself. It contains four blocks:

1. **Hero row** — the thesis ("a dozen round-trips on a sequential EVM,
   one parallel burst on Monad"), plus two CTAs: connect wallet and *Run
   the demo without a wallet* (dry-run, no wallet needed). No skip-link
   in login mode — the terminal is hidden, not below the fold.
2. **Three pillars** — Parallel execution · Sub-second finality ·
   Micro-gas.
3. **How it works** — Set the grid → Deploy the burst → Watch Monad
   settle it → Adapt to volatility.
4. **Trust strip** — LIVE mode trades real funds on Monad Mainnet, simulation
   needs no wallet, market address via `NEXT_PUBLIC_KURU_MARKET_ADDRESS`.

Serve the static bundle with `npx serve out` after `npm run build`;
the landing copy above is prerendered into the static HTML.

## Live 24/7 Market Data

A CLOB has no sessions and no close, so "live" cannot mean "correct when the
tab opened". The terminal keeps reading the chain continuously and always says
how old its numbers are.

| Signal | Source | Cadence |
| --- | --- | --- |
| Mark price (bid/ask/mid) | `OrderBook.getL2OrderBook` on the configured market | every block via WSS, else 10 s |
| Market status (LIVE/DEGRADED) | deployed code + `getMarketParams` | 15 s |
| Live trade tape | `Trade` topic on the market contract | 5 s sweep |
| Block head | `newHeads` WebSocket subscription | push |
| RPC latency | `eth_blockNumber` round-trip | 5 s |

Four behaviours make it survive a long session:

- **Background polling.** A hidden tab keeps polling at 3x the foreground
  rate, so the mark never falls more than ~30 s behind. An operator who
  alt-tabs to check a price finds a terminal that moved while they were away.
- **Backoff on failure.** Each consecutive failure doubles the delay, capped
  at 8x. A dead public RPC is not re-dialled every 2 s for the length of a demo,
  and recovery is automatic — no reload.
- **Freshness, always visible.** Every reading renders its own age
  (`4s ago`), and goes amber past `BOOK_STALE_MS`. A price with no age attached
  is a price nobody can tell is 40 seconds old.
- **Socket staleness detection.** An open-but-silent WebSocket is demoted to
  `POLLING`, because intermediaries drop idle sockets without a close frame —
  a monitor trusting `onopen` alone would report LIVE while refreshing nothing.

Set `NEXT_PUBLIC_MONAD_WSS_URL` to get per-block mark updates. Unset, everything
above still runs on timers; you lose only sub-10-second mark updates.

**Auto-recenter** (off by default) re-centres the bounds ±4 % on the mark when
it has stayed outside `[lowerBound, upperBound]` for 30 s. The debounce is the
feature: re-centring on the first out-of-range tick would let one block of noise
move bounds out from under an operator mid-keystroke. It never fires during a
deploy, which would desync the approved preview from the signed batch.

**The sparkline** plots real samples in real time order with no interpolation.
Gaps are uneven — the book is read on a timer *and* per block — so a curve drawn
as if the samples were evenly spaced would invent price action that never
happened. A flat line when nothing has traded is likewise the truth.

## Quick Start

### Prerequisites

- Node.js v20+ (verified: v26.10.0)
- npm v12+ (verified: npm 12.2.0)
- Python 3.8+ (optional, for Python-dependent repositories)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd kurugrid

# Install dependencies
npm install --no-audit --no-fund --maxsockets=2 \
  --fetch-timeout=1800000 --fetch-retries=8 \
  --fetch-retry-mintimeout=20000
```

### Running the Pipeline

The main entry point is the `/paper2agent` command:

```bash
# Analyze a repository
/paper2agent ./my-research-project

# Or with a GitHub URL
/paper2agent https://github.com/example/research-project
```

This starts the complete 10-phase pipeline:
- Phase 1: Research analysis
- Phase 2: Repository analysis  
- Phase 3: Runtime analysis
- Phase 4: Operation selection
- Phase 5: Reference execution
- Phase 6: MCP generation
- Phase 7: Testing
- Phase 8: Independent verification
- Phase 9: Repair if necessary
- Phase 10: Packaging

### Using Individual Commands

```bash
# Just analyze a paper (Phases 1-4)
/paper2agent analyze ./project

# Just generate tools (Phases 4-6)
/paper2agent generate ./project

# Verify generated tools
/paper2agent verify ./generated-project

# Package the output
/paper2agent package ./generated-project

# Check environment health
/paper2agent doctor
```

### Generated Project Structure

After successful processing, the framework generates a complete project under `generated/<project-name>/`:

```
generated/paper2agent-demo/
├── README.md                    # Tool descriptions and usage examples
├── mcp/
│   ├── server.py               # MCP server with all tools loaded
│   └── tools/
│       └── place_limit_order.py # Generated MCP tool
├── tests/                       # Test directory
├── runtime-report.json          # Runtime requirements
├── tool-spec.json               # Operation specifications
├── verification-report.json     # Verification results
├── requirements.txt             # Dependencies
└── pyproject.toml               # Package configuration
```

## Agent Architecture

The framework uses a specialist agent system:

### `.opencode/agents/researcher.md`
- Reads research papers
- Identifies algorithms and workflows
- Produces structured research reports
- Does NOT implement code

### `.opencode/agents/code-analyzer.md`
- Inspects repository structure
- Identifies public APIs and entry points
- Maps operations to real source code
- Never invents functions

### `.opencode/agents/runtime-analyzer.md`
- Determines installation requirements
- Checks Python/Node versions
- Identifies dependencies and environment variables
- Generates runtime-report.json

### `.opencode/agents/tool-builder.md`
- Turns tool-spec.json into MCP tools
- Validates inputs against schemas
- Calls original implementations
- Handles errors gracefully

### `.opencode/agents/verifier.md`
- Independently verifies generated tools
- Reports PASS/FAIL/BLOCKED status
- Must be logically independent from tool-builder
- Maximum 3 repair iterations

### `.opencode/agents/paper2agent.md`
- Coordinator agent orchestrating the 10-phase pipeline
- Delegates work to specialist agents
- Gates feature work through verification

## CLI Commands Reference

### `/paper2agent <repository-or-paper>`

Full pipeline execution.

**Examples:**
```
/paper2agent ./research-project
/paper2agent https://github.com/example/project
/paper2agent paper.pdf ./research-project
```

### `/analyze-paper <paper-or-repository>`

Runs Phases 1-4 only (research analysis through operation selection).

**Use case:** Quick understanding of what tools could be generated without running the full pipeline.

### `/generate-tools <repository-or-spec>`

Runs Phases 4-6 (operation selection through MCP generation).

**Use case:** When you already have a tool-spec.json or have completed analysis phases elsewhere.

### `/verify-tools <generated-project>`

Runs independent verification on a generated project.

**Output:** verification-report.json with PASS/FAIL/BLOCKED status for each tool.

**Repair loop:** If verification fails, automatically attempts up to 3 fixes before marking tools BLOCKED.

### `/package-agent <generated-project>`

Packages the generated project for distribution.

**Output:** Complete project structure with README, MCP server, tools, tests, configs.

### `/doctor`

Checks environment health:
- Python version
- Node version
- OpenCode status
- MCP dependencies
- Git availability
- Package manager status

## Adding New Functionality

### Adding a New Agent

1. Create `.opencode/agents/<name>.md` following the agent.md template
2. Define the agent's responsibility and workflow
3. Register the agent in `.opencode/agents/paper2agent.md` if it's a coordinator gate

### Adding a New Command

1. Create `.opencode/commands/<name>.md` following the command template
2. Implement the command logic in the appropriate tool or pipeline file
3. Test the command with the target repository

### Adding a New Tool Generator

1. Modify `.opencode/tools/tool_generator.ts` to support new operation types
2. Update the code generation logic while preserving the "thin adapter" principle
3. Ensure generated tools validate inputs and call original implementations

## Design Principles

### 1. Zero Custom Backend

No server, no relay, no order proxy. The framework operates purely client-side.

### 2. Zero Database

No Prisma, Drizzle, SQLite, or Postgres. Grid state lives in React state and is discarded after the session. Kuru's on-chain orderbook is the database.

### 3. Parallel Execution via `Promise.allSettled`

Concurrency means fire-and-collect, never fire-and-forget and never sequential loops:

```typescript
// CORRECT
const results = await Promise.allSettled(orders.map((o) => placeOne(o)));

// WRONG - sequential, defeats the product thesis
for (const order of orders) { await placeOne(order); }

// WRONG - one rejection aborts the batch
const results = await Promise.all(orders.map((o) => placeOne(o)));
```

### 4. No `await` in a Loop for Broadcasting

Any `for` loop that awaits inside it is a bug. Reviewers grep for this.

### 5. Use Existing Implementations

Generated MCP tools are thin adapters that call original code. Never invent scientific functionality or duplicate algorithms.

### 6. Input Validation

All generated tools must validate inputs against schemas before calling original implementations.

### 7. Error Handling

Never silently ignore errors. Use structured errors with phase, component, status, error, and suggested_action fields.

### 8. Independent Verification

The verifier must be logically independent from the tool-builder. It inspects source implementation, generated wrapper, and test outputs.

### 9. Maximum 3 Repair Iterations

If verification fails, attempt up to 3 automatic repairs. After 3 failures, mark the tool BLOCKED. Never endlessly retry.

### 10. License Preservation

Inspect LICENSE files and preserve relevant license information in generated projects. Include THIRD_PARTY_NOTICES.md when processing external repositories.

## Supported Input Types

### A. GitHub Repository

```
/paper2agent https://github.com/example/project
```

### B. Local Repository

```
/paper2agent ./research-project
```

### C. Paper + Repository

```
/paper2agent paper.pdf ./research-project
```

### D. Paper URL + Repository

```
/paper2agent <paper-url> <repository-url>
```

## Known Limitations

1. **Market Address Dependency**: The Kuru market address (`DEFAULT_MARKET_ADDRESS` in `lib/constants.ts`) is deployment-specific. Must be overridden via `NEXT_PUBLIC_KURU_MARKET_ADDRESS` or validated before broadcasting.

2. **SDK Constraints**: `@kuru-labs/kuru-sdk` is CommonJS and pulls in `axios`. Load dynamically with `import()` inside `lib/kuruClient.ts` - never a top-level static import.

3. **Ethers v5 Only**: The framework uses `ethers@5.7.2`. v6 is not compatible.

4. **Static Export Only**: Next.js runs in `output: "export"` mode. No Route Handlers, no Server Actions, no API routes.

5. **Python Dependency Detection**: Python dependency analysis is basic. Complex pyproject.toml parsing may miss some dependencies.

6. **Real-money Scope**: KuruGrid's LIVE path targets **Monad Mainnet (chain 143 / `0x8f`)** against the real Kuru MON/USDC orderbook. Every leg the wallet signs is a real order against a real book. `MONAD_TESTNET` remains exported in `lib/constants.ts` for development only and is not reachable from the UI.

## Safety & Reliability

The system:

- Never executes arbitrary downloaded code without identifying what is being executed
- Clearly shows repository commands before execution when possible
- Isolates generated environments
- Never exposes secrets to generated tools
- Never fabricates scientific results
- Clearly distinguishes tool generation from scientific validation
- Clearly reports failed experiments
- Preserves original repository licenses

## Next Improvements

1. Add Python pipeline execution support for Python-dependent repositories
2. ~~Add mainnet network configuration~~ — done: `ACTIVE_NETWORK` in `lib/constants.ts` selects Monad Mainnet; every consumer reads it rather than a chain literal
3. Add more sophisticated pyproject.toml parsing
4. Add caching for repository inspection results
5. Add web-based UI for pipeline visualization
6. Add Docker support for isolated execution
7. Add more agent types for specialized domains (bioinformatics, physics, etc.)

## License

This framework is built on top of the KuruGrid project, which is Copyright (c) 2026 Kuru Labs. See the root `AGENTS.md` and `LICENSE` files for details on the underlying project.

Third-party notices are preserved in generated projects via `THIRD_PARTY_NOTICES.md`.
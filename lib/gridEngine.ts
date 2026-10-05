/**
 * KuruGrid — arithmetic grid engine.
 *
 * Owner: `web3` (see .opencode/agents/web3.md Part 1)
 *
 * PURE MODULE. This file imports from `constants.ts` and nothing else. No I/O,
 * no `window`, no `Date`, no `Math.random`. That is what makes the preview in
 * the UI trustworthy: what you see is exactly what will be broadcast.
 *
 * That purity is why `adaptiveBounds` can be called straight from a render on
 * every book update: it is a function of (mark, volatility) and nothing else,
 * so the same sample set always yields the same suggestion. The auto-recenter
 * feature in `app/page.tsx` depends on it — a bounds computation that read a
 * clock would move the grid under the operator by different amounts each pass.
 */

import {
  type GridOrder,
  GridConfigError,
  MAX_GRID_COUNT,
  type MarketConformance,
  type MarketConstraints,
  type MarketViolation,
  MIN_GRID_COUNT,
  NOTIONAL_DECIMALS,
  PRICE_DECIMALS,
  SIZE_DECIMALS,
} from "./constants";

/* ------------------------------------------------------------------ *
 * Numeric helpers
 * ------------------------------------------------------------------ */

/**
 * Round to a fixed number of decimals, correcting for binary floating point.
 *
 * The `Number.EPSILON` nudge is load-bearing: without it `roundTo(1.005, 2)`
 * returns `1` because 1.005 is stored as 1.00499999999999989.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Round away accumulated float error without changing the intended precision.
 *
 * Used for prices: `lower + i * step` can drift to `0.30000000000000004`.
 * `toPrecision(15)` collapses that to `0.3` while leaving genuinely precise
 * inputs (like `0.05123456789`) intact.
 */
function normalise(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Number(value.toPrecision(15));
}

function assertFinite(value: number, field: GridConfigError["field"], label: string): void {
  if (!Number.isFinite(value)) {
    throw new GridConfigError(field, `${label} must be a finite number.`);
  }
}

/**
 * The equal USDC slice each level of the ladder carries.
 *
 * **One helper, two callers.** `validateGridConfig` renders this figure while
 * the operator is still typing; `calculateGridOrders` builds the broadcast from
 * it. When they were computed separately the preview read `666.6` and the
 * chain required `666.6667` — the panel told the operator to fund one number
 * and the orders asked for another. Everything downstream (inventory
 * requirement, per-leg size, summary totals) derives from *this* value, so the
 * figure on screen is by construction the figure that gets signed.
 */
export function notionalPerLevelSlice(totalCapital: number, gridCount: number): number {
  if (!Number.isFinite(totalCapital) || !Number.isInteger(gridCount) || gridCount < 1) return 0;
  return roundTo(normalise(totalCapital / gridCount), NOTIONAL_DECIMALS);
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface GridValidationResult {
  readonly valid: boolean;
  /** Keyed by field so the UI can highlight the offending input. */
  readonly errors: Partial<Record<"lowerBound" | "upperBound" | "gridCount" | "capital", string>>;
  /** Distance between adjacent levels. */
  readonly stepPrice: number;
  /** USDC committed per level. */
  readonly notionalPerLevel: number;
  /** MON that must already be held to service the sell legs. */
  readonly requiredMonInventory: number;
  readonly buyLegs: number;
  readonly sellLegs: number;
  /**
   * False when the reference mark sits outside `[lowerBound, upperBound]`.
   *
   * Not an error: a market that ran past your range is a real state, and the
   * ladder it produces is an honest all-bid or all-ask grid. The UI surfaces it
   * as a notice so the operator re-centres rather than misreads the ladder.
   */
  readonly markInRange: boolean;
}

/**
 * Validate a grid configuration without building it.
 *
 * Purely computational so the UI can call it on every keystroke and disable the
 * deploy button before the user has to click anything.
 *
 * @param currentPrice Reference mark used to split legs. Defaults to the
 *                     midpoint of the range when omitted, which is the
 *                     assumption a UI should make before a live price arrives.
 */
export function validateGridConfig(
  lowerBound: number,
  upperBound: number,
  gridCount: number,
  totalCapital: number,
  currentPrice?: number,
): GridValidationResult {
  const errors: GridValidationResult["errors"] = {};

  if (!Number.isFinite(lowerBound) || lowerBound <= 0) {
    errors.lowerBound = "Lower bound must be greater than $0.";
  }
  if (!Number.isFinite(upperBound) || upperBound <= 0) {
    errors.upperBound = "Upper bound must be greater than $0.";
  }
  if (!errors.lowerBound && !errors.upperBound && upperBound <= lowerBound) {
    errors.upperBound = "Upper bound must be above the lower bound.";
  }

  if (!Number.isFinite(gridCount) || !Number.isInteger(gridCount)) {
    errors.gridCount = "Grid count must be a whole number.";
  } else if (gridCount < MIN_GRID_COUNT) {
    errors.gridCount = `Use at least ${MIN_GRID_COUNT} levels.`;
  } else if (gridCount > MAX_GRID_COUNT) {
    errors.gridCount = `Maximum ${MAX_GRID_COUNT} levels (wallet signature queue).`;
  }

    if (!Number.isFinite(totalCapital) || totalCapital <= 0) {
    errors.capital = "Capital must be greater than $0.";
  }

  const valid = Object.keys(errors).length === 0;
  const safeCount = Number.isFinite(gridCount) && gridCount > 0 ? gridCount : MIN_GRID_COUNT;
  const stepPrice = valid ? roundTo((upperBound - lowerBound) / safeCount, PRICE_DECIMALS) : 0;
  const notionalPerLevel = valid ? notionalPerLevelSlice(totalCapital, safeCount) : 0;

  // A slice that rounds to $0.00 would broadcast a zero-size order, which
  // reverts on-chain. Catch it here rather than paying a signature to find out.
  if (valid && notionalPerLevel <= 0) {
    errors.capital = `Capital is too small to split across ${safeCount} levels. Raise it or lower the grid count.`;
  }

  const resolvedValid = Object.keys(errors).length === 0;

  // Leg split and inventory requirement, derived without materialising the
  // ladder so the UI can show it while the user is still typing.
  let buyLegs = 0;
  let sellLegs = 0;
  let requiredMonInventory = 0;

  const mark =
    currentPrice !== undefined && Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : (lowerBound + upperBound) / 2;
  const markInRange = mark >= lowerBound && mark <= upperBound;

  if (resolvedValid) {
    for (const level of generateGridLevels(lowerBound, upperBound, safeCount)) {
      const price = roundTo(level, PRICE_DECIMALS);
      if (price < mark) {
        buyLegs += 1;
      } else {
        sellLegs += 1;
        // Round per leg, exactly as `calculateGridOrders` rounds each order's
        // size. Summing first and rounding once would drift by an ulp from the
        // figure `summarizeGrid` reports for the real ladder — and a preview
        // that disagrees with the broadcast by 0.0001 MON is still a lie.
        requiredMonInventory += roundTo(notionalPerLevel / mark, SIZE_DECIMALS);
      }
    }
  }

  return {
    valid: resolvedValid,
    errors,
    stepPrice,
    notionalPerLevel,
    requiredMonInventory: roundTo(requiredMonInventory, SIZE_DECIMALS),
    buyLegs,
    sellLegs,
    markInRange,
  };
}

/* ------------------------------------------------------------------ *
 * Level generation
 * ------------------------------------------------------------------ */

/**
 * Evenly spaced price levels across `[lowerBound, upperBound]`.
 *
 * ARITHMETIC grid: constant dollar spacing (`step = range / count`), not
 * constant percentage spacing. Constant spacing means every level carries the
 * same dollar risk, which is the property that makes a grid a grid.
 */
export function generateGridLevels(
  lowerBound: number,
  upperBound: number,
  gridCount: number,
): number[] {
  const step = (upperBound - lowerBound) / gridCount;
  const levels: number[] = [];
  for (let i = 0; i < gridCount; i += 1) {
    levels.push(normalise(lowerBound + i * step));
  }
  return levels;
}

/* ------------------------------------------------------------------ *
 * The main entry point
 * ------------------------------------------------------------------ */

export interface GridEngineOptions {
  /**
   * Reference "mark" price used to assign sides. Defaults to the mid of the
   * range when omitted.
   */
  readonly currentPrice?: number;
  /** Decimal places for prices. Defaults to `PRICE_DECIMALS`. */
  readonly priceDecimals?: number;
  /** Decimal places for sizes. Defaults to `SIZE_DECIMALS`. */
  readonly sizeDecimals?: number;
}

/**
 * Build a full grid ladder.
 *
 * @param currentPrice Reference mark price. Levels **strictly below** it become
 *                     buy limits (green); levels **at or above** it become sell
 *                     limits (red). A mark *outside* `[lowerBound, upperBound]`
 *                     is a legitimate market state, not an error: the ladder
 *                     comes back all-bid or all-ask, and `validateGridConfig`
 *                     reports `markInRange: false` so the UI can say so.
 * @param lowerBound   Lowest price in the range. Must be > 0.
 * @param upperBound   Highest price in the range. Must be > `lowerBound`.
 * @param gridCount    Number of levels. Integer in `[MIN_GRID_COUNT, MAX_GRID_COUNT]`.
 * @param totalCapital USDC committed across the whole grid.
 *
 * @returns `GridOrder[]` sorted by price **descending** — highest sell on top,
 *          lowest buy on the bottom, which is how a trader reads a ladder.
 *
 * @throws {GridConfigError} on any invalid input.
 *
 * Capital model — each level gets an equal notional slice `N = capital / count`:
 * - buy leg  spends `N` USDC  → `size = N / levelPrice`
 * - sell leg realises `N` USDC worth of MON → `size = N / currentPrice`
 *
 * The sell-leg sizing implies a funding precondition: to place `k` sell levels
 * you must already hold roughly `k * N / currentPrice` MON. Deploying buys and
 * sells from a zero base balance will revert the sell legs on-chain.
 */
export function calculateGridOrders(
  currentPrice: number,
  lowerBound: number,
  upperBound: number,
  gridCount: number,
  totalCapital: number,
  options: GridEngineOptions = {},
): GridOrder[] {
  const priceDecimals = options.priceDecimals ?? PRICE_DECIMALS;
  const sizeDecimals = options.sizeDecimals ?? SIZE_DECIMALS;

  /* ---- validate -------------------------------------------------- */

  assertFinite(currentPrice, "currentPrice", "Reference price");
  assertFinite(lowerBound, "lowerBound", "Lower bound");
  assertFinite(upperBound, "upperBound", "Upper bound");
  assertFinite(totalCapital, "capital", "Capital");

  if (lowerBound <= 0) {
    throw new GridConfigError("lowerBound", "Lower bound must be greater than $0.");
  }
  if (upperBound <= lowerBound) {
    throw new GridConfigError("upperBound", "Upper bound must be above the lower bound.");
  }
  if (!Number.isInteger(gridCount)) {
    throw new GridConfigError("gridCount", "Grid count must be a whole number.");
  }
  if (gridCount < MIN_GRID_COUNT) {
    throw new GridConfigError("gridCount", `Use at least ${MIN_GRID_COUNT} levels.`);
  }
  if (gridCount > MAX_GRID_COUNT) {
    throw new GridConfigError("gridCount", `Maximum ${MAX_GRID_COUNT} levels.`);
  }
  if (totalCapital <= 0) {
    throw new GridConfigError("capital", "Capital must be greater than $0.");
  }
  // A mark of $0 would make every sell leg divide by zero. A mark *outside* the
  // range is fine and deliberately not an error — see the doc comment.
  if (currentPrice <= 0) {
    throw new GridConfigError("currentPrice", "Reference price must be greater than $0.");
  }

  /* ---- allocate -------------------------------------------------- */

  const levels = generateGridLevels(lowerBound, upperBound, gridCount);
  const notionalPerLevel = notionalPerLevelSlice(totalCapital, gridCount);
  if (notionalPerLevel <= 0) {
    throw new GridConfigError(
      "capital",
      `Capital is too small to split across ${gridCount} levels. Raise it or lower the grid count.`,
    );
  }

  const orders: GridOrder[] = levels.map((rawPrice, levelIndex) => {
    const price = roundTo(rawPrice, priceDecimals);

    // Strictly below the mark -> bid. At or above -> offer.
    const isBuy = price < currentPrice;

    // Buy legs spend USDC at the level price. Sell legs realise the same
    // notional out of MON already held, sized against the reference price so
    // every leg carries identical dollar risk.
    const rawSize = isBuy ? notionalPerLevel / price : notionalPerLevel / currentPrice;

    return {
      id: `leg-${String(levelIndex + 1).padStart(2, "0")}`,
      price,
      size: roundTo(rawSize, sizeDecimals),
      notional: roundTo(notionalPerLevel, 2),
      isBuy,
      levelIndex,
      status: "READY",
      txHash: null,
      error: null,
      orderId: null,
    } satisfies GridOrder;
  });

  /* ---- order for human reading ------------------------------------ */

  orders.sort((a, b) => b.price - a.price);

  return orders;
}

/* ------------------------------------------------------------------ *
 * Derived views
 * ------------------------------------------------------------------ */

export interface GridSummary {
  readonly total: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly pendingCount: number;
  /** Sum of USDC committed to buy legs. */
  readonly buyNotional: number;
  /** Sum of USDC value resting on sell legs. */
  readonly sellNotional: number;
  /** Total MON that must be held to service every sell leg. */
  readonly requiredMon: number;
  /** Highest bid, if any. */
  readonly bestBid: number | null;
  /** Lowest ask, if any. */
  readonly bestAsk: number | null;
}

/** Aggregate a ladder into the numbers the telemetry panel displays. */
export function summarizeGrid(orders: readonly GridOrder[]): GridSummary {
  // Ladder arrives sorted descending, so the first bid and first ask we meet
  // are respectively the best bid and the best ask.
  let buyCount = 0;
  let sellCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let buyNotional = 0;
  let sellNotional = 0;
  let requiredMon = 0;
  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  for (const order of orders) {
    if (order.isBuy) {
      buyCount += 1;
      buyNotional += order.notional;
      if (bestBid === null) bestBid = order.price;
    } else {
      sellCount += 1;
      sellNotional += order.notional;
      requiredMon += order.size;
      if (bestAsk === null) bestAsk = order.price;
    }

    switch (order.status) {
      case "CONFIRMED":
      case "FILLED":
        successCount += 1;
        break;
      case "FAILED":
        failedCount += 1;
        break;
      default:
        pendingCount += 1;
        break;
    }
  }

  return {
    total: orders.length,
    buyCount,
    sellCount,
    successCount,
    failedCount,
    pendingCount,
    buyNotional: roundTo(buyNotional, 2),
    sellNotional: roundTo(sellNotional, 2),
    requiredMon: roundTo(requiredMon, SIZE_DECIMALS),
    bestBid,
    bestAsk,
  };
}

/* ------------------------------------------------------------------ *
 * Market conformance (pure)
 *
 * Checks a ladder against the constraints a market actually reports. Kept
 * here, and kept pure, so the operator learns an order is illegal *before*
 * being asked to sign for it — the alternative is paying a wallet signature
 * per leg to discover the market rejects all of them.
 * ------------------------------------------------------------------ */

/**
 * Check every leg against a market's real tick/size constraints.
 *
 * Sizes are compared in **raw precision units as integers**, never as floats.
 * The boundary is exactly where floats lie: `minSizeRaw` on the live market is
 * 2e12 at 1e10 precision, and a leg of exactly 200 MON has to be recognised as
 * *legal* while 199.9999999 is not. Multiplying into a double and comparing
 * with `>=` cannot make that distinction reliably, so the leg is rounded to the
 * market's size precision first — which is also precisely what gets sent on the
 * wire — and only then compared.
 *
 * A `null` `constraints` means "no market to check against" (simulation, or
 * the market has not loaded yet). It reports `ok` with nothing checked rather
 * than failing, because blocking a demo on an absent constraint would be worse
 * than the problem it prevents.
 *
 * **Two classes of finding, and only one of them blocks.** A size outside the
 * market's bounds is unfixable — the operator must change the capital or the
 * level count — so it is a `fatal` violation and `ok` goes false. An off-tick
 * *price* is already repaired deterministically by the broadcast path, which
 * snaps it to the nearest tick; here it is counted in `snaps` and reported as a
 * non-fatal entry so the UI can disclose it without refusing to trade.
 *
 * That split is not cosmetic. The live market's tick is $0.000001 (6 dp) while
 * `PRICE_DECIMALS` is 8, so an evenly spaced ladder lands off-tick on most
 * levels by construction. Folding those into `ok` blocked the app's own default
 * grid on 8 of 12 legs over a rounding error worth $3.3e-8 per leg — the gate
 * would have refused to deploy a grid that the chain would have accepted.
 */
export function checkGridAgainstMarket(
  orders: readonly GridOrder[],
  constraints: MarketConstraints | null,
): MarketConformance {
  if (constraints === null || orders.length === 0) {
    return { ok: true, checked: 0, conforming: 0, violations: [], snaps: 0 };
  }

  const priceScale = 10 ** constraints.priceDecimals;
  // Sizes and bounds are compared as exact integers. The live market's maxSize is
  // 2e18 — past Number.MAX_SAFE_INTEGER — so a float here would silently drop
  // low bits and enforce a maximum that is quietly wrong.
  const minRaw = BigInt(constraints.minSizeRaw);
  const maxRaw = BigInt(constraints.maxSizeRaw);
  const tickRaw = BigInt(Math.round(constraints.tickSizeRaw));

  /**
   * Scale a human number up to raw precision units **exactly**, as a BigInt.
   *
   * `Math.round(x * 1e10)` routes through a double, and the interesting cases
   * are exactly the ones a double gets wrong: a leg of precisely 200 MON must
   * be legal while 199.9999999 must not. Working on the decimal string instead
   * is exact for every input, and it is the same number that gets signed.
   */
  const toRaw = (value: number, scale: number): bigint => {
    if (!Number.isFinite(value)) return 0n;
    const negative = value < 0;
    const [intPart = "0", fracPart = ""] = Math.abs(value).toString().split(".");
    const frac = fracPart.slice(0, scale).padEnd(scale, "0");
    const scaled = BigInt(`${intPart}${frac}`);
    return negative ? -scaled : scaled;
  };

  const minHuman = displaySize(constraints.minSizeHuman);
  const maxHuman = displaySize(constraints.maxSizeHuman);

  const violations: MarketViolation[] = [];
  let snaps = 0;
  let conforming = 0;

  for (const order of orders) {
    const sizeRaw = toRaw(order.size, constraints.sizeDecimals);

    if (sizeRaw < minRaw) {
      violations.push({
        id: order.id,
        kind: "min-size",
        fatal: true,
        reason:
          `Size ${order.size} MON is below the market minimum of ` +
          `${minHuman} MON.`,
        sizeRaw: sizeRaw.toString(),
        minSizeRaw: constraints.minSizeRaw,
      });
      continue;
    }
    if (sizeRaw > maxRaw) {
      violations.push({
        id: order.id,
        kind: "max-size",
        fatal: true,
        reason:
          `Size ${order.size} MON is above the market maximum of ` +
          `${maxHuman} MON.`,
        sizeRaw: sizeRaw.toString(),
        minSizeRaw: constraints.maxSizeRaw,
      });
      continue;
    }

    conforming += 1;

    // Checked last, and counted rather than blocked: the snap below is what
    // `placeParallelKuruOrders` does anyway, so the ladder on chain and the
    // ladder on screen differ by at most half a tick.
    const priceRaw = toRaw(order.price, constraints.priceDecimals);
    const snappedPriceRaw = ((priceRaw + tickRaw / 2n) / tickRaw) * tickRaw;
    if (snappedPriceRaw !== priceRaw) {
      snaps += 1;
      violations.push({
        id: order.id,
        kind: "tick-snap",
        fatal: false,
        reason:
          `Price ${order.price} is off the market's tick grid and will be ` +
          `snapped to ${displaySize(Number(snappedPriceRaw) / priceScale)} on broadcast.`,
        sizeRaw: sizeRaw.toString(),
        minSizeRaw: constraints.tickSizeRaw.toString(),
      });
    }
  }

  return {
    ok: violations.every((violation) => !violation.fatal),
    checked: orders.length,
    conforming,
    violations,
    snaps,
  };
}

/**
 * Smallest capital that would produce a legal leg on this market.
 *
 * Shown next to a non-conforming grid so the operator is told *how* to fix it
 * rather than just that it is broken. Sell legs are sized against the mark
 * (`size = slice / mark`), so the binding leg needs
 * `minSizeHuman * mark` of USDC per level; buys need
 * `minSizeHuman * levelPrice`, which is largest at the cheapest level.
 */
export function minimumCapitalForMarket(
  markPrice: number,
  gridCount: number,
  constraints: MarketConstraints | null,
): number {
  if (constraints === null || !Number.isFinite(markPrice) || markPrice <= 0) return 0;
  if (!Number.isInteger(gridCount) || gridCount < 1) return 0;
  // Sell legs are the binding case: their size is `slice / mark`, so the
  // smallest slice that clears `minSize` is `minSize * mark`.
  //
  // Rounds UP, not to nearest. This number is an instruction ("fund at least
  // this much"), so a figure a cent short of the minimum would leave the
  // operator still failing. Rounding to nearest is the wrong direction here
  // even though it is the right one everywhere else in this file.
  //
  // Round *after* multiplying by the level count. Rounding the per-level figure
  // first and then scaling re-introduces the float noise this function exists
  // to remove — `roundTo(6.22, 2) * 20` is `124.39999999999999`, and a capital
  // figure printed with fifteen nines reads as a bug in the app.
  const exact = constraints.minSizeHuman * markPrice * gridCount;
  const rounded = roundTo(exact, NOTIONAL_DECIMALS);
  const cent = 10 ** -NOTIONAL_DECIMALS;
  return rounded < exact ? rounded + cent : rounded;
}

/** Format a number as a USDC price with a stable number of decimals. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const decimals = value >= 100 ? 2 : value >= 1 ? 4 : PRICE_DECIMALS;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

/** Format a number as a MON size. */
export function formatSize(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Trim float noise from a size for a human-facing message.
 *
 * `Number(...toPrecision(6))` rather than `toFixed`: the market minimum of
 * 200 MON divided by `10 ** 10` can land a few ULPs off, and a constraint
 * message reading "minimum 199.99999999999997 MON" reads as a bug in the app
 * rather than a rule of the market.
 */
function displaySize(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toPrecision(6)).toString();
}

/* ------------------------------------------------------------------ *
 * Adaptive grid sizing (pure)
 *
 * Volatility in, suggested half-width out. No clock, no I/O — the same
 * sample set always yields the same suggestion, so the preview can never
 * disagree with what the panel shows.
 * ------------------------------------------------------------------ */

/**
 * Standard deviation of log returns over a price series — a scale-free
 * volatility reading. Returns 0 for fewer than two usable samples.
 */
export function computeVolatility(prices: readonly number[]): number {
  if (prices.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev !== undefined && cur !== undefined && prev > 0 && cur > 0) {
      returns.push(Math.log(cur / prev));
    }
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
  const variance =
    returns.reduce((acc, value) => acc + (value - mean) * (value - mean), 0) /
    returns.length;
  return Math.sqrt(variance);
}

/**
 * Map a volatility reading to a suggested grid half-width, as a fraction
 * of the mark. Clamped to a tradeable band: low vol opens the grid to
 * ±2%, high vol widens it toward ±8%.
 */
export function adaptiveHalfWidthPct(volatility: number): number {
  const MIN = 0.02;
  const MAX = 0.08;
  if (!Number.isFinite(volatility) || volatility <= 0) return MIN;
  const VOL_CEILING = 0.01; // stdev of log returns saturating the band
  const scaled = Math.min(1, volatility / VOL_CEILING);
  return MIN + (MAX - MIN) * scaled;
}

/** Suggested grid bounds around a mark, from a volatility reading. */
export function adaptiveBounds(
  mark: number,
  volatility: number,
): { lowerBound: number; upperBound: number } {
  const halfWidth = adaptiveHalfWidthPct(volatility);
  return {
    lowerBound: roundTo(mark * (1 - halfWidth), PRICE_DECIMALS),
    upperBound: roundTo(mark * (1 + halfWidth), PRICE_DECIMALS),
  };
}

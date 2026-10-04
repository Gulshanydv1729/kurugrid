/**
 * KuruGrid — arithmetic grid engine.
 *
 * Owner: `web3` (see .opencode/agents/web3.md Part 1)
 *
 * PURE MODULE. This file imports from `constants.ts` and nothing else. No I/O,
 * no `window`, no `Date`, no `Math.random`. That is what makes the preview in
 * the UI trustworthy: what you see is exactly what will be broadcast.
 */

import {
  type GridOrder,
  GridConfigError,
  MAX_GRID_COUNT,
  MIN_GRID_COUNT,
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
  const notionalPerLevel = valid ? roundTo(totalCapital / safeCount, 2) : 0;

  // Leg split and inventory requirement, derived without materialising the
  // ladder so the UI can show it while the user is still typing.
  let buyLegs = 0;
  let sellLegs = 0;
  let requiredMonInventory = 0;

  if (valid) {
    const mark =
      currentPrice !== undefined && Number.isFinite(currentPrice) && currentPrice > 0
        ? currentPrice
        : (lowerBound + upperBound) / 2;

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
    valid,
    errors,
    stepPrice,
    notionalPerLevel,
    requiredMonInventory: roundTo(requiredMonInventory, SIZE_DECIMALS),
    buyLegs,
    sellLegs,
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
 *                     limits (red).
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
  if (currentPrice < lowerBound || currentPrice > upperBound) {
    throw new GridConfigError(
      "currentPrice",
      "Reference price is outside the configured range. There is no grid to build.",
    );
  }

  /* ---- allocate -------------------------------------------------- */

  const levels = generateGridLevels(lowerBound, upperBound, gridCount);
  const notionalPerLevel = normalise(totalCapital / gridCount);

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

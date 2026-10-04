/**
 * Live market ticker — read-only, failure-safe.
 *
 * Sources, in order: Binance 24h ticker, then CoinGecko markets.
 * Sources expose healthier books than a testnet DEX, so MON/USDC
 * maps to the ETH/USDC pair as the liquid reference (documented in
 * the README). Every failure path returns the last good sample or
 * throws — callers keep the previous UI and retry on the next tick.
 *
 * No `window` / `document` at module scope; the cache is a plain
 * module-level value, safe on the server pass.
 */

import { MARKET_FEED_TIMEOUT_MS } from "./constants";

export interface MarketTicker {
  readonly price: number;
  readonly change24h: number;
  readonly high24h: number;
  readonly low24h: number;
  readonly timestamp: number;
}

let lastGood: MarketTicker | null = null;

/** Last successfully fetched ticker, or null before the first success. */
export function getCachedTicker(): MarketTicker | null {
  return lastGood;
}

function withTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MARKET_FEED_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

async function fromBinance(): Promise<MarketTicker> {
  const res = await withTimeout(
    "https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT",
  );
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const j = (await res.json()) as {
    lastPrice: string;
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
  };
  const price = Number(j.lastPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Binance payload: bad price");
  }
  return {
    price,
    change24h: Number(j.priceChangePercent),
    high24h: Number(j.highPrice),
    low24h: Number(j.lowPrice),
    timestamp: Date.now(),
  };
}

async function fromCoinGecko(): Promise<MarketTicker> {
  const res = await withTimeout(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum",
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const j = (await res.json()) as Array<{
    current_price: number;
    price_change_percentage_24h: number;
    high_24h: number;
    low_24h: number;
  }>;
  const row = j[0];
  if (row === undefined || !Number.isFinite(row.current_price)) {
    throw new Error("CoinGecko payload: empty");
  }
  return {
    price: row.current_price,
    change24h: row.price_change_percentage_24h,
    high24h: row.high_24h,
    low24h: row.low_24h,
    timestamp: Date.now(),
  };
}

/**
 * Fetch the live ticker. On total failure, returns the last good
 * sample if one exists; otherwise rethrows so the caller can keep
 * the previous UI. Never crashes the render path.
 */
export async function fetchLiveTicker(): Promise<MarketTicker> {
  try {
    lastGood = await fromBinance();
    return lastGood;
  } catch {
    // fall through to the secondary source
  }
  try {
    lastGood = await fromCoinGecko();
    return lastGood;
  } catch (cause) {
    if (lastGood !== null) return lastGood;
    throw cause;
  }
}

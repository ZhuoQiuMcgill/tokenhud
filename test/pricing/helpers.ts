import type { Rates, TokenCounts } from "../../src/pricing/cost.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import ccUsageBundled from "../fixtures/pricing/cc-usage-v2.6.1-pricing.json";

/** Python's math.isclose, with its default rel_tol of 1e-9. */
export function isClose(a: number, b: number, absTol = 0, relTol = 1e-9): boolean {
  return (
    a === b || Math.abs(a - b) <= Math.max(relTol * Math.max(Math.abs(a), Math.abs(b)), absTol)
  );
}

export const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad test date ${iso}`);
  return ms;
};

/**
 * An instant at which tokenhud's dated OpenAI cards equal cc-usage v2.6.1's undated ones:
 * after the Terra and Luna cut (2026-07-30) and before the GPT-5.6 Sol cut (2026-08-21).
 */
export const CC_USAGE_V261_INSTANT = at("2026-08-01T00:00:00Z");

/** cc-usage v2.6.1's bundled rows (test/fixtures/pricing, generated from cc-usage). */
export const CC_USAGE_MODELS = ccUsageBundled.models as Record<string, Rates>;

export const bundledTable = (): PriceTable => new PriceTable(bundledPricing().models);

export const NO_CACHE: Omit<TokenCounts, "input" | "output"> = {
  cacheRead: 0,
  cacheCreation: 0,
  ephemeral5m: 0,
  ephemeral1h: 0,
};

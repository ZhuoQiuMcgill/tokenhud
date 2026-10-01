// Rate lookup over a price table: model id + speed tier + time -> the rates in effect.

import { computeCost, type Rates, type TokenCounts, type Unpriced } from "./cost.ts";
import { normalizeModel, OFFICIAL_ALIASES } from "./normalize.ts";
import bundledJson from "./pricing.json";
import {
  isDated,
  type ModelPricing,
  type PriceTableFile,
  parseIsoUtc,
  parsePriceTableFile,
  type RateCard,
  type Tier,
} from "./schema.ts";

/** One usage record as the cost engine sees it. `atMs` is epoch milliseconds. */
export interface UsageRecord extends TokenCounts {
  readonly model: string | null | undefined;
  readonly tier: Tier;
  readonly atMs: number;
}

export interface UnpricedUsage {
  /** Normalised id; "" when the record had no model. */
  readonly model: string;
  readonly tier: Tier;
  readonly reason: Unpriced;
  readonly tokens: number;
}

/** Tokens are input + output + cache read + cache creation. */
export interface Coverage {
  readonly pricedTokens: number;
  readonly unpricedTokens: number;
  /** One entry per (model, tier, reason), most tokens first, then by model id. */
  readonly unpriced: readonly UnpricedUsage[];
}

interface CompiledPeriod {
  readonly fromMs: number;
  readonly standard: Rates;
  readonly fast: Rates | undefined;
}

function standardRates(card: RateCard): Rates {
  const { fast: _fast, ...rates } = card;
  return Object.freeze(rates);
}

// A fast card states its own input and output. When it doesn't state a cache-read rate,
// the rate comes from the fast input at the standard card's own cache-read ratio:
// Anthropic's caching multipliers apply on top of fast pricing, so Opus 5.5 (cache reads
// at 0.05x input) reads at 0.05x of its fast input too. A standard card without a stated
// rate reads at the default 0.1x, which computeCost derives from the fast input unaided.
// Cache writes need no derivation: without `cache_write`, computeCost charges the 1.25x
// and 2x write multipliers on the fast input. Long-context settings are the standard
// card's.
function fastRates(card: RateCard): Rates | undefined {
  const fast = card.fast;
  if (fast === undefined) return undefined;
  const { fast: _fast, cache_read, cache_write: _write, ...longContext } = card;
  const rates: { -readonly [K in keyof Rates]: Rates[K] } = {
    ...longContext,
    input: fast.input,
    output: fast.output,
  };
  if (fast.cache_read !== undefined) rates.cache_read = fast.cache_read;
  // A free standard input gives no ratio to scale by; the default 0.1x then applies.
  else if (cache_read !== undefined && card.input > 0) {
    rates.cache_read = fast.input * (cache_read / card.input);
  }
  if (fast.cache_write !== undefined) rates.cache_write = fast.cache_write;
  return Object.freeze(rates);
}

function compile(pricing: ModelPricing): readonly CompiledPeriod[] {
  const periods = isDated(pricing) ? pricing.periods : [{ from: null, card: pricing }];
  return periods.map(({ from, card }) => ({
    fromMs: from === null ? Number.NEGATIVE_INFINITY : (parseIsoUtc(from) ?? Number.NaN),
    standard: standardRates(card),
    fast: fastRates(card),
  }));
}

export class PriceTable {
  readonly #models: ReadonlyMap<string, readonly CompiledPeriod[]>;
  // Raw id -> its periods. Ids repeat across millions of records, but there are only a
  // few dozen distinct ones, so normalising each once keeps lookups to a map hit.
  readonly #byRawId = new Map<string, readonly CompiledPeriod[] | null>();

  /** `models` must already be validated (schema.ts) and keyed by normalised id. */
  constructor(models: Readonly<Record<string, ModelPricing>>) {
    this.#models = new Map(Object.entries(models).map(([id, pricing]) => [id, compile(pricing)]));
  }

  #periods(model: string | null | undefined): readonly CompiledPeriod[] | null {
    const raw = model ?? "";
    let periods = this.#byRawId.get(raw);
    if (periods === undefined) {
      const id = normalizeModel(raw);
      const alias = OFFICIAL_ALIASES.get(id);
      periods =
        (id === "" ? undefined : this.#models.get(id)) ??
        (alias === undefined ? undefined : this.#models.get(alias)) ??
        null;
      this.#byRawId.set(raw, periods);
    }
    return periods;
  }

  /**
   * The rates for `model` at `tier`, in effect at `atMs`. "unpriced" when the model isn't
   * in the table or `atMs` falls before its first period; "unpriced-tier" when the model
   * has no card for that tier then. A fast request is never silently priced as standard.
   */
  rates(model: string | null | undefined, tier: Tier, atMs: number): Rates | Unpriced {
    const periods = this.#periods(model);
    if (periods === null) return "unpriced";
    for (let i = periods.length - 1; i >= 0; i--) {
      const period = periods[i] as CompiledPeriod;
      if (period.fromMs <= atMs) {
        if (tier === "standard") return period.standard;
        return period.fast ?? "unpriced-tier";
      }
    }
    return "unpriced";
  }

  /** The standard card in effect now, for the UI's $/M columns. */
  displayRates(model: string | null | undefined, nowMs: number = Date.now()): Rates | "unpriced" {
    const rates = this.rates(model, "standard", nowMs);
    return typeof rates === "string" ? "unpriced" : rates;
  }

  /** The record's API-equivalent cost in USD, or why it has none. */
  cost(record: UsageRecord): number | Unpriced {
    return computeCost(record, this.rates(record.model, record.tier, record.atMs));
  }

  coverage(records: Iterable<UsageRecord>): Coverage {
    let pricedTokens = 0;
    let unpricedTokens = 0;
    const unpriced = new Map<string, UnpricedUsage>();
    for (const record of records) {
      const tokens = record.input + record.output + record.cacheRead + record.cacheCreation;
      const rates = this.rates(record.model, record.tier, record.atMs);
      if (typeof rates !== "string") {
        pricedTokens += tokens;
        continue;
      }
      unpricedTokens += tokens;
      const model = normalizeModel(record.model);
      const key = `${model}\0${record.tier}\0${rates}`;
      const seen = unpriced.get(key);
      unpriced.set(key, {
        model,
        tier: record.tier,
        reason: rates,
        tokens: (seen?.tokens ?? 0) + tokens,
      });
    }
    const list = [...unpriced.values()].sort(
      (a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    );
    return { pricedTokens, unpricedTokens, unpriced: list };
  }
}

let bundled: PriceTableFile | undefined;

/** The validated bundled table (src/pricing/pricing.json). */
export function bundledPricing(): PriceTableFile {
  bundled ??= parsePriceTableFile(bundledJson);
  return bundled;
}

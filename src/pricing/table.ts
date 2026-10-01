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
// and 2x write multipliers on the fast input.
//
// Long context: the threshold is the standard card's, but the multipliers must be the fast
// card's own. Without them the fast tier has no long-context price, and computeCost
// returns "unpriced-tier" above the threshold rather than extrapolate one.
function fastRates(card: RateCard): Rates | undefined {
  const fast = card.fast;
  if (fast === undefined) return undefined;
  const rates: { -readonly [K in keyof Rates]: Rates[K] } = {
    input: fast.input,
    output: fast.output,
  };
  if (fast.cache_read !== undefined) rates.cache_read = fast.cache_read;
  // A free standard input gives no ratio to scale by; the default 0.1x then applies.
  else if (card.cache_read !== undefined && card.input > 0) {
    rates.cache_read = fast.input * (card.cache_read / card.input);
  }
  if (fast.cache_write !== undefined) rates.cache_write = fast.cache_write;
  if (card.long_context_threshold !== undefined) {
    rates.long_context_threshold = card.long_context_threshold;
    if (
      fast.long_context_input_multiplier !== undefined &&
      fast.long_context_output_multiplier !== undefined
    ) {
      rates.long_context_input_multiplier = fast.long_context_input_multiplier;
      rates.long_context_output_multiplier = fast.long_context_output_multiplier;
    } else {
      rates.long_context_unpriced = true;
    }
  }
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
   * Fast rates without a long-context price carry `long_context_unpriced`, and computeCost
   * turns a record above the threshold into "unpriced-tier".
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

  /**
   * Every instant at which some model's card changes, ascending. The query layer prices
   * hourly sums per card, so it splits ranges here.
   */
  boundaries(): number[] {
    const at = new Set<number>();
    for (const periods of this.#models.values()) {
      for (const { fromMs } of periods) if (Number.isFinite(fromMs)) at.add(fromMs);
    }
    return [...at].sort((a, b) => a - b);
  }

  /** The lowest long-context threshold on any card, or undefined when no card has one. */
  minLongContextThreshold(): number | undefined {
    let min: number | undefined;
    for (const periods of this.#models.values()) {
      for (const { standard } of periods) {
        const threshold = standard.long_context_threshold;
        if (threshold !== undefined && (min === undefined || threshold < min)) min = threshold;
      }
    }
    return min;
  }

  /** Whether any card of `model` has a long-context tier (fast cards share the standard threshold). */
  hasLongContext(model: string | null | undefined): boolean {
    const periods = this.#periods(model);
    return periods?.some((p) => p.standard.long_context_threshold !== undefined) ?? false;
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
      // The cost, not just the rates: a fast long-context record can be unpriced on a
      // priced card.
      const reason = this.cost(record);
      if (typeof reason !== "string") {
        pricedTokens += tokens;
        continue;
      }
      unpricedTokens += tokens;
      const model = normalizeModel(record.model);
      const key = `${model}\0${record.tier}\0${reason}`;
      const seen = unpriced.get(key);
      unpriced.set(key, {
        model,
        tier: record.tier,
        reason,
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

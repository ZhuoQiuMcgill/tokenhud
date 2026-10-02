// An independent reading of the price data for the parity gate (scripts/parity.ts). It
// reads the raw `pricing.json`, the user's overrides file and cc-usage's own table, and
// prices one row from the rules as documented (src/pricing/SOURCES.md, ARCHITECTURE §6.2
// and §6.3). It deliberately does not use tokenhud's pricing code: the gate checks each
// fix's effect on each row against this, so it must not trust what it checks.
//
// The rules, as documented:
// - A model's entry is one card, or dated periods: the card of the last period that began
//   at or before the row (a period with no start began at the beginning).
// - The user's overrides replace a model's bundled entry whole.
// - An estimated alias (codex-auto-review) prices a row with the card its target model has
//   then, the target chosen by the alias period the row falls in; a model with its own
//   entry is never priced through an alias.
// - Fast: the card's `fast` input and output; its cache read as stated, else the fast
//   input at the standard card's cache-read ratio; cache writes as stated, else the 1.25x
//   (5 minute) and 2x (1 hour) multipliers of the fast input. Above the long-context
//   threshold a fast row needs the fast card's own multipliers, else it has no price.
// - Cost per row: input, output and cache read at their rates (cache read 0.1x input
//   unless stated), long context (input plus cache read above the threshold) multiplying
//   input and cache-read rates by the input multiplier and output by the output one; cache
//   creation at the card's write rate, else per bucket (5 minutes 1.25x, 1 hour 2x input),
//   else all of it at 1.25x when the transcript gave no buckets.

import { normalizeModel } from "../../src/pricing/normalize.ts";

export interface Card {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  long_context_threshold?: number;
  long_context_input_multiplier?: number;
  long_context_output_multiplier?: number;
  fast?: Omit<Card, "fast" | "long_context_threshold">;
}

type Entry = Card | { periods: { from: string | null; card: Card }[] };

interface Alias {
  periods: { from: string | null; model: string }[];
}

/** The token counts of one row. */
export interface Tokens {
  model: string;
  ts: number;
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  e5: number | null;
  e1: number | null;
}

export type Price = number | "unpriced" | "unpriced-tier";

interface Rates {
  input: number;
  output: number;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  threshold: number | undefined;
  inputMult: number | undefined;
  outputMult: number | undefined;
}

const startOf = (from: string | null) =>
  from === null ? Number.NEGATIVE_INFINITY : Date.parse(from);

/** The entry's card in effect at `at`, or null before its first period. */
function cardAt(entry: Entry, at: number): Card | null {
  if (!("periods" in entry)) return entry;
  let card: Card | null = null;
  for (const period of entry.periods) if (startOf(period.from) <= at) card = period.card;
  return card;
}

function standard(card: Card): Rates {
  return {
    input: card.input,
    output: card.output,
    cacheRead: card.cache_read,
    cacheWrite: card.cache_write,
    threshold: card.long_context_threshold,
    inputMult: card.long_context_input_multiplier,
    outputMult: card.long_context_output_multiplier,
  };
}

function fast(card: Card): Rates | "unpriced-tier" {
  const f = card.fast;
  if (f === undefined) return "unpriced-tier";
  const ratio =
    card.cache_read !== undefined && card.input > 0 ? card.cache_read / card.input : undefined;
  const both =
    f.long_context_input_multiplier !== undefined && f.long_context_output_multiplier !== undefined;
  return {
    input: f.input,
    output: f.output,
    cacheRead: f.cache_read ?? (ratio === undefined ? undefined : f.input * ratio),
    cacheWrite: f.cache_write,
    threshold: card.long_context_threshold,
    // NaN marks "no long-context price at this tier".
    inputMult: both ? f.long_context_input_multiplier : Number.NaN,
    outputMult: both ? f.long_context_output_multiplier : Number.NaN,
  };
}

function cost(r: Rates, t: Tokens): Price {
  const long = r.threshold !== undefined && t.inp + t.cr > r.threshold;
  const mi = long ? (r.inputMult ?? 1) : 1;
  const mo = long ? (r.outputMult ?? 1) : 1;
  if (Number.isNaN(mi) || Number.isNaN(mo)) return "unpriced-tier";
  const input = r.input * mi;
  const read = (r.cacheRead ?? r.input * 0.1) * mi;
  let creation: number;
  if (r.cacheWrite !== undefined) creation = t.cc * r.cacheWrite * mi;
  else if (t.e5 === null && t.e1 === null) creation = t.cc * input * 1.25;
  else creation = (t.e5 ?? 0) * input * 1.25 + (t.e1 ?? 0) * input * 2;
  return (t.inp * input + t.outp * r.output * mo + t.cr * read + creation) / 1_000_000;
}

export class IndependentPrices {
  readonly #models: Record<string, Entry>;
  readonly #aliases: Record<string, Alias>;
  readonly #ccUsage: Record<string, Card>;

  /**
   * `bundled` is pricing.json as read, `overrides` the user's overrides file as read, and
   * `ccUsage` cc-usage's effective flat table (as its `load_pricing` returns it).
   */
  constructor(
    bundled: { models: Record<string, Entry>; aliases?: Record<string, Alias> },
    overrides: { models?: Record<string, Entry> },
    ccUsage: Record<string, Card>,
  ) {
    this.#models = { ...bundled.models, ...(overrides.models ?? {}) };
    this.#aliases = bundled.aliases ?? {};
    this.#ccUsage = ccUsage;
  }

  #card(model: string, at: number, aliases: boolean): Card | null {
    const id = normalizeModel(model);
    const own = this.#models[id];
    if (own !== undefined) return cardAt(own, at);
    const alias = aliases ? this.#aliases[id] : undefined;
    if (alias === undefined) return null;
    let target: string | null = null;
    for (const period of alias.periods) if (startOf(period.from) <= at) target = period.model;
    const entry = target === null ? undefined : this.#models[target];
    return entry === undefined ? null : cardAt(entry, at);
  }

  /** tokenhud's price of `t` at `tier` (0 standard, 1 fast); `aliases`: estimated aliases apply. */
  price(t: Tokens, tier: number, aliases: boolean): Price {
    const card = this.#card(t.model, t.ts, aliases);
    if (card === null) return "unpriced";
    const rates = tier === 0 ? standard(card) : fast(card);
    return typeof rates === "string" ? rates : cost(rates, t);
  }

  /** cc-usage's price of `t`: its flat card, standard tier. */
  ccUsagePrice(t: Tokens): Price {
    const card = this.#ccUsage[normalizeModel(t.model)];
    return card === undefined ? "unpriced" : cost(standard(card), t);
  }
}

/** A price as dollars, as cc-usage's views count an unpriced row: $0. */
export function dollars(p: Price): number {
  return typeof p === "number" ? p : 0;
}

// Port of cc-usage's `compute_cost` and `Rates.cache_read_rate` (cc_usage/cost.py).
//
// cost =  input          * input_rate
//       + output         * output_rate
//       + cache_read     * cache_read_rate      (input * 0.10 unless the card states one)
//       + cache creation                        (see computeCost)
//
// Rates are USD per 1,000,000 tokens. Results must be bit-identical to cc-usage, so every
// expression below keeps Python's operation order: `a * b / c` is `(a * b) / c` in both
// languages, and a reordering that is equal in real arithmetic can still move the last
// bit. test/pricing/cost-parity.test.ts checks this on thousands of generated cases.

// Cache multipliers are Anthropic's published formula, not prices: they apply to whatever
// input rate the card carries, standard or fast.
export const CACHE_READ_MULT = 0.1;
export const EPHEMERAL_5M_MULT = 1.25;
export const EPHEMERAL_1H_MULT = 2.0;
export const CACHE_CREATE_FALLBACK_MULT = 1.25;

/** One tier's resolved rates, USD per 1M tokens. Keys match pricing.json. */
export interface Rates {
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly long_context_threshold?: number;
  readonly long_context_input_multiplier?: number;
  readonly long_context_output_multiplier?: number;
  /**
   * Set only on resolved fast rates whose fast card states no long-context price: a
   * request above the threshold then has no price ("unpriced-tier"). Never in pricing.json.
   */
  readonly long_context_unpriced?: true;
  /**
   * Set only on rates resolved through an estimated alias (`codex-auto-review`): the
   * provider does not say which model served the request. Never in a pricing.json card.
   */
  readonly estimated?: true;
}

/**
 * Why a record has no price. "unpriced": the model (or the period at that time) is not in
 * the table. "unpriced-tier": the model is priced, but not at the requested speed tier.
 * Neither is ever $0.
 */
export type Unpriced = "unpriced" | "unpriced-tier";

/**
 * One usage record's token counts. `ephemeral5m` and `ephemeral1h` are null only when the
 * transcript had no `cache_creation` object; then creation is priced from the aggregate.
 */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly ephemeral5m: number | null;
  readonly ephemeral1h: number | null;
}

/**
 * The cache-read rate per 1M tokens: the card's `cache_read` if stated, else
 * `input * CACHE_READ_MULT`, scaled by `inputMult` (the long-context input multiplier).
 * The derived form multiplies in cc-usage's order, `(input * inputMult) * 0.1`; the other
 * order differs in the last bit for some inputs. The UI shows this same value, so the
 * displayed rate is always the billed one.
 */
export function cacheReadRate(card: Rates, inputMult = 1): number {
  if (card.cache_read !== undefined) return card.cache_read * inputMult;
  return card.input * inputMult * CACHE_READ_MULT;
}

/**
 * The API-equivalent cost in USD of one record at `card`, or the reason it has none.
 *
 * Cache creation:
 * - a card with `cache_write` (OpenAI) prices the whole creation count at that rate;
 * - else, with both ephemeral buckets null, the aggregate count at 1.25x input;
 * - else the 5m bucket at 1.25x and the 1h bucket at 2x input.
 *
 * Long context applies when `input + cacheRead` is strictly above the card's threshold. It
 * scales input, cache reads and cache writes by the input multiplier, and output by the
 * output multiplier. On a card marked `long_context_unpriced`, such a record is
 * "unpriced-tier" instead: no long-context price is ever extrapolated.
 */
export function computeCost(tokens: TokenCounts, card: Rates | Unpriced): number | Unpriced {
  if (typeof card === "string") return card;

  const threshold = card.long_context_threshold;
  const longContext = threshold !== undefined && tokens.input + tokens.cacheRead > threshold;
  if (longContext && card.long_context_unpriced) return "unpriced-tier";
  const inputMult = longContext ? (card.long_context_input_multiplier ?? 1) : 1;
  const outputMult = longContext ? (card.long_context_output_multiplier ?? 1) : 1;

  const inputRate = card.input * inputMult;
  const outputRate = card.output * outputMult;
  const ir = inputRate / 1_000_000;
  const orr = outputRate / 1_000_000;

  let cost = tokens.input * ir + tokens.output * orr;
  cost += (tokens.cacheRead * cacheReadRate(card, inputMult)) / 1_000_000;

  if (card.cache_write !== undefined) {
    cost += (tokens.cacheCreation * card.cache_write * inputMult) / 1_000_000;
  } else if (tokens.ephemeral5m === null && tokens.ephemeral1h === null) {
    cost += tokens.cacheCreation * ir * CACHE_CREATE_FALLBACK_MULT;
  } else {
    cost += (tokens.ephemeral5m ?? 0) * ir * EPHEMERAL_5M_MULT;
    cost += (tokens.ephemeral1h ?? 0) * ir * EPHEMERAL_1H_MULT;
  }
  return cost;
}

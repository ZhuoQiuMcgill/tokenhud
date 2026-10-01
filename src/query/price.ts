// Pricing sums of usage rows exactly as the sum of each row's computeCost.
//
// computeCost is linear in the token counts except in two places, and the sums keep both
// exact:
// - Cache creation of a row whose e5 and e1 are both NULL is priced at the 1.25x
//   fallback. roll_hour keeps that creation apart as `ccx`.
// - Long context: a row above its card's threshold is priced at multiplied rates. Such
//   rows are found through the `usage_long` partial index, taken out of the sums and
//   priced one by one.
// The rest is a sum of products, so pricing the sums differs from the per-row sum only by
// floating-point rounding, far below a cent.

import { computeCost, type Rates, type TokenCounts, type Unpriced } from "../pricing/cost.ts";

/** Token sums of a group of usage rows, as roll_hour keeps them. */
export interface Sums {
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  /** e5 and e1 with NULL counted as 0. */
  e5: number;
  e1: number;
  /** The cc of rows whose e5 and e1 are both NULL. */
  ccx: number;
}

/** A usage row that may be above a long-context threshold: candidates for pricing alone. */
export interface CandidateRow {
  readonly ts: number;
  readonly inp: number;
  readonly outp: number;
  readonly cr: number;
  readonly cc: number;
  readonly e5: number | null;
  readonly e1: number | null;
}

export interface Priced {
  cost: number;
  unpricedTokens: number;
  unpricedTierTokens: number;
}

const tokensOf = (s: { inp: number; outp: number; cr: number; cc: number }) =>
  s.inp + s.outp + s.cr + s.cc;

const linearCards = new WeakMap<Rates, Rates>();

/** `card` without its long-context tier, so computeCost prices any sums at base rates. */
function linearCard(card: Rates): Rates {
  let linear = linearCards.get(card);
  if (linear === undefined) {
    const {
      long_context_threshold: _threshold,
      long_context_input_multiplier: _input,
      long_context_output_multiplier: _output,
      long_context_unpriced: _unpriced,
      ...rest
    } = card;
    linear = rest;
    linearCards.set(card, linear);
  }
  return linear;
}

/** The sums of rows that are all at or below `card`'s long-context threshold. */
function linearCost(s: Sums, card: Rates): number {
  const linear = linearCard(card);
  const main: TokenCounts = {
    input: s.inp,
    output: s.outp,
    cacheRead: s.cr,
    cacheCreation: s.cc - s.ccx,
    ephemeral5m: s.e5,
    ephemeral1h: s.e1,
  };
  let cost = computeCost(main, linear) as number;
  if (s.ccx > 0) {
    const fallback: TokenCounts = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: s.ccx,
      ephemeral5m: null,
      ephemeral1h: null,
    };
    cost += computeCost(fallback, linear) as number;
  }
  return cost;
}

function without(s: Sums, row: CandidateRow): Sums {
  const bothNull = row.e5 === null && row.e1 === null;
  return {
    inp: s.inp - row.inp,
    outp: s.outp - row.outp,
    cr: s.cr - row.cr,
    cc: s.cc - row.cc,
    e5: s.e5 - (row.e5 ?? 0),
    e1: s.e1 - (row.e1 ?? 0),
    ccx: s.ccx - (bothNull ? row.cc : 0),
  };
}

/**
 * The cost of a group of rows priced at one card: `sums` of every row, and among
 * `candidates` (rows of the group with large contexts) those above the card's threshold.
 * The caller guarantees that one card applies to every row of the group.
 */
export function priceGroup(
  sums: Sums,
  candidates: readonly CandidateRow[] | undefined,
  card: Rates | Unpriced,
): Priced {
  if (card === "unpriced")
    return { cost: 0, unpricedTokens: tokensOf(sums), unpricedTierTokens: 0 };
  if (card === "unpriced-tier") {
    return { cost: 0, unpricedTokens: 0, unpricedTierTokens: tokensOf(sums) };
  }
  const threshold = card.long_context_threshold;
  let rest = sums;
  let cost = 0;
  let unpricedTierTokens = 0;
  if (threshold !== undefined && candidates !== undefined) {
    for (const row of candidates) {
      if (row.inp + row.cr <= threshold) continue;
      rest = without(rest, row);
      const alone = computeCost(
        {
          input: row.inp,
          output: row.outp,
          cacheRead: row.cr,
          cacheCreation: row.cc,
          ephemeral5m: row.e5,
          ephemeral1h: row.e1,
        },
        card,
      );
      if (typeof alone === "number") cost += alone;
      else unpricedTierTokens += tokensOf(row);
    }
  }
  return { cost: linearCost(rest, card) + cost, unpricedTokens: 0, unpricedTierTokens };
}

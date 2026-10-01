// Bit-for-bit parity with cc-usage v2.6.1's compute_cost (acceptance criterion 1). The
// fixture comes from scripts/gen-cost-parity.py, which runs cc-usage's own Python code.

import { describe, expect, test } from "bun:test";
import { computeCost, type Rates, type TokenCounts } from "../../src/pricing/cost.ts";
import parity from "../fixtures/pricing/cost-parity.json";
import { bundledTable, CC_USAGE_MODELS, CC_USAGE_V261_INSTANT } from "./helpers.ts";

type Case = [number, number, number, number, number, number | null, number | null, number];
const cases = parity.cases as Case[];
const table = bundledTable();

function tokens([, input, output, cacheRead, cacheCreation, e5, e1]: Case): TokenCounts {
  return { input, output, cacheRead, cacheCreation, ephemeral5m: e5, ephemeral1h: e1 };
}

function model(c: Case): string {
  const id = parity.models[c[0]];
  if (id === undefined) throw new Error(`fixture: no model at index ${c[0]}`);
  return id;
}

describe("cost parity with cc-usage v2.6.1", () => {
  test("the fixture covers every model in cc-usage's table with at least 5,000 cases", () => {
    expect(parity.models).toEqual(Object.keys(CC_USAGE_MODELS));
    expect(cases.length).toBeGreaterThanOrEqual(5000);
    expect(new Set(cases.map((c) => c[0])).size).toBe(parity.models.length);
  });

  test("computeCost equals compute_cost exactly, at cc-usage's own rates", () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const rates = CC_USAGE_MODELS[model(c)];
      if (rates === undefined) throw new Error(`fixture: no rates for ${model(c)}`);
      const got = computeCost(tokens(c), rates);
      if (got !== c[7]) mismatches.push(`${JSON.stringify(c)} -> ${got}`);
    }
    expect(mismatches).toEqual([]);
  });

  // Random cards with odd decimal rates and non-power-of-two multipliers. The generator
  // kept each case only if regrouping some cost term changes its result, and checked that
  // every regrouping it knows (input and output rates, sum order, cache read, derived
  // cache-read rate, cache write, aggregate creation, 5m and 1h buckets) is caught by at
  // least 30 of them. The bundled rates are too round to catch most of those.
  test("computeCost equals compute_cost exactly on order-sensitive random cards", () => {
    const cards = parity.cards as Rates[];
    const cardCases = parity.card_cases as Case[];
    expect(cardCases.length).toBeGreaterThanOrEqual(200);
    for (const caught of Object.values(parity.card_cases_catching)) {
      expect(caught).toBeGreaterThanOrEqual(30);
    }
    const mismatches: string[] = [];
    for (const c of cardCases) {
      const card = cards[c[0]];
      if (card === undefined) throw new Error(`fixture: no card at index ${c[0]}`);
      const got = computeCost(tokens(c), card);
      if (got !== c[7]) mismatches.push(`${JSON.stringify(card)} ${JSON.stringify(c)} -> ${got}`);
    }
    expect(mismatches).toEqual([]);
  });

  test("the bundled table prices every case identically at standard tier", () => {
    // At this instant the bundled table's standard cards are cc-usage v2.6.1's rates, so
    // the full lookup path (normalise, find period, pick tier) must reproduce every cost.
    const mismatches: string[] = [];
    for (const c of cases) {
      const got = table.cost({
        ...tokens(c),
        model: model(c),
        tier: "standard",
        atMs: CC_USAGE_V261_INSTANT,
      });
      if (got !== c[7]) mismatches.push(`${model(c)} ${JSON.stringify(c)} -> ${got}`);
    }
    expect(mismatches).toEqual([]);
  });

  test("the bundled standard cards equal cc-usage's rows at that instant", () => {
    for (const [id, row] of Object.entries(CC_USAGE_MODELS)) {
      expect({ id, rates: table.rates(id, "standard", CC_USAGE_V261_INSTANT) }).toEqual({
        id,
        rates: row,
      });
    }
  });
});

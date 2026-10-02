// How the views write costs and days (critique m4, m5): one rule for every view.
import { expect, test } from "bun:test";
import { localDay } from "../../src/tui/views/accounts.tsx";
import { costNote, costText, noteWithLegend } from "../../src/tui/views/cells.ts";
import type { Priced } from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";

guard();

const priced = (over: Partial<Priced> = {}): Priced => ({
  cost: 12.5,
  tokens: 1000,
  pricedShare: 1,
  estimatedCost: 0,
  ...over,
});

test("a cost with no priced token is 'unpriced' in dim, never $0.00", () => {
  expect(costText(priced({ cost: 0, pricedShare: 0 }))).toEqual({ text: "unpriced", role: "dim" });
  expect(costText(priced({ cost: 0, pricedShare: 0 }), true).text).toBe("unpriced");
  // No tokens at all is a real zero.
  expect(costText(priced({ cost: 0, tokens: 0 })).text).toBe("$0.00");
});

test("a cost leaving some tokens out ends in *; one partly estimated starts with ≈", () => {
  expect(costText(priced())).toEqual({ text: "$12.50", role: "cost" });
  expect(costText(priced({ pricedShare: 0.8 })).text).toBe("$12.50*");
  expect(costText(priced({ estimatedCost: 2 })).text).toBe("≈$12.50");
  expect(costText(priced({ cost: 1234.5, pricedShare: 0.5 }), true).text).toBe("$1.23K*");
});

test("the coverage note says what the markers mean, and only when one shows", () => {
  expect(costNote([priced(), priced({ tokens: 0, pricedShare: 1 })])).toBeNull();
  expect(costNote([priced(), priced({ pricedShare: 0 })])).toBe("* not all tokens priced");
  expect(costNote([priced({ pricedShare: 0.9, estimatedCost: 1 })])).toBe(
    "* not all tokens priced · ≈ partly estimated",
  );
});

test("first and last seen carry the year when it isn't the current one", () => {
  const asOf = Date.parse("2026-09-29T15:40:00Z");
  expect(localDay(Date.parse("2026-09-09T12:00:00Z"), asOf, "America/Toronto")).toBe("Sep 9");
  expect(localDay(Date.parse("2025-10-02T12:00:00Z"), asOf, "America/Toronto")).toBe("Oct 2 '25");
  // The year is the zone's: 03:00 UTC on Jan 1 is still Dec 31 in Toronto.
  expect(localDay(Date.parse("2026-01-01T03:00:00Z"), asOf, "America/Toronto")).toBe("Dec 31 '25");
  expect(localDay(null, asOf, "UTC")).toBe("—");
});

test("a section's note leads with the cost legend when it fits, and only with costs shown", () => {
  const items = [priced({ pricedShare: 0.5 })];
  expect(noteWithLegend("BY DAY", "keys", items, true, 80)).toBe("* not all tokens priced · keys");
  expect(noteWithLegend("BY DAY", "keys", items, true, 30)).toBe("keys");
  expect(noteWithLegend("BY DAY", "keys", items, false, 80)).toBe("keys");
  expect(noteWithLegend("BY DAY", "keys", [priced()], true, 80)).toBe("keys");
});

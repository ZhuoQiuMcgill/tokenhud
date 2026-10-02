// codex-auto-review: priced as an estimate from OpenAI's statement of what it ran on.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadPriceTable } from "../../src/pricing/overrides.ts";
import { parsePriceTableFile } from "../../src/pricing/schema.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { guard } from "../guard.ts";
import { at } from "./helpers.ts";

guard();

const bundled = () => new PriceTable(bundledPricing().models, bundledPricing().aliases);
const SWITCH = at("2026-07-30T07:00:00Z");

describe("the bundled codex-auto-review timeline", () => {
  test("is unpriced before GPT-5.4's release, then gpt-5.4, then gpt-5.6-luna; always estimated", () => {
    const table = bundled();
    expect(table.rates("codex-auto-review", "standard", at("2026-03-05T07:59:59Z"))).toBe(
      "unpriced",
    );
    for (const [when, model] of [
      [at("2026-03-05T08:00:00Z"), "gpt-5.4"],
      [SWITCH - 1, "gpt-5.4"],
      [SWITCH, "gpt-5.6-luna"],
      [at("2026-08-06T00:00:00Z"), "gpt-5.6-luna"],
    ] as const) {
      for (const tier of ["standard", "fast"] as const) {
        const target = table.rates(model, tier, when);
        if (typeof target === "string") throw new Error("the target must be priced");
        expect(table.rates("codex-auto-review", tier, when)).toEqual({
          ...target,
          estimated: true,
        });
      }
    }
    expect(table.rates("gpt-5.4", "standard", SWITCH)).not.toHaveProperty("estimated");
  });

  test("is cited, and the table without aliases leaves it unpriced", () => {
    const alias = bundledPricing().aliases["codex-auto-review"];
    expect(alias?.estimated).toBe(true);
    expect(alias?.source).toStartWith("https://");
    expect(
      new PriceTable(bundledPricing().models).rates("codex-auto-review", "standard", SWITCH),
    ).toBe("unpriced");
  });

  test("a cost through the alias is the target's cost", () => {
    const table = bundled();
    const record = {
      tier: "standard" as const,
      atMs: SWITCH + 1,
      input: 1000,
      output: 100,
      cacheRead: 500,
      cacheCreation: 0,
      ephemeral5m: 0,
      ephemeral1h: 0,
    };
    expect(table.cost({ ...record, model: "codex-auto-review" })).toBe(
      table.cost({ ...record, model: "gpt-5.6-luna" }),
    );
  });

  test("the loaded table has it; an override of the alias id wins and is not an estimate", () => {
    expect(
      loadPriceTable(join(import.meta.dir, "no-such-overrides.json")).table.rates(
        "codex-auto-review",
        "standard",
        SWITCH,
      ),
    ).toHaveProperty("estimated", true);
    const own = new PriceTable(
      { ...bundledPricing().models, "codex-auto-review": { input: 1, output: 2 } },
      bundledPricing().aliases,
    );
    expect(own.rates("codex-auto-review", "standard", SWITCH)).toEqual({ input: 1, output: 2 });
  });

  test("an alias whose model has no card when its period starts is unpriced, not mispriced", () => {
    const models = {
      dated: { periods: [{ from: "2026-08-01T00:00:00Z", card: { input: 1, output: 2 } }] },
    };
    const alias = {
      estimated: true as const,
      source: "https://example.com",
      periods: [{ from: null, model: "dated" }],
    };
    expect(
      new PriceTable(models, { a: alias }).rates("a", "standard", at("2026-09-01T00:00:00Z")),
    ).toBe("unpriced");
  });
});

describe("schema", () => {
  const base = {
    version: 2,
    sources: { openai: { url: "https://example.com/pricing.md", checked: "2026-10-01" } },
    models: {
      "m-old": { input: 1, output: 2 },
      "m-new": { periods: [{ from: "2026-07-01T00:00:00Z", card: { input: 3, output: 4 } }] },
    },
  };
  const file = (alias: unknown) => ({ ...base, aliases: { a: alias } });
  const ok = {
    estimated: true,
    source: "https://example.com/x",
    periods: [
      { from: null, model: "m-old" },
      { from: "2026-07-15T00:00:00Z", model: "m-new" },
    ],
  };

  test("accepts a valid timeline and a table without aliases", () => {
    expect(parsePriceTableFile(file(ok)).aliases.a).toEqual(ok as never);
    expect(parsePriceTableFile(base).aliases).toEqual({});
  });

  test.each([
    ["not estimated", { ...ok, estimated: false }, /estimated/],
    ["no https source", { ...ok, source: "http://x" }, /source/],
    ["no periods", { ...ok, periods: [] }, /periods/],
    [
      "unsorted",
      { ...ok, periods: [ok.periods[1], { from: "2026-07-01T00:00:00Z", model: "m-old" }] },
      /sorted/,
    ],
    ["a later null", { ...ok, periods: [ok.periods[0], { from: null, model: "m-old" }] }, /null/],
    ["an unknown model", { ...ok, periods: [{ from: null, model: "nope" }] }, /model/],
    ["a model without a card yet", { ...ok, periods: [{ from: null, model: "m-new" }] }, /no card/],
    ["an unknown field", { ...ok, note: 1 }, /unknown field/],
  ])("rejects %s", (_name, alias, why) => {
    expect(() => parsePriceTableFile(file(alias))).toThrow(why);
  });

  test("rejects an alias that also has its own prices", () => {
    expect(() => parsePriceTableFile({ ...base, aliases: { "m-old": ok } })).toThrow(/own prices/);
  });
});

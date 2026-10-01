import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ccUsageBundled from "../../src/pricing/cc-usage-v2.6.1-pricing.json";
import {
  loadPriceTable,
  mergePricing,
  overridesFromCcUsage,
  parseOverrides,
  readOverrides,
} from "../../src/pricing/overrides.ts";
import { bundledPricing } from "../../src/pricing/table.ts";
import ccUsageUser from "../fixtures/pricing/cc-usage-user-pricing.json";
import { at } from "./helpers.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-pricing-"));
  path = join(dir, "pricing.overrides.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (value: unknown) =>
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
const t = at("2026-08-01T00:00:00Z");

describe("merge", () => {
  test("an override replaces the whole bundled entry; the rest stay bundled", () => {
    write({
      models: {
        "gpt-5.6-sol": { input: 4, output: 20 },
        "Claude-Opus-4-8[1m]": { input: 6, output: 30, fast: { input: 12, output: 60 } },
        "my-local-model": { input: 0.5, output: 1.5 },
      },
    });
    const { table, warnings } = loadPriceTable(path);
    expect(warnings).toEqual([]);
    // Replaced: the bundled dated periods and fast card are gone with it.
    expect(table.rates("gpt-5.6-sol", "standard", t)).toEqual({ input: 4, output: 20 });
    expect(table.rates("gpt-5.6-sol", "fast", t)).toBe("unpriced-tier");
    // Keys are normalised, so this override applies to claude-opus-4-8.
    expect(table.rates("claude-opus-4-8", "standard", t)).toEqual({ input: 6, output: 30 });
    expect(table.rates("claude-opus-4-8", "fast", t)).toEqual({ input: 12, output: 60 });
    // Added.
    expect(table.rates("my-local-model", "standard", t)).toEqual({ input: 0.5, output: 1.5 });
    // Untouched entries keep the bundled values, including a later bundled fix.
    expect(table.rates("gpt-5.6-terra", "standard", t)).toMatchObject({ input: 2, output: 12 });
    expect(table.rates("claude-opus-5-5", "fast", t)).toEqual({
      input: 8,
      output: 40,
      cache_read: 0.4,
    });
  });

  test("mergePricing is bundled with overrides on top, by key", () => {
    const merged = mergePricing(
      { a: { input: 1, output: 1 }, b: { input: 2, output: 2 } },
      { b: { input: 3, output: 3 }, c: { input: 4, output: 4 } },
    );
    expect(merged).toEqual({
      a: { input: 1, output: 1 },
      b: { input: 3, output: 3 },
      c: { input: 4, output: 4 },
    });
  });

  test("overrides may be dated too", () => {
    write({
      models: {
        "claude-opus-4-8": {
          periods: [
            { from: null, card: { input: 5, output: 25 } },
            { from: "2026-09-01T00:00:00Z", card: { input: 4, output: 20 } },
          ],
        },
      },
    });
    const { table } = loadPriceTable(path);
    expect(table.rates("claude-opus-4-8", "standard", t)).toEqual({ input: 5, output: 25 });
    expect(table.rates("claude-opus-4-8", "standard", at("2026-09-02T00:00:00Z"))).toEqual({
      input: 4,
      output: 20,
    });
  });
});

describe("a bad overrides file never crashes", () => {
  const bundledOnly = () => {
    const { table, warnings } = loadPriceTable(path);
    expect(table.rates("gpt-5.6-sol", "standard", t)).toMatchObject({ input: 5, output: 30 });
    expect(table.rates("claude-opus-4-8", "standard", t)).toEqual({ input: 5, output: 25 });
    return warnings;
  };

  test("a missing file means bundled prices and no warning, and nothing is created", () => {
    expect(bundledOnly()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("malformed JSON warns and uses bundled prices only", () => {
    write('{"models": {"claude-opus-4-8": {"input": 1,, }');
    const warnings = bundledOnly();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain("not valid JSON");
  });

  test.each([
    ["an empty file", ""],
    ["no models object", { claude: { input: 1, output: 1 } }],
    ["models as a list", { models: [{ input: 1, output: 1 }] }],
    ["a bare array", [1, 2, 3]],
    ["null", "null"],
  ])("%s warns and uses bundled prices only", (_, content) => {
    write(content);
    expect(bundledOnly()).toHaveLength(1);
  });

  test("an unreadable path warns", () => {
    mkdirSync(path);
    const warnings = bundledOnly();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not read");
  });

  test("an invalid entry is skipped with a warning; valid ones still apply", () => {
    write({
      models: {
        "claude-opus-4-8": { input: "lots", output: 25 },
        "gpt-5.6-sol": { input: 4, output: 20, cache_reads: 0.4 },
        "[1m]": { input: 1, output: 1 },
        "claude-opus-4-7": { input: 4, output: 20 },
      },
    });
    const { table, warnings } = loadPriceTable(path);
    expect(warnings).toEqual([
      `${path}: skipped "[1m]": not a model id`,
      `${path}: skipped "claude-opus-4-8": models.claude-opus-4-8.input: expected a non-negative number, got "lots"`,
      `${path}: skipped "gpt-5.6-sol": models.gpt-5.6-sol: unknown field "cache_reads"`,
    ]);
    expect(table.rates("claude-opus-4-8", "standard", t)).toEqual({ input: 5, output: 25 });
    expect(table.rates("gpt-5.6-sol", "standard", t)).toMatchObject({ input: 5, output: 30 });
    expect(table.rates("claude-opus-4-7", "standard", t)).toEqual({ input: 4, output: 20 });
  });

  test("of two keys for one model, the normalised one wins", () => {
    const parsed = parseOverrides(
      JSON.stringify({
        models: {
          "Claude-Opus-4-8": { input: 1, output: 1 },
          "claude-opus-4-8": { input: 2, output: 2 },
          "claude-opus-4-8-20260101": { input: 3, output: 3 },
        },
      }),
      "f.json",
    );
    expect(parsed.models).toEqual({ "claude-opus-4-8": { input: 2, output: 2 } });
    expect(parsed.warnings).toEqual([
      'f.json: skipped "Claude-Opus-4-8": duplicates "claude-opus-4-8"',
      'f.json: skipped "claude-opus-4-8-20260101": duplicates "claude-opus-4-8"',
    ]);
  });

  // The T2 review's case. From about 40k levels deep, JSON.stringify in an error message
  // overflowed the stack and crashed loadPriceTable at startup; below that, the warning
  // embedded the whole value (80 KB at 40k). JSON.parse itself copes with 400k.
  const nested = (depth: number) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  test.each([
    ["a rate", 40_000, (deep: string) => `{"models":{"x":{"input":${deep},"output":1}}}`],
    ["a rate", 400_000, (deep: string) => `{"models":{"x":{"input":${deep},"output":1}}}`],
    [
      "a fast card",
      400_000,
      (deep: string) => `{"models":{"x":{"input":1,"output":1,"fast":${deep}}}}`,
    ],
    [
      "a period",
      400_000,
      (deep: string) => `{"models":{"x":{"periods":[{"from":${deep},"card":{}}]}}}`,
    ],
  ])("a value in %s nested %i deep is skipped with a short warning", (_, depth, wrap) => {
    write(wrap(nested(depth)));
    const warnings = bundledOnly();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(`${path}: skipped "x": models.x`);
    expect((warnings[0] as string).length).toBeLessThan(path.length + 200);
  });

  test("a document nested 1,000,000 deep warns and uses bundled prices only", () => {
    write(`{"models":{"x":${"[".repeat(1_000_000)}${"]".repeat(1_000_000)}}}`);
    const warnings = bundledOnly();
    expect(warnings).toHaveLength(1);
  });

  test("a leading byte-order mark is ignored", () => {
    write(`\uFEFF${JSON.stringify({ models: { "claude-opus-4-8": { input: 4, output: 20 } } })}`);
    const { table, warnings } = loadPriceTable(path);
    expect(warnings).toEqual([]);
    expect(table.rates("claude-opus-4-8", "standard", t)).toEqual({ input: 4, output: 20 });
  });

  test("readOverrides never throws", () => {
    expect(readOverrides(join(dir, "nope", "x.json"))).toEqual({ models: {}, warnings: [] });
  });
});

describe("overridesFromCcUsage", () => {
  test("keeps only the rows the user changed, keyed by normalised id", () => {
    // The fixture has the shape of a real ~/.config/cc-usage/pricing.json (seeded comment,
    // the same eleven Claude rows, float values), with fixture values: two changed rows,
    // numeric strings, a bad optional field, a dated duplicate key, a user-only model and
    // a row cc-usage itself would have dropped.
    expect(overridesFromCcUsage(ccUsageUser, ccUsageBundled)).toEqual({
      models: {
        "claude-opus-4-8": { input: 4.5, output: 22.5 },
        "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5 },
        "my-local-model": { input: 0.5, output: 1.5 },
      },
    });
  });

  test("an untouched seeded copy imports nothing, so bundled fixes keep applying", () => {
    const seeded = {
      _comment: ccUsageUser._comment,
      models: Object.fromEntries(
        Object.entries(ccUsageBundled.models).filter(([id]) => id.startsWith("claude-")),
      ),
    };
    expect(overridesFromCcUsage(seeded, ccUsageBundled)).toEqual({ models: {} });
  });

  test("the result is a valid overrides file", () => {
    write(overridesFromCcUsage(ccUsageUser, ccUsageBundled));
    const { table, warnings } = loadPriceTable(path);
    expect(warnings).toEqual([]);
    expect(table.rates("claude-opus-4-8", "standard", t)).toEqual({ input: 4.5, output: 22.5 });
    // Imported rows are standard cards: the bundled fast card goes with the replaced entry.
    expect(table.rates("claude-opus-4-8", "fast", t)).toBe("unpriced-tier");
    expect(table.rates("claude-opus-5", "fast", t)).toEqual({ input: 10, output: 50 });
  });

  test("tolerates junk input", () => {
    for (const junk of [null, 42, "x", [], {}, { models: null }, { models: [1] }]) {
      expect(overridesFromCcUsage(junk, ccUsageBundled)).toEqual({ models: {} });
    }
    // Against an unusable bundled table, every valid user row counts as the user's own.
    expect(Object.keys(overridesFromCcUsage(ccUsageUser, null).models)).toHaveLength(12);
  });

  test("does not touch the bundled table", () => {
    const before = JSON.stringify(bundledPricing());
    overridesFromCcUsage(ccUsageUser, ccUsageBundled);
    expect(JSON.stringify(bundledPricing())).toBe(before);
  });
});

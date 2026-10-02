import { describe, expect, test } from "bun:test";
import { normalizeModel } from "../../src/pricing/normalize.ts";
import { PriceTable } from "../../src/pricing/table.ts";
import { guard } from "../guard.ts";

guard();

describe("normalizeModel", () => {
  test.each([
    ["claude-opus-4-8[1m]", "claude-opus-4-8"],
    ["claude-opus-4-8[1M]", "claude-opus-4-8"],
    ["claude-opus-4-8 [ 1m ]", "claude-opus-4-8"],
    ["us.anthropic.claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["eu.anthropic.claude-haiku-4-5", "claude-haiku-4-5"],
    ["anthropic.claude-opus-4-6", "claude-opus-4-6"],
    ["anthropic/claude-opus-5", "claude-opus-5"],
    ["gpt-5.6-sol-2026-07-09", "gpt-5.6-sol"],
    ["gpt-4o-2024-05-13", "gpt-4o"],
    ["claude-3-5-haiku-241022", "claude-3-5-haiku"],
    ["GPT-5.4-MINI", "gpt-5.4-mini"],
    ["\tgpt-5.2\n", "gpt-5.2"],
    ["   ", ""],
    [undefined, ""],
  ])("%p -> %p", (raw, normalised) => {
    expect(normalizeModel(raw)).toBe(normalised);
  });

  test("keeps point releases, which are not date stamps", () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol"]) {
      expect(normalizeModel(id)).toBe(id);
    }
    expect(normalizeModel("claude-fable-5-1-20261001")).toBe("claude-fable-5-1");
  });

  test("strips stacked provider prefixes in order, as cc-usage does", () => {
    expect(normalizeModel("us.anthropic.anthropic/claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("the gpt-5.6 alias", () => {
  test("resolves dated and bare ids to gpt-5.6-sol", () => {
    const table = new PriceTable({ "gpt-5.6-sol": { input: 4, output: 20 } });
    for (const id of ["gpt-5.6", "GPT-5.6", "gpt-5.6-2026-07-09"]) {
      expect(table.rates(id, "standard", 0)).toEqual({ input: 4, output: 20 });
    }
    expect(table.rates("gpt-5.6-terra", "standard", 0)).toBe("unpriced");
  });
});

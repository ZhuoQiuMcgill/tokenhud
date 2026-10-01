import { describe, expect, test } from "bun:test";
import {
  PricingSchemaError,
  parseIsoUtc,
  parseModelPricing,
  parsePriceTableFile,
} from "../../src/pricing/schema.ts";

const strict = { coerce: false };
const lenient = { coerce: true };
const parse = (raw: unknown, opts = strict) => parseModelPricing(raw, "m", opts);
const rejects = (raw: unknown, message: RegExp, opts = strict) => {
  expect(() => parse(raw, opts)).toThrow(PricingSchemaError);
  expect(() => parse(raw, opts)).toThrow(message);
};

describe("rate cards", () => {
  test("accept the standard fields and a fast card", () => {
    const card = {
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
      long_context_threshold: 272000,
      long_context_input_multiplier: 2,
      long_context_output_multiplier: 1.5,
      fast: { input: 10, output: 60, cache_read: 1, cache_write: 12.5 },
    };
    expect(parse(card)).toEqual(card);
    expect(parse({ input: 0, output: 0 })).toEqual({ input: 0, output: 0 });
  });

  test("ignore _comment-style keys", () => {
    expect(parse({ _note: "promo", input: 1, output: 2 })).toEqual({ input: 1, output: 2 });
  });

  test("reject missing, negative and non-finite rates", () => {
    rejects({ output: 1 }, /m\.input: expected a non-negative number/);
    rejects({ input: 1 }, /m\.output/);
    rejects({ input: -1, output: 1 }, /m\.input/);
    rejects({ input: 1, output: 1, cache_read: Number.NaN }, /m\.cache_read/);
    rejects({ input: 1, output: Number.POSITIVE_INFINITY }, /m\.output/);
    rejects({ input: 1, output: 1, fast: { input: 2 } }, /m\.fast\.output/);
    rejects("cheap", /m: expected an object/);
    rejects(null, /m: expected an object/);
  });

  test("reject unknown fields, so a typo can't silently change a price", () => {
    rejects({ input: 1, output: 1, cache_reads: 0.1 }, /unknown field "cache_reads"/);
    rejects(
      { input: 1, output: 1, fast: { input: 2, output: 2, long_context_threshold: 1 } },
      /m\.fast/,
    );
  });

  test("take numeric strings only when coercing, and only decimal ones", () => {
    rejects({ input: "1", output: 1 }, /m\.input/);
    expect(parse({ input: " 2.5 ", output: "1e1", cache_read: ".5" }, lenient)).toEqual({
      input: 2.5,
      output: 10,
      cache_read: 0.5,
    });
    for (const bad of ["0x10", "", "nan", "inf", "Infinity", "1_000", "-1", "two"]) {
      rejects({ input: bad, output: 1 }, /m\.input/, lenient);
    }
    rejects({ input: true, output: 1 }, /m\.input/, lenient);
  });
});

describe("dated pricing", () => {
  const card = { input: 1, output: 2 };

  test("accepts sorted periods led by a null 'from'", () => {
    const dated = {
      periods: [
        { from: null, card },
        { from: "2026-08-21T00:00:00Z", card: { input: 0.5, output: 1 } },
        { from: "2026-09-01", card },
        { from: "2026-09-02T10:30Z", card },
        { from: "2026-09-02T10:30:53.5Z", card },
      ],
    };
    expect(parse(dated)).toEqual(dated);
  });

  test("rejects malformed period lists", () => {
    rejects({ periods: [] }, /m\.periods: expected a non-empty array/);
    rejects(
      {
        periods: [
          { from: "2026-01-01", card },
          { from: null, card },
        ],
      },
      /only the first period/,
    );
    rejects(
      {
        periods: [
          { from: "2026-02-01", card },
          { from: "2026-01-01", card },
        ],
      },
      /sorted by 'from'/,
    );
    rejects(
      {
        periods: [
          { from: "2026-01-01", card },
          { from: "2026-01-01", card },
        ],
      },
      /sorted/,
    );
    rejects({ periods: [{ from: "2026-02-30", card }] }, /ISO-8601/);
    rejects({ periods: [{ from: "2026-01-01T00:00:00+02:00", card }] }, /ISO-8601/);
    rejects({ periods: [{ from: 1767225600000, card }] }, /expected null or an ISO-8601/);
    rejects({ periods: [{ card }] }, /expected null or an ISO-8601/);
    rejects({ periods: [{ from: null, card: { input: 1 } }] }, /m\.periods\[0\]\.card\.output/);
    rejects({ periods: [{ from: null, card }], input: 1 }, /unknown field "input"/);
  });
});

describe("parseIsoUtc", () => {
  test("reads UTC dates and times, and nothing ambiguous", () => {
    expect(parseIsoUtc("2026-08-21")).toBe(Date.UTC(2026, 7, 21));
    expect(parseIsoUtc("2026-08-21T10:30:53Z")).toBe(Date.UTC(2026, 7, 21, 10, 30, 53));
    expect(parseIsoUtc("2026-08-21T10:30:53.25Z")).toBe(Date.UTC(2026, 7, 21, 10, 30, 53, 250));
    for (const bad of [
      "2026-08-21T10:30:53",
      "2026-13-01",
      "2026-02-29",
      "2026-08-21T24:00Z",
      "21/08/2026",
    ]) {
      expect(parseIsoUtc(bad)).toBeUndefined();
    }
    expect(parseIsoUtc("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
  });
});

describe("price table file", () => {
  const file = (patch: Record<string, unknown>) => ({
    version: 2,
    sources: { openai: { url: "https://example.com/pricing.md", checked: "2026-10-01" } },
    models: { "gpt-x": { input: 1, output: 2 } },
    ...patch,
  });

  test("accepts a minimal table", () => {
    expect(parsePriceTableFile(file({ _comment: "hi" })).models).toEqual({
      "gpt-x": { input: 1, output: 2 },
    });
  });

  test("rejects a wrong version, bad sources and non-normalised keys", () => {
    expect(() => parsePriceTableFile(file({ version: 1 }))).toThrow(/version/);
    expect(() =>
      parsePriceTableFile(file({ sources: { a: { url: "http://x", checked: "2026-10-01" } } })),
    ).toThrow(/url/);
    expect(() =>
      parsePriceTableFile(file({ sources: { a: { url: "https://x", checked: "Oct 1" } } })),
    ).toThrow(/checked/);
    expect(() =>
      parsePriceTableFile(file({ models: { "GPT-X": { input: 1, output: 2 } } })),
    ).toThrow(/normalised/);
    expect(() =>
      parsePriceTableFile(file({ models: { "gpt-x": { input: "1", output: 2 } } })),
    ).toThrow(/gpt-x\.input/);
    expect(() => parsePriceTableFile([])).toThrow(PricingSchemaError);
  });
});

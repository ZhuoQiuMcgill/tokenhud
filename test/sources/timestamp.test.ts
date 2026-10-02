import { expect, test } from "bun:test";
import { timestampMs } from "../../src/sources/timestamp.ts";
import vectors from "../fixtures/sources/timestamp-vectors.json";
import { guard } from "../guard.ts";

guard();

// Every expected value is cc-usage's own `round(parse_timestamp(s) * 1000)`
// (test/fixtures/sources/gen_timestamp_vectors.py).
test.each(vectors.map((v) => [v.input, v.ms]))("%j -> %p", (input, ms) => {
  expect(timestampMs(input)).toBe(ms);
});

test("the vectors cover the fallback, offsets, rounding and the canonical shape", () => {
  expect(vectors.length).toBeGreaterThan(500);
  expect(vectors.filter((v) => v.ms === null).length).toBeGreaterThan(40);
});

test("only strings parse", () => {
  for (const value of [null, undefined, 0, 1780272000000, true, {}, []])
    expect(timestampMs(value)).toBeNull();
});

import { describe, expect, test } from "bun:test";
import { CC_USAGE_KEY_SCHEME } from "../../src/store/import-cc-usage.ts";
import { ledgerKey } from "../../src/store/key.ts";
import vectors from "../fixtures/store/key-vectors.json";
import { guard } from "../guard.ts";

guard();

// Every expected key comes from cc-usage's own parser.ledger_key (gen_key_vectors.py).
describe("ledgerKey matches cc-usage", () => {
  test("the fixture covers the required cases", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(50);
    const bytes = new Set(vectors.cases.map((c) => c.bytes));
    for (const n of [0, 127, 128, 129, 256]) expect(bytes).toContain(n);
    expect(Math.max(...bytes)).toBeGreaterThan(10_000);
    const lone = vectors.cases.filter(
      (c) => /[\ud800-\udfff]/.test(c.material) && !c.material.isWellFormed(),
    );
    expect(lone.length).toBeGreaterThanOrEqual(10);
  });

  test.each(vectors.cases.map((c) => [c.name, c.material, c.key] as const))(
    "%s",
    (_name, material, key) => {
      expect(ledgerKey(material)).toBe(BigInt(key));
    },
  );

  test("the vectors come from the cc-usage key scheme the import reads", () => {
    expect(CC_USAGE_KEY_SCHEME).toBe(vectors.key_scheme);
  });

  test("a lone surrogate is not the replacement character", () => {
    // TextEncoder would turn U+D800 into U+FFFD and collide the two keys.
    expect(ledgerKey("req-\ud800")).not.toBe(ledgerKey("req-�"));
  });

  test("results do not depend on what was hashed before", () => {
    const long = vectors.cases.find((c) => c.bytes > 10_000);
    const short = vectors.cases.find((c) => c.name === "abc");
    if (long === undefined || short === undefined) throw new Error("fixture changed");
    ledgerKey(long.material);
    expect(ledgerKey(short.material)).toBe(BigInt(short.key));
    expect(ledgerKey(long.material)).toBe(BigInt(long.key));
  });
});

describe("ledgerKey performance", () => {
  // The budget is 50,000 keys in 300 ms; `bun run bench:store` enforces it exactly on a
  // Linux dev machine. Shared CI runners vary by a few times, so here it is a 3x
  // regression guard that still fails on a real slowdown.
  test("keys 50,000 realistic materials within 3x the 300 ms budget", () => {
    const materials = Array.from(
      { length: 50_000 },
      (_, i) =>
        `c\x1freq_FAKE${i.toString(36).padStart(20, "0")}\x1fmsg_FAKE${(i * 7919).toString(36).padStart(20, "0")}`,
    );
    ledgerKey(materials[0] ?? ""); // warm up the JIT once
    const t0 = performance.now();
    let acc = 0n;
    for (const material of materials) acc ^= ledgerKey(material);
    const ms = performance.now() - t0;
    expect(acc).not.toBe(0n);
    console.log(`ledgerKey: 50,000 keys in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(900);
  });
});

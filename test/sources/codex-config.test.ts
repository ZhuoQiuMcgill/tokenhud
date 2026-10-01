import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configFallbackTier,
  serviceTier,
  topLevelServiceTier,
} from "../../src/sources/codex-config.ts";
import { cleanup, tempDir } from "../ingest/helpers.ts";

afterEach(cleanup);

test("service tier spellings (ccusage's mapping, exact strings only)", () => {
  expect(["priority", "fast", "default", "standard"].map(serviceTier)).toEqual([1, 1, 0, 0]);
  for (const odd of ["Priority", " fast", "flex", "turbo", ""])
    expect(serviceTier(odd)).toBeUndefined();
});

test.each([
  ['service_tier = "priority"', "priority"],
  ["service_tier='fast' # a comment", "fast"],
  ['"service_tier" = "default"', "default"],
  ['model = "x"\n\nservice_tier = "standard"\n[profiles.a]\nservice_tier = "priority"', "standard"],
  ['[profiles.a]\nservice_tier = "priority"', undefined],
  ['service_tier_override = "fast"', undefined],
  ['service_tier = "fa\\"st"', 'fa"st'],
  ["service_tier = 1", undefined],
  ['notes = """\nservice_tier = "priority"\n[x]\n"""\nservice_tier = "default"', "default"],
  ["", undefined],
])("config.toml %p has top-level service_tier %p", (text, want) => {
  expect(topLevelServiceTier(text)).toBe(want);
});

test("the fallback tier: config.toml's top-level service_tier, else 0", () => {
  const home = join(tempDir(), ".codex");
  expect(configFallbackTier(home)).toBe(0); // no home at all
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), 'service_tier = "priority"\n');
  expect(configFallbackTier(home)).toBe(1);
  writeFileSync(join(home, "config.toml"), 'service_tier = "flex"\n');
  expect(configFallbackTier(home)).toBe(0);
  writeFileSync(join(home, "config.toml"), "\u0000 not toml at all [[[");
  expect(configFallbackTier(home)).toBe(0);
});

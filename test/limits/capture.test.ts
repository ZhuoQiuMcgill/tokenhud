import { describe, expect, test } from "bun:test";
import {
  bucketLabel,
  capturedAt,
  epochSeconds,
  freshest,
  LimitFetchError,
  labelForMinutes,
  normalizeClaudeLimits,
  normalizeCodexLimits,
  orderedBuckets,
  parseCapture,
  windowMinutes,
} from "../../src/limits/capture.ts";
import { guard } from "../guard.ts";
import { CLAUDE_RESPONSE, CODEX_RESPONSE, capture } from "./helpers.ts";

guard();

// Ported from cc-usage's tests/test_limits_fetch.py and the T13 account tests.

describe("normalisers", () => {
  test("both providers keep every scoped limit, in cc-usage's labels and order", () => {
    const claude = normalizeClaudeLimits(CLAUDE_RESPONSE, 10);
    const codex = normalizeCodexLimits(CODEX_RESPONSE, 20);
    const rows = [...orderedBuckets(claude), ...orderedBuckets(codex)].map(([key, b]) => [
      bucketLabel(key, b),
      b.used_percentage,
    ]);
    expect(rows).toEqual([
      ["5-HOUR", 26],
      ["WEEKLY", 69],
      ["FABLE WEEKLY", 99],
      ["WEEKLY", 35],
      ["GPT SPARK 5-HOUR", 4],
    ]);
    expect(claude).toMatchObject({ captured_at: 10, source: "claude", via: "api" });
    expect(codex).toMatchObject({ captured_at: 20, source: "codex", via: "rpc" });
    // 2026-07-13T00:50:00Z, by hand: 20647 days * 86400 + 50 * 60.
    expect(claude.rate_limits.session?.resets_at).toBe(1_783_903_800);
    expect(codex.rate_limits.codex_spark_primary).toEqual({
      label: "GPT SPARK 5-HOUR",
      used_percentage: 4,
      resets_at: 2_000_000_100,
      window_minutes: 300,
    });
  });

  test.each([[{}], [{ limits: [] }], [null], [[]]])(
    "invalid Claude payload %p is rejected",
    (p) => {
      expect(() => normalizeClaudeLimits(p)).toThrow(LimitFetchError);
    },
  );

  test("Claude's older shape (utilization per top-level key) still normalises", () => {
    const old = {
      five_hour: { utilization: 12.5, resets_at: "2026-07-13T00:50:00Z" },
      seven_day: { utilization: 40, resets_at: 1_784_000_000 },
      seven_day_opus: null,
    };
    const c = normalizeClaudeLimits(old, 1);
    expect(Object.keys(c.rate_limits)).toEqual(["five_hour", "seven_day"]);
    expect(orderedBuckets(c).map(([k, b]) => bucketLabel(k, b))).toEqual(["5-HOUR", "WEEKLY"]);
  });

  test("a repeated Claude kind gets its index; unknown kinds and missing kinds are labelled", () => {
    const c = normalizeClaudeLimits(
      {
        limits: [
          { kind: "session", percent: 1, resets_at: 100 },
          { kind: "session", percent: 2, resets_at: 200 },
          { percent: 3, resets_at: 300 },
          { kind: "monthly_extra", percent: 4, resets_at: 400 },
          { kind: "weekly_scoped", percent: 5, resets_at: 500, scope: { surface: "web" } },
          { kind: "bad", percent: "9", resets_at: 600 },
        ],
      },
      1,
    );
    expect(Object.fromEntries(Object.entries(c.rate_limits).map(([k, b]) => [k, b.label]))).toEqual(
      {
        session: "5-HOUR",
        session_1: "5-HOUR",
        limit_2: "LIMIT 2",
        monthly_extra: "MONTHLY EXTRA",
        weekly_scoped: "WEB WEEKLY",
      },
    );
  });

  test("Codex falls back to the single-bucket view", () => {
    const c = normalizeCodexLimits(
      {
        rateLimits: {
          primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_000 },
          secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 2_000 },
        },
        rateLimitsByLimitId: null,
      },
      1,
    );
    expect(Object.keys(c.rate_limits)).toEqual(["codex_primary", "codex_secondary"]);
    expect(c.rate_limits.codex_secondary?.label).toBe("WEEKLY");
  });

  test.each([[{}], [{ rateLimits: { primary: null } }], ["x"]])(
    "empty Codex %p is rejected",
    (p) => {
      expect(() => normalizeCodexLimits(p)).toThrow(LimitFetchError);
    },
  );
});

describe("labels and window lengths", () => {
  test.each([
    [10080, "WEEKLY"],
    [20160, "2-WEEK"],
    [1440, "1-DAY"],
    [300, "5-HOUR"],
    [45, "45-MIN"],
    [0, "PRIMARY"],
    [null, "PRIMARY"],
  ])("labelForMinutes(%p)", (minutes, label) => {
    expect(labelForMinutes(minutes, "primary")).toBe(label);
  });

  test("window length comes from cc-usage's bucket metadata", () => {
    expect(windowMinutes("session", { used_percentage: 1, resets_at: 1 })).toBe(300);
    expect(windowMinutes("five_hour", { used_percentage: 1, resets_at: 1 })).toBe(300);
    expect(windowMinutes("weekly_all", { used_percentage: 1, resets_at: 1 })).toBe(10080);
    expect(windowMinutes("weekly_scoped_2", { used_percentage: 1, resets_at: 1 })).toBe(10080);
    expect(windowMinutes("seven_day_opus", { used_percentage: 1, resets_at: 1 })).toBe(10080);
    expect(
      windowMinutes("codex_primary", { used_percentage: 1, resets_at: 1, window_minutes: 300 }),
    ).toBe(300);
    expect(windowMinutes("x", { used_percentage: 1, resets_at: 1, label: "FABLE WEEKLY" })).toBe(
      10080,
    );
    expect(windowMinutes("x", { used_percentage: 1, resets_at: 1, label: "SPARK 2-DAY" })).toBe(
      2880,
    );
    expect(windowMinutes("limit_0", { used_percentage: 1, resets_at: 1 })).toBeNull();
  });

  test("ordered: five_hour, seven_day, then the rest by key; malformed buckets dropped", () => {
    const c = capture("claude", 1, {
      zeta: { pct: 1, resets: 9 },
      seven_day: { pct: 2, resets: 9 },
      alpha: { pct: 3, resets: 9 },
      five_hour: { pct: 4, resets: 9 },
    });
    (c.rate_limits as Record<string, unknown>).broken = { used_percentage: "x", resets_at: 1 };
    expect(orderedBuckets(c).map(([k]) => k)).toEqual(["five_hour", "seven_day", "alpha", "zeta"]);
  });
});

describe("captures", () => {
  test("freshest wins by captured_at; a missing one never wins", () => {
    const a = capture("codex", 10, {});
    const b = capture("codex", 20, {});
    expect(freshest([a, b])).toBe(b);
    expect(freshest([b, a])).toBe(b);
    expect(freshest([null, a, undefined])).toBe(a);
    expect(freshest([])).toBeNull();
    expect(capturedAt({})).toBe(Number.NEGATIVE_INFINITY);
  });

  test("epochSeconds takes numbers and ISO strings only", () => {
    expect(epochSeconds(5)).toBe(5);
    expect(epochSeconds("1970-01-01T00:00:10Z")).toBe(10);
    expect(epochSeconds("not a date")).toBeNull();
    expect(epochSeconds("")).toBeNull();
    expect(epochSeconds(true)).toBeNull();
  });

  test("parseCapture keeps only well-formed parts", () => {
    expect(parseCapture({ captured_at: 1, source: "gemini", rate_limits: {} })).toBeNull();
    expect(parseCapture({ captured_at: "1", source: "claude", rate_limits: {} })).toBeNull();
    expect(
      parseCapture({
        captured_at: 1,
        source: "claude",
        via: "api",
        token: "dropped",
        rate_limits: {
          a: { used_percentage: 5, resets_at: 9, label: "5-HOUR", extra: 1 },
          b: { used_percentage: null, resets_at: 9 },
        },
      }),
    ).toEqual({
      captured_at: 1,
      source: "claude",
      via: "api",
      rate_limits: { a: { used_percentage: 5, resets_at: 9, label: "5-HOUR" } },
    });
  });
});

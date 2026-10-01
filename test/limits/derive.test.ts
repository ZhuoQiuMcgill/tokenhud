// Pace and projected exhaustion, by hand. Rates from the bundled table: claude-opus-4-8
// output is $25 per 1M tokens, so a row of 20,000 output tokens costs exactly $0.50.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import {
  type ProjectionInput,
  projectExhaustion,
  spendFromQueries,
} from "../../src/limits/derive.ts";
import { Limits } from "../../src/limits/index.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { UsageQueries } from "../../src/query/engine.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { capture, cleanup, fakeRoot, tempDir } from "./helpers.ts";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  cleanup();
});

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-09-30T14:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("projectExhaustion (the formula)", () => {
  // Spend: $0.50 at each of these instants.
  const spends = ["11:30", "13:20", "13:40", "13:50", "13:58"].map((t) =>
    at(`2026-09-30T${t}:00Z`),
  );
  const spent = (from: number, to: number) =>
    spends.filter((t) => t >= from && t < to).length * 0.5;
  const base: ProjectionInput = {
    utilization: 0.3,
    capturedAt: at("2026-09-30T13:55:00Z"),
    resetsAt: at("2026-09-30T16:00:00Z"),
    windowMs: 5 * HOUR,
    costPerHour: 3,
    now: NOW,
    spent,
  };

  test("a time: utilisation per dollar from the window's own spend, then the pace", () => {
    // Window 11:00-16:00. $2.00 spent to the 13:55 capture at 30 %: 0.15 per dollar.
    // $0.50 since then: 37.5 % now. 0.625 / (0.15 * $3/h) = 1 h 23 min 20 s after 14:00.
    expect(projectExhaustion(base)).toBe(at("2026-09-30T15:23:20Z"));
  });

  test("safe: the projection falls after the reset", () => {
    // Weekly from Sep 26: $2.00 to the capture at 1 %: 0.005 per dollar, 1.25 % now;
    // 0.9875 / 0.015 = 65.8 h after 14:00 is Oct 3 07:50, after the Oct 3 00:00 reset.
    const weekly = {
      ...base,
      utilization: 0.01,
      resetsAt: at("2026-10-03T00:00:00Z"),
      windowMs: 7 * 24 * HOUR,
    };
    expect(projectExhaustion(weekly)).toBe("safe");
    // The same week at 10 % runs out on Sep 30 at 19:50 (0.875 / 0.15 = 5 h 50 min).
    expect(projectExhaustion({ ...weekly, utilization: 0.1 })).toBe(at("2026-09-30T19:50:00Z"));
  });

  test("— without enough data", () => {
    // Under $0.50 in the window before the capture (only the 13:58 row is after 13:57).
    expect(projectExhaustion({ ...base, resetsAt: at("2026-09-30T18:57:00Z") })).toBeNull();
    expect(projectExhaustion({ ...base, costPerHour: 0 })).toBeNull();
    expect(projectExhaustion({ ...base, windowMs: null })).toBeNull();
    expect(projectExhaustion({ ...base, utilization: 1 })).toBeNull();
    expect(projectExhaustion({ ...base, now: base.resetsAt })).toBeNull();
    expect(projectExhaustion({ ...base, capturedAt: base.resetsAt })).toBeNull();
  });

  test("a window this spend does not move is safe; one already past 100 % by now is now", () => {
    expect(projectExhaustion({ ...base, utilization: 0 })).toBe("safe");
    // 0.95 / $2.00 per dollar, plus $0.50 since: 118.75 % now.
    expect(projectExhaustion({ ...base, utilization: 0.95 })).toBe(NOW);
  });
});

describe("getLimits over a synthetic store", () => {
  let key = 1n;
  const opus = (identity: string, label: string, iso: string, outp = 20_000): UsageRow => ({
    key: key++,
    provider: "claude",
    identity,
    label,
    ts: at(iso),
    model: "claude-opus-4-8",
    inp: 0,
    outp,
    cr: 0,
    cc: 0,
    e5: null,
    e1: null,
    tier: 0,
  });

  function setup() {
    const dir = tempDir();
    const busy = fakeRoot("claude", "busy", "/home/x/.claude", { source: "auto" });
    const idle = fakeRoot("claude", "idle", "/home/x/.claude-idle", { source: "home" });
    const fresh = fakeRoot("claude", "fresh", "/home/x/.claude-fresh", { source: "home" });
    const store = openStore(join(dir, "tokenhud.db"));
    store.upsert([
      ...["11:30", "13:20", "13:40", "13:50", "13:58"].map((t) =>
        opus(busy.identity, "busy", `2026-09-30T${t}:00Z`),
      ),
      opus(busy.identity, "busy", "2026-09-30T14:00:00Z"), // now: inside the pace window
      opus(idle.identity, "idle", "2026-09-30T12:00:00Z", 10_000), // $0.25
    ]);
    store.close();
    const db = openStoreReader(join(dir, "tokenhud.db")) as Database;
    open.push(db);
    const queries = new UsageQueries(db, new PriceTable(bundledPricing().models), {
      tz: "UTC",
      now: () => NOW,
    });
    const limitsPath = join(dir, "limits.json");
    const s = (iso: string) => at(iso) / 1000;
    saveLimitsCache(
      {
        providers: {
          [busy.identity]: capture("claude", s("2026-09-30T13:55:00Z"), {
            session: { pct: 30, resets: s("2026-09-30T16:00:00Z"), label: "5-HOUR" },
            weekly_all: { pct: 0.5, resets: s("2026-10-03T00:00:00Z"), label: "WEEKLY" },
            limit_0: { pct: 50, resets: s("2026-10-01T00:00:00Z"), label: "MYSTERY" },
          }),
          [idle.identity]: capture("claude", s("2026-09-30T13:00:00Z"), {
            session: { pct: 80, resets: s("2026-09-30T13:30:00Z"), label: "5-HOUR" },
            weekly_all: { pct: 40, resets: s("2026-10-03T00:00:00Z"), label: "WEEKLY" },
          }),
        },
        status: {},
      },
      limitsPath,
    );
    const limits = new Limits({
      limitsPath,
      roots: () => [busy, idle, fresh],
      db,
      spend: spendFromQueries(queries),
      now: () => NOW,
    });
    return { limits, busy, idle, fresh };
  }

  test("pace, a projected time, safe and — per window", () => {
    const { limits, busy } = setup();
    const got = limits.getLimits("busy");
    // Pace: 13:40, 13:50, 13:58 and 14:00 in [13:30, 14:00]: $2.00 in 30 min.
    expect(got?.pace).toEqual({ cost_per_h: 4, tokens_per_h: 160_000 });
    expect(got?.account).toEqual({
      id: busy.identity,
      label: "busy",
      provider: "claude",
      signed_in: true,
    });
    expect(got?.as_of).toBe(at("2026-09-30T13:55:00Z"));
    expect(got?.error).toBeNull();
    expect(
      got?.windows.map((w) => [w.kind, w.label, w.utilization, w.window_s, w.stale_s]),
    ).toEqual([
      ["limit_0", "MYSTERY", 0.5, null, 300],
      ["session", "5-HOUR", 0.3, 18_000, 300],
      ["weekly_all", "WEEKLY", 0.005, 604_800, 300],
    ]);
    const projections = Object.fromEntries(
      got?.windows.map((w) => [w.kind, w.projected_exhaustion_at]) ?? [],
    );
    // 5-hour: $2.00 to the capture at 30 %, 0.15 per dollar; $1.00 since (13:58, 14:00):
    // 45 % now. 0.55 / (0.15 * $4/h) = 55 min. Weekly: 0.0025 per dollar, 0.75 % now;
    // 0.9925 / 0.01 = 99.25 h, after the Oct 3 reset.
    expect(projections).toEqual({
      limit_0: null, // unknown window length
      session: at("2026-09-30T14:55:00Z"),
      weekly_all: "safe",
    });
    for (const w of got?.windows ?? []) expect(w.pace_cost_per_h).toBe(4);
  });

  test("a window past its reset reads 0 %; little spend and no pace give —", () => {
    const { limits } = setup();
    const idle = limits.getLimits("idle");
    expect(idle?.pace).toEqual({ cost_per_h: 0, tokens_per_h: 0 });
    expect(idle?.windows.map((w) => [w.kind, w.utilization, w.projected_exhaustion_at])).toEqual([
      ["session", 0, null], // reset at 13:30, before now
      ["weekly_all", 0.4, null], // $0.25 in the window, no pace
    ]);
    expect(idle?.windows[0]?.stale_s).toBe(3600);
  });

  test("an account with no capture and no usage yet is listed, empty", () => {
    const { limits } = setup();
    expect(limits.getLimits().map((a) => a.account.label)).toEqual(["busy", "idle", "fresh"]);
    expect(limits.getLimits("fresh")).toMatchObject({
      windows: [],
      as_of: null,
      source: null,
      pace: null,
    });
    expect(limits.getLimits("nobody")).toBeNull();
  });
});

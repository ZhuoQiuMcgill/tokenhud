// Pace and projected exhaustion, by hand. Rates from the bundled table: claude-opus-4-8
// output is $25 per 1M tokens, so a row of 20,000 output tokens costs exactly $0.50.
// T18: which pace each window projects from, the user's case, and the coarse times.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import {
  MIN_AVERAGE_MS,
  type ProjectionInput,
  projectAtReset,
  projectExhaustion,
  type Rate,
  roughly,
  spendFromQueries,
  WEEK_MS,
  windowPace,
} from "../../src/limits/derive.ts";
import { Limits } from "../../src/limits/index.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { UsageQueries } from "../../src/query/engine.ts";
import { Zone } from "../../src/query/tz.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { capture, cleanup, fakeRoot, tempDir } from "./helpers.ts";

guard();

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

  test("projectAtReset: where the window ends at this pace (the Overview's 'week ends ~N%')", () => {
    // Weekly from Sep 26 at 10 %: 0.05 per dollar, 12.5 % now; 34 h to the Oct 2 00:00
    // reset at $3/h is $102, so 12.5 % + 0.05 * 102 = 522.5 %.
    const weekly = {
      ...base,
      utilization: 0.1,
      resetsAt: at("2026-10-02T00:00:00Z"),
      windowMs: 7 * 24 * HOUR,
    };
    expect(projectAtReset(weekly)).toBeCloseTo(5.225, 12);
    // At 1 % (0.005 per dollar, 1.25 % now) and $0.30/h: 1.25 % + 0.005 * 10.2 = 6.35 %.
    expect(projectAtReset({ ...weekly, utilization: 0.01, costPerHour: 0.3 })).toBeCloseTo(
      0.0635,
      12,
    );
    // The same cases as projectExhaustion's "—".
    expect(projectAtReset({ ...weekly, costPerHour: 0 })).toBeNull();
    expect(projectAtReset({ ...weekly, windowMs: null })).toBeNull();
    expect(projectAtReset({ ...weekly, utilization: 1 })).toBeNull();
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
    // Each window's own pace (T18): the 5-hour window and the one of unknown length the last
    // 30 minutes; the weekly one its average since Sep 26 00:00, 110 h ago: the six rows,
    // $3.00 and 120,000 tokens, over 110 h.
    expect(got?.windows.map((w) => [w.kind, w.pace_basis])).toEqual([
      ["limit_0", "30m"],
      ["session", "30m"],
      ["weekly_all", "window_avg"],
    ]);
    expect(got?.windows.slice(0, 2).map((w) => [w.pace_cost_per_h, w.pace_tokens_per_h])).toEqual([
      [4, 160_000],
      [4, 160_000],
    ]);
    const weekly = got?.windows[2];
    expect(weekly?.pace_cost_per_h).toBeCloseTo(3 / 110, 12);
    expect(weekly?.pace_tokens_per_h).toBeCloseTo(120_000 / 110, 9);
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

// ── T18: which pace a window projects from ───────────────────────────────────────────

describe("windowPace: the pace each window projects from", () => {
  const recent: Rate = { costPerHour: 120, tokensPerHour: 4_000_000 };
  /** Says where the average started, to check it is the window's start. */
  const since: string[] = [];
  const rate = (from: number): Rate => {
    since.push(new Date(from).toISOString());
    return { costPerHour: 16, tokensPerHour: 500_000 };
  };
  const reset = at("2026-10-07T09:00:00Z");

  test("the 5-hour window, and one of unknown length: the last 30 minutes", () => {
    since.length = 0;
    expect(windowPace(5 * HOUR, NOW + HOUR, NOW, recent, rate)).toEqual({
      ...recent,
      basis: "30m",
    });
    expect(windowPace(null, NOW + HOUR, NOW, recent, rate).basis).toBe("30m");
    expect(since).toEqual([]);
  });

  test("a weekly window: its average since it began, from 6 hours in", () => {
    since.length = 0;
    const start = reset - WEEK_MS;
    expect(windowPace(WEEK_MS, reset, start + MIN_AVERAGE_MS, recent, rate)).toEqual({
      costPerHour: 16,
      tokensPerHour: 500_000,
      basis: "window_avg",
    });
    expect(windowPace(WEEK_MS, reset, reset - 1, recent, rate).basis).toBe("window_avg");
    expect(since).toEqual(["2026-09-30T09:00:00.000Z", "2026-09-30T09:00:00.000Z"]);
  });

  test("under 6 hours into the week: the last 30 minutes", () => {
    since.length = 0;
    const start = reset - WEEK_MS;
    expect(windowPace(WEEK_MS, reset, start + MIN_AVERAGE_MS - 1, recent, rate)).toEqual({
      ...recent,
      basis: "30m",
    });
    expect(windowPace(WEEK_MS, reset, start, recent, rate).basis).toBe("30m");
    expect(since).toEqual([]);
  });

  test("a capture from before the reset: the instance running now", () => {
    since.length = 0;
    // Two days into the next week: its average, from the reset on.
    expect(windowPace(WEEK_MS, reset, reset + 48 * HOUR, recent, rate).basis).toBe("window_avg");
    // Three hours in: too early to average.
    expect(windowPace(WEEK_MS, reset, reset + 3 * HOUR, recent, rate).basis).toBe("30m");
    expect(since).toEqual(["2026-10-07T09:00:00.000Z"]);
  });
});

/**
 * The user's report (2026-10-02), synthetic and rounded. A weekly window that began Wed
 * 05:00 in Toronto (09:00Z) is 54 hours old on Fri at 11:00 (15:00Z). $820 was spent in it
 * on Wednesday, then nothing until a burst of $60 in the last 30 minutes (two agents at
 * once). The capture a minute ago says 48 %: 0.48 / $880 per dollar, about $18 per 1 %.
 */
describe("the user's case: a 30-minute burst no longer runs out a weekly limit tonight", () => {
  const start = at("2026-09-30T09:00:00Z");
  const reset = start + WEEK_MS;
  const now = at("2026-10-02T15:00:00Z");
  const spends: [number, number][] = [
    [at("2026-09-30T20:00:00Z"), 820],
    [now - 25 * MIN, 20],
    [now - 15 * MIN, 20],
    [now - 5 * MIN, 20],
  ];
  const spent = (from: number, to: number) =>
    spends.filter(([t]) => t >= from && t < to).reduce((sum, [, usd]) => sum + usd, 0);
  /** The pace over the last 30 minutes, and per hour from `from` to now, as T6 computes them. */
  const recent: Rate = { costPerHour: spent(now - 30 * MIN, now + 1) * 2, tokensPerHour: 0 };
  const rate = (from: number): Rate => ({
    costPerHour: spent(from, now + 1) / ((now - from) / HOUR),
    tokensPerHour: 0,
  });
  const weekly: ProjectionInput = {
    utilization: 0.48,
    capturedAt: now - MIN,
    resetsAt: reset,
    windowMs: WEEK_MS,
    costPerHour: 0,
    now,
    spent,
  };
  const toronto = Zone.of("America/Toronto");
  const local = (t: number) => roughly(t, now, (x) => toronto.offset(x));

  test("the weekly window projects from the week's average: ~Sun evening, not tonight", () => {
    const pace = windowPace(WEEK_MS, reset, now, recent, rate);
    // $880 over the 54 hours since the window began: $16.30 an hour.
    expect(pace.basis).toBe("window_avg");
    expect(pace.costPerHour).toBeCloseTo(880 / 54, 12);
    // 52 % left at 0.48 / 54 h of the window per hour: 0.52 * 54 / 0.48 = 58.5 h, so Sun
    // Oct 4 at 21:30 in Toronto, before Wednesday's reset.
    const hits = projectExhaustion({ ...weekly, costPerHour: pace.costPerHour });
    expect(hits).toBe(now + 58.5 * HOUR);
    expect(hits).toBe(at("2026-10-05T01:30:00Z"));
    expect(local(hits as number)).toBe("~Sun evening");
    // Before T18 the burst's $120 an hour was carried over the rest of the week:
    // 0.52 / (0.48 / 880 * 120) = 7 h 56 min 40 s, at 18:56 tonight.
    const before = projectExhaustion({ ...weekly, costPerHour: recent.costPerHour });
    expect(before).toBe(at("2026-10-02T22:56:40Z"));
    expect(local(before as number)).toBe("~this evening");
  });

  test("the 5-hour window, with the same burst, still projects from the last 30 minutes", () => {
    // Its window opened at 12:00 (16:00Z reset - 5 h); only the burst falls in it: 30 % on
    // $60 is 0.005 per dollar, and 0.7 / (0.005 * $120/h) = 70 min.
    const resetsAt = now + 2 * HOUR;
    const pace = windowPace(5 * HOUR, resetsAt, now, recent, rate);
    expect(pace).toEqual({ costPerHour: 120, tokensPerHour: 0, basis: "30m" });
    const hits = projectExhaustion({
      ...weekly,
      utilization: 0.3,
      resetsAt,
      windowMs: 5 * HOUR,
      costPerHour: pace.costPerHour,
    });
    expect(hits).toBe(now + 70 * MIN);
  });

  test("a weekly window under 6 hours old falls back to the last 30 minutes", () => {
    // The week began at 10:00 (14:00Z), 5 hours ago, and only the burst is in it.
    const young = now - 5 * HOUR + WEEK_MS;
    const pace = windowPace(WEEK_MS, young, now, recent, rate);
    expect(pace).toEqual({ costPerHour: 120, tokensPerHour: 0, basis: "30m" });
    // 3 % on $60: 0.0005 per dollar; 0.97 / (0.0005 * 120) = 16 h 10 min.
    const hits = projectExhaustion({
      ...weekly,
      utilization: 0.03,
      resetsAt: young,
      costPerHour: pace.costPerHour,
    });
    expect(hits).toBe(now + (16 * 60 + 10) * MIN);
  });

  test("end to end over a store: Limits reports the basis, the average and the instant", () => {
    const dir = tempDir();
    const root = fakeRoot("claude", "burst-like", "/home/x/.claude", { source: "auto" });
    let key = 1n;
    const row = (ts: number, usd: number): UsageRow => ({
      key: key++,
      provider: "claude",
      identity: root.identity,
      label: "burst-like",
      ts,
      model: "claude-opus-4-8",
      inp: 0,
      // $25 per 1M output tokens.
      outp: usd * 40_000,
      cr: 0,
      cc: 0,
      e5: null,
      e1: null,
      tier: 0,
    });
    const store = openStore(join(dir, "tokenhud.db"));
    store.upsert(spends.map(([t, usd]) => row(t, usd)));
    store.close();
    const db = openStoreReader(join(dir, "tokenhud.db")) as Database;
    open.push(db);
    const queries = new UsageQueries(db, new PriceTable(bundledPricing().models), {
      tz: "UTC",
      now: () => now,
    });
    const limitsPath = join(dir, "limits.json");
    saveLimitsCache(
      {
        providers: {
          [root.identity]: capture("claude", (now - MIN) / 1000, {
            session: { pct: 30, resets: (now + 2 * HOUR) / 1000, label: "5-HOUR" },
            weekly_all: { pct: 48, resets: reset / 1000, label: "WEEKLY" },
          }),
        },
        status: {},
      },
      limitsPath,
    );
    const limits = new Limits({
      limitsPath,
      roots: () => [root],
      db,
      spend: spendFromQueries(queries),
      now: () => now,
    });
    const got = limits.getLimits("burst-like");
    // The account's pace stays the last 30 minutes'.
    expect(got?.pace?.cost_per_h).toBe(120);
    const [session, week] = got?.windows ?? [];
    expect([session?.pace_cost_per_h, session?.pace_basis]).toEqual([120, "30m"]);
    expect(session?.projected_exhaustion_at).toBe(now + 70 * MIN);
    expect(week?.pace_basis).toBe("window_avg");
    expect(week?.pace_cost_per_h).toBeCloseTo(880 / 54, 12);
    expect(week?.pace_tokens_per_h).toBeCloseTo((880 * 40_000) / 54, 6);
    expect(week?.projected_exhaustion_at).toBe(at("2026-10-05T01:30:00Z"));
  });
});

describe("roughly: a weekly window's time, to a part of a day", () => {
  const toronto = Zone.of("America/Toronto");
  /** Toronto wall-clock time on a day of Sep 27 – Oct 9 2026 (EDT, UTC-4). */
  const t = (day: number, hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    return Date.UTC(2026, day > 26 ? 8 : 9, day, h + 4, m);
  };
  const say = (when: number, now: number) => roughly(when, now, (x) => toronto.offset(x));
  /** Friday Oct 2, 11:00. */
  const FRI = t(2, "11:00");

  test("within 24 hours: this morning, afternoon or evening, tonight, tomorrow …", () => {
    expect(say(t(2, "11:00"), FRI)).toBe("~this morning");
    expect(say(t(2, "11:59"), FRI)).toBe("~this morning");
    expect(say(t(2, "12:00"), FRI)).toBe("~this afternoon");
    expect(say(t(2, "17:59"), FRI)).toBe("~this afternoon");
    expect(say(t(2, "18:00"), FRI)).toBe("~this evening");
    expect(say(t(2, "21:59"), FRI)).toBe("~this evening");
    expect(say(t(2, "22:00"), FRI)).toBe("~tonight");
    // The small hours are still Friday night.
    expect(say(t(3, "05:59"), FRI)).toBe("~tonight");
    expect(say(t(3, "06:00"), FRI)).toBe("~tomorrow morning");
    expect(say(FRI + 24 * HOUR - 1, FRI)).toBe("~tomorrow morning");
  });

  test("24 hours or more ahead: the weekday", () => {
    expect(say(FRI + 24 * HOUR, FRI)).toBe("~Sat morning");
    expect(say(t(3, "12:00"), FRI)).toBe("~Sat afternoon");
    expect(say(t(4, "21:30"), FRI)).toBe("~Sun evening");
    expect(say(t(4, "22:00"), FRI)).toBe("~Sun night");
    // 02:00 on Monday is Sunday night; 06:00 is Monday morning.
    expect(say(t(5, "02:00"), FRI)).toBe("~Sun night");
    expect(say(t(5, "06:00"), FRI)).toBe("~Mon morning");
    // A week on, the same weekday is next week's.
    expect(say(t(7, "09:00"), t(30, "10:00"))).toBe("~next Wed morning");
    expect(say(t(6, "23:00"), t(30, "10:00"))).toBe("~Tue night");
  });

  test("in the small hours, tonight is the night already running", () => {
    const early = t(2, "01:00");
    expect(say(t(2, "03:00"), early)).toBe("~tonight");
    expect(say(t(2, "09:00"), early)).toBe("~tomorrow morning");
    expect(say(t(2, "23:00"), early)).toBe("~tomorrow night");
    // Over 24 hours ahead, still Friday night: named by its day.
    expect(say(t(3, "05:00"), early)).toBe("~Fri night");
  });

  test("the zone's own clock decides, across a DST change", () => {
    // Toronto falls back on Sun Nov 1 2026 at 02:00 EDT. 05:59 EST is 10:59Z, 06:00 EST 11:00Z.
    const sat = Date.UTC(2026, 9, 31, 16); // Sat Oct 31, 12:00 EDT
    expect(say(Date.UTC(2026, 10, 1, 10, 59), sat)).toBe("~tonight");
    expect(say(Date.UTC(2026, 10, 1, 11), sat)).toBe("~tomorrow morning");
    // The same instants in UTC are Sunday morning already.
    expect(roughly(Date.UTC(2026, 10, 1, 10, 59), sat, () => 0)).toBe("~tomorrow morning");
  });
});

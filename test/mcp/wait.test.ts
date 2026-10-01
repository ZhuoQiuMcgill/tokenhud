import { describe, expect, test } from "bun:test";
import type { AccountLimits, LimitWindow } from "../../src/limits/index.ts";
import { realClock } from "../../src/mcp/server.ts";
import { type WaitArgs, type WaitDeps, waitForReset } from "../../src/mcp/wait.ts";
import { Zone } from "../../src/query/tz.ts";
import { FakeClock, HOUR, MIN, NOW } from "./helpers.ts";

const DAY = 24 * HOUR;

function win(kind: string, label: string, utilization: number, resetsAt: number): LimitWindow {
  return {
    kind,
    label,
    utilization,
    resets_at: resetsAt,
    window_s: kind === "session" ? 18_000 : 604_800,
    pace_cost_per_h: 0,
    projected_exhaustion_at: "safe",
    stale_s: 0,
  };
}

function account(windows: LimitWindow[], signedIn = true): AccountLimits {
  return {
    account: { id: "0".repeat(32), label: "personal", provider: "claude", signed_in: signedIn },
    windows,
    as_of: NOW,
    source: "api",
    error: null,
    pace: null,
  };
}

interface Harness {
  clock: FakeClock;
  abort: AbortController;
  /** What check() returns; tests swap it as time goes on. */
  limits: AccountLimits;
  checks: Array<{ at: number; refresh: boolean }>;
  progress: Array<{ at: number; progress: number; total: number; message: string }>;
  deps: WaitDeps;
}

function harness(limits: AccountLimits, withProgress = true): Harness {
  const clock = new FakeClock(NOW);
  const abort = new AbortController();
  const h: Harness = {
    clock,
    abort,
    limits,
    checks: [],
    progress: [],
    deps: undefined as unknown as WaitDeps,
  };
  h.deps = {
    clock,
    zone: Zone.of("UTC"),
    signal: abort.signal,
    check: async (refresh) => {
      h.checks.push({ at: clock.t - NOW, refresh });
      return h.limits;
    },
    progress: withProgress
      ? async (progress, total, message) => {
          h.progress.push({ at: clock.t - NOW, progress, total, message });
        }
      : null,
  };
  return h;
}

const run = (h: Harness, args: WaitArgs) => waitForReset(args, h.deps);
const S = 1000;

describe("wait_for_reset", () => {
  test("waits out a full window: progress at least every 60 s, re-checks every 5 minutes", async () => {
    const h = harness(
      account([
        win("session", "5-HOUR", 1, NOW + 38 * MIN),
        win("weekly_all", "WEEKLY", 0.4, NOW + 3 * DAY),
      ]),
    );
    // After the reset the provider reports the next window.
    h.clock.onSleep = (t) => {
      if (t >= NOW + 38 * MIN) {
        h.limits = account([win("session", "5-HOUR", 0.02, NOW + 38 * MIN + 5 * HOUR)]);
      }
    };
    const result = await run(h, { max_wait_s: 18_000 });
    expect(result).toEqual({
      waited_s: 38 * 60 + 30,
      reset: true,
      utilization_now: 0.02,
      aborted: false,
      window: "5-HOUR",
      reason: "5-HOUR reset at 15:38; now at 2%",
    });

    // The window plus 30 s, in slices of 30 s: one progress notification after each.
    const total = 38 * 60 + 30;
    expect(h.clock.sleeps.every((ms) => ms <= 30 * S)).toBe(true);
    expect(h.clock.sleeps.reduce((a, b) => a + b, 0)).toBe(total * S);
    expect(h.progress).toHaveLength(77);
    const times = [0, ...h.progress.map((p) => p.at)];
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number)).toBeLessThanOrEqual(60 * S);
    }
    expect(h.progress.every((p) => p.total === total)).toBe(true);
    expect(h.progress.map((p) => p.progress)).toEqual(
      Array.from({ length: 77 }, (_, i) => (i + 1) * 30),
    );
    expect(h.progress[0]?.message).toBe("waited 30s of 39m; 5-HOUR 100%, resets 15:38");
    expect(h.progress[76]?.message).toBe("waited 39m of 39m; 5-HOUR 100%, resets 15:38");

    // A refreshed check at the start, every 5 minutes, and once the reset has passed.
    expect(h.checks).toEqual([
      { at: 0, refresh: true },
      ...[5, 10, 15, 20, 25, 30, 35].map((m) => ({ at: m * MIN, refresh: true })),
      { at: total * S, refresh: true },
    ]);
  });

  test("returns early when a re-check shows the window already reset", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * HOUR)]));
    h.clock.onSleep = (t) => {
      if (t >= NOW + 4 * MIN) {
        h.limits = account([win("session", "5-HOUR", 0.05, NOW + 5 * HOUR)]);
      }
    };
    expect(await run(h, { max_wait_s: 18_000 })).toEqual({
      waited_s: 300,
      reset: true,
      utilization_now: 0.05,
      aborted: false,
      window: "5-HOUR",
      reason: "5-HOUR has reset; now at 5%",
    });
  });

  test("a reset time that only jitters is the same window, not a reset", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 20 * MIN)]));
    h.clock.onSleep = () => {
      h.limits = account([win("session", "5-HOUR", 1, NOW + 20 * MIN + 400)]);
    };
    const result = await run(h, { max_wait_s: 18_000 });
    // It ran to the original reset plus 30 s.
    expect(result.waited_s).toBe(20 * 60 + 30);
    expect(result.reset).toBe(true);
  });

  test("returns early when utilization drops under until_utilization_below", async () => {
    const h = harness(account([win("weekly_all", "WEEKLY", 0.95, NOW + 3 * DAY)]));
    h.clock.onSleep = (t) => {
      if (t >= NOW + 5 * MIN)
        h.limits = account([win("weekly_all", "WEEKLY", 0.88, NOW + 3 * DAY)]);
    };
    expect(
      await run(h, { window: "weekly", max_wait_s: 18_000, until_utilization_below: 0.9 }),
    ).toEqual({
      waited_s: 300,
      reset: false,
      utilization_now: 0.88,
      aborted: false,
      window: "WEEKLY",
      reason: "WEEKLY dropped to 88%, under 90%",
    });
  });

  test("already under the threshold: returns at once", async () => {
    const h = harness(account([win("session", "5-HOUR", 0.3, NOW + HOUR)]));
    expect(await run(h, { max_wait_s: 600, until_utilization_below: 0.5 })).toEqual({
      waited_s: 0,
      reset: false,
      utilization_now: 0.3,
      aborted: false,
      window: "5-HOUR",
      reason: "5-HOUR is at 30%, already under 50%",
    });
    expect(h.clock.sleeps).toEqual([]);
  });

  test("cancellation ends the wait at once: no more progress, no more checks", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * HOUR)]));
    h.clock.onSleep = (t) => {
      // During the third slice.
      if (t >= NOW + 90 * S) h.abort.abort();
    };
    expect(await run(h, { max_wait_s: 18_000 })).toEqual({
      waited_s: 90,
      reset: false,
      utilization_now: 1,
      aborted: true,
      window: "5-HOUR",
      reason: "cancelled",
    });
    expect(h.progress.map((p) => p.at)).toEqual([30 * S, 60 * S]);
    expect(h.checks).toEqual([{ at: 0, refresh: true }]);
    expect(h.clock.sleeps).toHaveLength(3);
  });

  test("a cancelled real sleep returns promptly", async () => {
    const abort = new AbortController();
    const t0 = performance.now();
    setTimeout(() => abort.abort(), 20);
    await realClock.sleep(60_000, abort.signal);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  test("never waits past max_wait_s", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * HOUR)]));
    expect(await run(h, { max_wait_s: 600 })).toEqual({
      waited_s: 600,
      reset: false,
      utilization_now: 1,
      aborted: false,
      window: "5-HOUR",
      reason: "stopped after max_wait_s (10m); 5-HOUR is at 100% and resets at 17:00 (in 1h 50m)",
    });
    expect(h.clock.sleeps.reduce((a, b) => a + b, 0)).toBe(600 * S);
    expect(h.progress.every((p) => p.total === 600)).toBe(true);
    expect(h.progress.at(-1)?.progress).toBe(600);
  });

  test("a re-check that hangs can't push the wait past max_wait_s", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * HOUR)]));
    const original = h.deps.check;
    h.deps.check = (refresh) =>
      refresh && h.clock.t > NOW ? new Promise<AccountLimits>(() => {}) : original(refresh);
    const result = await run(h, { max_wait_s: 400 });
    expect(result).toMatchObject({ waited_s: 400, reset: false, aborted: false });
    expect(h.clock.t - NOW).toBe(400 * S);
  });

  test("without a progress token it still waits in slices, silently", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * MIN)]), false);
    const result = await run(h, { max_wait_s: 18_000 });
    expect(result.waited_s).toBe(150);
    expect(result.reset).toBe(true);
    expect(h.clock.sleeps).toEqual([30 * S, 30 * S, 30 * S, 30 * S, 30 * S]);
  });

  test("not signed in on this machine: returns at once", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + HOUR)], false));
    expect(await run(h, { max_wait_s: 600 })).toEqual({
      waited_s: 0,
      reset: false,
      utilization_now: null,
      aborted: false,
      reason: "limits unavailable: not signed in on this machine",
    });
    expect(h.clock.sleeps).toEqual([]);
  });

  test("the default window is the one should_wait binds on, else the fullest", async () => {
    const full = harness(
      account([
        win("session", "5-HOUR", 0.95, NOW + MIN),
        win("weekly_all", "WEEKLY", 0.97, NOW + 2 * MIN),
      ]),
    );
    expect((await run(full, { max_wait_s: 18_000 })).window).toBe("WEEKLY");
    const none = harness(
      account([
        win("session", "5-HOUR", 0.2, NOW + MIN),
        win("weekly_all", "WEEKLY", 0.5, NOW + 2 * MIN),
      ]),
    );
    expect((await run(none, { max_wait_s: 18_000 })).window).toBe("WEEKLY");
  });
  test("targets the window should_wait binds on for the model: not another model's", async () => {
    const windows = () =>
      account([
        win("session", "5-HOUR", 0.95, NOW + 40 * MIN),
        win("weekly_scoped", "FABLE WEEKLY", 1, NOW + 4 * DAY),
      ]);
    const other = harness(windows());
    const any = await run(other, { max_wait_s: 18_000 });
    expect(any).toMatchObject({ window: "5-HOUR", waited_s: 40 * 60 + 30, reset: true });
    const opus = harness(windows());
    expect((await run(opus, { max_wait_s: 18_000, model: "claude-opus-4-8" })).window).toBe(
      "5-HOUR",
    );
    const own = harness(windows());
    const fable = await run(own, { max_wait_s: 600, model: "claude-fable-5" });
    expect(fable).toMatchObject({ window: "FABLE WEEKLY", waited_s: 600, reset: false });
  });

  test("progress keeps coming while a re-check is slow", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * HOUR)]));
    const original = h.deps.check;
    // Each refreshed re-check takes 45 s of the clock.
    h.deps.check = (refresh) => {
      if (!refresh || h.clock.t === NOW) return original(refresh);
      const until = h.clock.t + 45_000;
      return new Promise<AccountLimits>((resolve) => {
        const previous = h.clock.onSleep;
        h.clock.onSleep = (t) => {
          previous?.(t);
          if (t >= until) {
            h.clock.onSleep = previous;
            resolve(h.limits);
          }
        };
      });
    };
    await run(h, { max_wait_s: 1_200 });
    const times = [0, ...h.progress.map((p) => p.at)];
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30 * S);
    // Progress values only ever grow.
    const values = h.progress.map((p) => p.progress);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });

  test("the first check honours the deadline: a hung one can't stretch max_wait_s", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * HOUR)]));
    const original = h.deps.check;
    h.deps.check = (refresh) =>
      refresh ? new Promise<AccountLimits>(() => {}) : original(refresh);
    const result = await run(h, { max_wait_s: 40 });
    expect(result).toMatchObject({ waited_s: 40, reset: false, aborted: false, window: "5-HOUR" });
    expect(h.clock.t - NOW).toBe(40 * S);
    expect(h.progress.map((p) => p.message)).toEqual(["waited 30s of 40s; checking the limits"]);
  });

  test("the first check honours cancellation", async () => {
    const h = harness(account([win("session", "5-HOUR", 1, NOW + 2 * HOUR)]));
    h.deps.check = () => new Promise<AccountLimits>(() => {});
    h.clock.onSleep = (t) => {
      if (t >= NOW + 30 * S) h.abort.abort();
    };
    expect(await run(h, { max_wait_s: 18_000 })).toEqual({
      waited_s: 30,
      reset: false,
      utilization_now: null,
      aborted: true,
      reason: "cancelled",
    });
  });
});

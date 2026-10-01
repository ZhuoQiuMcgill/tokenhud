import { describe, expect, test } from "bun:test";
import type { AccountLimits, LimitWindow } from "../../src/limits/index.ts";
import { clock, duration, limitsView, type Spent, shouldWait } from "../../src/mcp/decide.ts";
import { ToolError } from "../../src/mcp/errors.ts";
import { Zone } from "../../src/query/tz.ts";
import type { Root } from "../../src/sources/roots.ts";
import { HOUR, MIN, NOW } from "./helpers.ts";

const UTC = Zone.of("UTC");
const DAY = 24 * HOUR;
const noSpend: Spent = () => null;

function win(kind: string, label: string, over: Partial<LimitWindow>): LimitWindow {
  return {
    kind,
    label,
    utilization: 0,
    resets_at: NOW + HOUR,
    window_s: kind === "session" ? 5 * 3600 : 7 * 86400,
    pace_cost_per_h: 3.5,
    projected_exhaustion_at: "safe",
    stale_s: 30,
    ...over,
  };
}

const session = (over: Partial<LimitWindow>) => win("session", "5-HOUR", over);
const weekly = (over: Partial<LimitWindow>) => win("weekly_all", "WEEKLY", over);

function account(windows: LimitWindow[], over: Partial<AccountLimits> = {}): AccountLimits {
  return {
    account: { id: "0".repeat(32), label: "personal", provider: "claude", signed_in: true },
    windows,
    as_of: NOW - 30_000,
    source: "api",
    error: null,
    pace: { cost_per_h: 3.5, tokens_per_h: 1000 },
    ...over,
  };
}

describe("should_wait", () => {
  test("a window at 90% or more: wait until its reset plus 30 s", () => {
    const limits = account([
      session({ utilization: 0.95, resets_at: NOW + 38 * MIN }),
      weekly({ utilization: 0.4, resets_at: NOW + 3 * DAY }),
    ]);
    expect(shouldWait(limits, {}, NOW, UTC, noSpend)).toEqual({
      wait: true,
      reason: "5-HOUR is at 95%, at or over 90%; it resets at 15:38 (in 38m)",
      window: "5-HOUR",
      utilization: 0.95,
      resets_at: "2026-10-01T15:38:00.000Z",
      wait_s: 38 * 60 + 30,
    });
  });

  test("exactly at the line waits; just under doesn't", () => {
    const at = (u: number) =>
      shouldWait(account([session({ utilization: u })]), {}, NOW, UTC, noSpend).wait;
    expect(at(0.9)).toBe(true);
    expect(at(0.8999)).toBe(false);
  });

  test("several windows over the line: the one that resets last binds", () => {
    const limits = account([
      session({ utilization: 0.95, resets_at: NOW + 38 * MIN }),
      weekly({ utilization: 0.92, resets_at: NOW + 3 * DAY }),
    ]);
    const verdict = shouldWait(limits, {}, NOW, UTC, noSpend);
    expect(verdict).toMatchObject({
      wait: true,
      window: "WEEKLY",
      utilization: 0.92,
      resets_at: "2026-10-04T15:00:00.000Z",
      wait_s: 3 * 86400 + 30,
    });
    expect(verdict.reason).toBe(
      "WEEKLY is at 92%, at or over 90%; it resets at Oct 4 15:00 (in 3d)",
    );
  });

  test("min_headroom moves the line", () => {
    const limits = account([session({ utilization: 0.95, resets_at: NOW + 38 * MIN })]);
    expect(shouldWait(limits, { min_headroom: 0.01 }, NOW, UTC, noSpend)).toEqual({
      wait: false,
      reason: "headroom ok: 5-HOUR is at 95% and resets at 15:38 (in 38m)",
      window: "5-HOUR",
      utilization: 0.95,
      resets_at: "2026-10-01T15:38:00.000Z",
      wait_s: 0,
    });
    expect(
      shouldWait(account([session({ utilization: 0.5 })]), { min_headroom: 0.5 }, NOW, UTC, noSpend)
        .wait,
    ).toBe(true);
  });

  test("projected to run out within 10 minutes, before the reset: wait", () => {
    const soon = account([
      session({
        utilization: 0.7,
        projected_exhaustion_at: NOW + 8 * MIN,
        resets_at: NOW + 38 * MIN,
      }),
    ]);
    expect(shouldWait(soon, {}, NOW, UTC, noSpend)).toEqual({
      wait: true,
      reason:
        "5-HOUR is at 70% and is projected (an estimate) to run out at 15:08; it resets at 15:38 (in 38m)",
      window: "5-HOUR",
      utilization: 0.7,
      resets_at: "2026-10-01T15:38:00.000Z",
      wait_s: 38 * 60 + 30,
    });
    const later = (p: LimitWindow["projected_exhaustion_at"]) =>
      shouldWait(
        account([
          session({ utilization: 0.7, projected_exhaustion_at: p, resets_at: NOW + 38 * MIN }),
        ]),
        {},
        NOW,
        UTC,
        noSpend,
      ).wait;
    expect(later(NOW + 10 * MIN - 1)).toBe(true);
    expect(later(NOW + 10 * MIN)).toBe(false);
    expect(later("safe")).toBe(false);
    expect(later(null)).toBe(false);
  });

  describe("estimated_cost", () => {
    // 5-HOUR at 50%, resetting at 17:00, so it opened at 12:00. Captured at 14:59, after
    // $10 of spend in the window: 5 points per dollar. $2 more since the capture.
    const limits = account(
      [
        session({ utilization: 0.5, resets_at: NOW + 2 * HOUR }),
        weekly({ utilization: 0.3, resets_at: NOW + 3 * DAY }),
      ],
      { as_of: NOW - MIN },
    );
    const spent: Spent = (from, to) => {
      if (from === NOW - 3 * HOUR && to === NOW - MIN) return 10;
      if (from === NOW - MIN && to === NOW + 1) return 2;
      // The weekly window's spend before the capture: too little to scale.
      if (from === NOW + 3 * DAY - 7 * DAY && to === NOW - MIN) return 0.4;
      throw new Error(`unexpected range ${from}..${to}`);
    };

    test("work that would take a window over the line: wait", () => {
      // 0.5 + 0.05 * (2 + 6) = 0.90.
      expect(shouldWait(limits, { estimated_cost: 6 }, NOW, UTC, spent)).toEqual({
        wait: true,
        reason:
          "an estimated $6.00 would take 5-HOUR from 50% to about 90%, over 90%; it resets at 17:00 (in 2h)",
        window: "5-HOUR",
        utilization: 0.5,
        resets_at: "2026-10-01T17:00:00.000Z",
        wait_s: 2 * 3600 + 30,
      });
    });

    test("work that fits: no wait, and the reason says where it lands", () => {
      // 0.5 + 0.05 * (2 + 4) = 0.80.
      expect(shouldWait(limits, { estimated_cost: 4 }, NOW, UTC, spent).reason).toBe(
        "headroom ok: 5-HOUR is at 50% and resets at 17:00 (in 2h); an estimated $4.00 takes 5-HOUR to about 80%; estimated_cost not checked for windows with too little spend to scale it",
      );
    });

    test("without spend data the cost can't be scaled, and the reason says so", () => {
      const verdict = shouldWait(limits, { estimated_cost: 100 }, NOW, UTC, noSpend);
      expect(verdict.wait).toBe(false);
      expect(verdict.reason).toEndWith(
        "; estimated_cost not checked for windows with too little spend to scale it",
      );
    });
  });

  test("window: only the named one counts, by label or kind, in any case", () => {
    const limits = account([
      session({ utilization: 0.95, resets_at: NOW + 38 * MIN }),
      weekly({ utilization: 0.4, resets_at: NOW + 3 * DAY }),
    ]);
    for (const name of ["weekly", "WEEKLY", "weekly_all"]) {
      expect(shouldWait(limits, { window: name }, NOW, UTC, noSpend)).toMatchObject({
        wait: false,
        window: "WEEKLY",
        utilization: 0.4,
      });
    }
    expect(shouldWait(limits, { window: "session" }, NOW, UTC, noSpend).wait).toBe(true);
  });

  test("an unknown window is a bad argument naming the account's windows", () => {
    const limits = account([session({}), weekly({})]);
    let error: unknown;
    try {
      shouldWait(limits, { window: "daily" }, NOW, UTC, noSpend);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toBe(
      "no window 'daily' on this account (windows: 5-HOUR (session), WEEKLY (weekly_all))",
    );
  });

  test("not signed in on this machine: never wait", () => {
    const limits = account([session({ utilization: 1 })], {
      account: { id: "0".repeat(32), label: "away", provider: "claude", signed_in: false },
    });
    expect(shouldWait(limits, {}, NOW, UTC, noSpend)).toEqual({
      wait: false,
      reason: "limits unavailable: not signed in on this machine",
      utilization: null,
      wait_s: 0,
    });
  });

  test("no limits captured: never wait, and say why", () => {
    expect(shouldWait(account([], { as_of: null }), {}, NOW, UTC, noSpend)).toEqual({
      wait: false,
      reason: "limits unavailable: no limits captured yet",
      utilization: null,
      wait_s: 0,
    });
    expect(
      shouldWait(account([], { as_of: null, error: "HTTP 503" }), {}, NOW, UTC, noSpend).reason,
    ).toBe("limits unavailable: HTTP 503");
  });

  test("old limits data is called out", () => {
    const limits = account([session({ utilization: 0.95, resets_at: NOW + 38 * MIN })], {
      as_of: NOW - 25 * MIN,
    });
    expect(shouldWait(limits, {}, NOW, UTC, noSpend).reason).toEndWith(" (limits data 25m old)");
  });

  test("a window past its reset reads 0% (T8) and says it has reset", () => {
    const limits = account([session({ utilization: 0, resets_at: NOW - 5 * MIN })]);
    expect(shouldWait(limits, {}, NOW, UTC, noSpend)).toMatchObject({
      wait: false,
      reason: "headroom ok: 5-HOUR is at 0% and has reset (at 14:55)",
    });
  });
});

describe("limitsView", () => {
  test("T8's account as the limits tool returns it: ISO times in the zone, rounded numbers", () => {
    const root = { path: "/home/u/.claude" } as Root;
    const limits = account([
      session({
        utilization: 0.23000000001,
        resets_at: NOW + 38 * MIN,
        pace_cost_per_h: 36.0234,
        projected_exhaustion_at: NOW + 2 * HOUR,
        stale_s: 30,
      }),
      weekly({ utilization: 0.12, resets_at: NOW + 3 * DAY, projected_exhaustion_at: "safe" }),
    ]);
    const toronto = Zone.of("America/Toronto");
    expect(limitsView({ root, detectedVia: "env" }, limits, toronto)).toEqual({
      account: {
        label: "personal",
        provider: "claude",
        config_dir: "/home/u/.claude",
        signed_in: true,
        detected_via: "env",
      },
      windows: [
        {
          kind: "session",
          label: "5-HOUR",
          utilization: 0.23,
          resets_at: "2026-10-01T11:38:00.000-04:00",
          pace_cost_per_h: 36.02,
          projected_exhaustion_at: "2026-10-01T13:00:00.000-04:00",
          stale_s: 30,
        },
        {
          kind: "weekly_all",
          label: "WEEKLY",
          utilization: 0.12,
          resets_at: "2026-10-04T11:00:00.000-04:00",
          pace_cost_per_h: 3.5,
          projected_exhaustion_at: "safe",
          stale_s: 30,
        },
      ],
      as_of: "2026-10-01T10:59:30.000-04:00",
      error: null,
    });
  });
});

describe("text", () => {
  test("durations", () => {
    expect(
      [45_000, 38 * MIN, 2 * HOUR, 2 * HOUR + 10 * MIN, 3 * DAY, 3 * DAY + 4 * HOUR].map(duration),
    ).toEqual(["45s", "38m", "2h", "2h 10m", "3d", "3d 4h"]);
  });

  test("clock times carry the date when not today", () => {
    expect(clock(NOW + 38 * MIN, NOW, UTC)).toBe("15:38");
    expect(clock(NOW + 3 * DAY, NOW, UTC)).toBe("Oct 4 15:00");
  });
});

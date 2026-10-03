// Which windows an alert watches, when it fires, and what it says (T29), as pure functions.
import { describe, expect, test } from "bun:test";
import {
  alertMessage,
  alertStatus,
  captureWindows,
  compact,
  currentMembers,
  lastFired,
  type WindowState,
  watched,
  watches,
} from "../../src/alerts/match.ts";
import type { Alert } from "../../src/alerts/store.ts";
import { guard } from "../guard.ts";
import { capture, HOUR, MIN, NOW, SESSION } from "../mcp/helpers.ts";

guard();

const ID = "0123456789abcdef0123456789abcdef";

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: "a1b2c3d4",
    created_at: NOW - HOUR,
    session: SESSION,
    account: { id: ID, label: "personal", provider: "claude", group: null, members: [ID] },
    window: "5h",
    at: 80,
    note: null,
    delivered: [],
    ...over,
  };
}

const win = (over: Partial<WindowState>): WindowState => ({
  kind: "session",
  label: "5-HOUR",
  utilization: 0.5,
  resets_at: NOW + HOUR,
  window_s: 5 * 3600,
  ...over,
});

const FIVE = win({});
const WEEK = win({ kind: "weekly_all", label: "WEEKLY", window_s: 7 * 86_400, utilization: 0.4 });
const FABLE = win({
  kind: "weekly_scoped",
  label: "FABLE WEEKLY",
  window_s: 7 * 86_400,
  utilization: 0.1,
});

describe("which windows an alert watches", () => {
  test("Claude: 5h, weekly, weekly_scoped (each model's), any", () => {
    const opus = { ...FABLE, kind: "weekly_scoped_3", label: "OPUS 4.8 WEEKLY" };
    const all = [FIVE, WEEK, FABLE, opus];
    const kinds = (w: Alert["window"]) =>
      all.filter((x) => watches(w, "claude", x)).map((x) => x.kind);
    expect(kinds("5h")).toEqual(["session"]);
    expect(kinds("weekly")).toEqual(["weekly_all"]);
    expect(kinds("weekly_scoped")).toEqual(["weekly_scoped", "weekly_scoped_3"]);
    expect(kinds("any")).toEqual(["session", "weekly_all", "weekly_scoped", "weekly_scoped_3"]);
  });

  test("the older response's keys and Codex's windows, by length and scope", () => {
    const old = [
      win({ kind: "five_hour", label: "5-HOUR" }),
      win({ kind: "seven_day", label: "WEEKLY", window_s: 7 * 86_400 }),
      win({ kind: "seven_day_opus", label: "SEVEN DAY OPUS", window_s: 7 * 86_400 }),
    ];
    expect(old.filter((w) => watches("5h", "claude", w)).map((w) => w.kind)).toEqual(["five_hour"]);
    expect(old.filter((w) => watches("weekly", "claude", w)).map((w) => w.kind)).toEqual([
      "seven_day",
    ]);
    expect(old.filter((w) => watches("weekly_scoped", "claude", w)).map((w) => w.kind)).toEqual([
      "seven_day_opus",
    ]);
    const codex = [
      win({ kind: "codex_primary", label: "5-HOUR" }),
      win({ kind: "codex_secondary", label: "WEEKLY", window_s: 7 * 86_400 }),
      win({ kind: "codex_bengalfox_secondary", label: "GPT-5.5 WEEKLY", window_s: 7 * 86_400 }),
      win({ kind: "codex_other_primary", label: "2-DAY", window_s: 2 * 86_400 }),
    ];
    const kinds = (w: Alert["window"]) =>
      codex.filter((x) => watches(w, "codex", x)).map((x) => x.kind);
    expect(kinds("5h")).toEqual(["codex_primary"]);
    expect(kinds("weekly")).toEqual(["codex_secondary"]);
    expect(kinds("weekly_scoped")).toEqual(["codex_bengalfox_secondary"]);
    expect(kinds("any")).toHaveLength(4);
  });

  test("a capture's windows read as T8's Limits reads them: 0 % once reset", () => {
    const c = capture(NOW - 5 * MIN, {
      session: { pct: 82, resetsAt: NOW + HOUR },
      weekly_all: { pct: 40, resetsAt: NOW - MIN },
    });
    expect(captureWindows(c, NOW)).toEqual([
      {
        kind: "session",
        label: "5-HOUR",
        utilization: 0.82,
        resets_at: NOW + HOUR,
        window_s: 18_000,
      },
      {
        kind: "weekly_all",
        label: "WEEKLY",
        utilization: 0,
        resets_at: NOW - MIN,
        window_s: 604_800,
      },
    ]);
  });
});

describe("firing", () => {
  test("a crossing fires once per window instance", () => {
    const a = alert();
    // 79 %: armed. 80 %: fires.
    expect(watched(a, [win({ utilization: 0.79 })], NOW)[0]?.fires).toBe(false);
    expect(watched(a, [win({ utilization: 0.8 })], NOW)[0]?.fires).toBe(true);
    // 0.82 * 100 is 81.99999999999999: still at or over 82.
    expect(watched(alert({ at: 82 }), [win({ utilization: 0.82 })], NOW)[0]?.fires).toBe(true);
    // Told (the hook marks it): the same instance never fires again, whatever its reset's
    // jitter between captures.
    a.delivered.push({ kind: "session", resets_at: NOW + HOUR, at: NOW });
    for (const u of [0.85, 0.99, 1]) {
      const [w] = watched(a, [win({ utilization: u, resets_at: NOW + HOUR + 700 })], NOW + MIN);
      expect(w).toMatchObject({ fires: false, status: "fired" });
    }
    expect(alertStatus(a, [FIVE], NOW)).toEqual({ status: "fired", fired_at: NOW });
    // The next instance, 5 hours on, fires again once over the line.
    const next = win({ utilization: 0.81, resets_at: NOW + 6 * HOUR });
    expect(watched(a, [next], NOW + 2 * HOUR)[0]).toMatchObject({ fires: true, status: "armed" });
    expect(alertStatus(a, [next], NOW + 2 * HOUR)).toEqual({ status: "armed", fired_at: null });
  });

  test("a window past its reset never fires: its capture belongs to the instance that ended", () => {
    const stale = win({ utilization: 0.95, resets_at: NOW - MIN });
    expect(watched(alert(), [stale], NOW)[0]).toMatchObject({ fires: false, status: "armed" });
  });

  test("'any' and 'weekly_scoped' fire per window; the status is fired only once all are", () => {
    const a = alert({ window: "any", at: 30 });
    const ws = watched(a, [FIVE, WEEK, FABLE], NOW);
    expect(ws.map((w) => [w.window.kind, w.fires])).toEqual([
      ["session", true],
      ["weekly_all", true],
      ["weekly_scoped", false],
    ]);
    a.delivered.push({ kind: "session", resets_at: FIVE.resets_at, at: NOW });
    a.delivered.push({ kind: "weekly_all", resets_at: WEEK.resets_at, at: NOW + MIN });
    expect(alertStatus(a, [FIVE, WEEK, FABLE], NOW).status).toBe("armed");
    expect(alertStatus(a, [FIVE, WEEK], NOW)).toEqual({ status: "fired", fired_at: NOW + MIN });
    // No such window captured yet: armed, waiting for data.
    expect(alertStatus(alert({ window: "weekly_scoped" }), [FIVE], NOW).status).toBe("armed");
  });

  test("lastFired leaves out the instance an alert was set over the line for", () => {
    const a = alert({
      delivered: [{ kind: "session", resets_at: NOW + HOUR, at: NOW - HOUR, on_set: true }],
    });
    expect(lastFired(a)).toBeNull();
    a.delivered.push({ kind: "weekly_all", resets_at: NOW + 99 * HOUR, at: NOW - 2 * MIN });
    expect(lastFired(a)).toBe(NOW - 2 * MIN);
  });
});

describe("groups (T16)", () => {
  test("an alert follows its account's current group in limits.json, else the roots it was set with", () => {
    const account = {
      id: "p",
      label: "personal",
      provider: "claude" as const,
      group: "g",
      members: ["p", "w"],
    };
    // Before detection ever ran: the members recorded when it was set.
    expect(currentMembers(undefined, account)).toEqual(["p", "w"]);
    const record = (id: string) => ({ id, detected_at: NOW, source: "auto" as const });
    expect(currentMembers({ p: record("g2"), w: record("g2"), x: record("g2") }, account)).toEqual([
      "p",
      "w",
      "x",
    ]);
    // Unlinked since: the root alone.
    expect(currentMembers({ w: record("g3"), z: record("g3") }, account)).toEqual(["p"]);
  });
});

describe("the message", () => {
  test("the spec's line, with the note and the reset countdown", () => {
    const a = alert({ note: "pause the refactor and commit" });
    const w = win({ utilization: 0.82, resets_at: NOW + HOUR + 12 * MIN });
    expect(alertMessage(a, w, NOW - MIN, NOW)).toBe(
      "[tokenhud alert] 5-hour limit (personal) is at 82% (alert at 80%), resets in 1h12m. Note: pause the refactor and commit. Call should_wait before long tasks.",
    );
  });

  test("limits over 2 minutes old say how old; other windows are named by their label", () => {
    const a = alert({ window: "any", at: 90, note: "Stop now!" });
    expect(
      alertMessage(
        a,
        win({ ...WEEK, utilization: 0.9, resets_at: NOW + 50 * HOUR }),
        NOW - 6 * MIN,
        NOW,
      ),
    ).toBe(
      "[tokenhud alert] weekly limit (personal) is at 90% (alert at 90%), resets in 2d2h (limits as of 6m ago). Note: Stop now! Call should_wait before long tasks.",
    );
    expect(
      alertMessage(
        alert({ window: "weekly_scoped" }),
        { ...FABLE, utilization: 0.8 },
        NOW - 2 * MIN,
        NOW,
      ),
    ).toBe(
      "[tokenhud alert] FABLE WEEKLY limit (personal) is at 80% (alert at 80%), resets in 1h. Call should_wait before long tasks.",
    );
  });

  test("compact durations", () => {
    expect([0, 45_000, 38 * MIN, HOUR, 72 * MIN, 49 * HOUR, 72 * HOUR].map(compact)).toEqual([
      "0s",
      "45s",
      "38m",
      "1h",
      "1h12m",
      "2d1h",
      "3d",
    ]);
  });
});

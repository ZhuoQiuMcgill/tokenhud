// Keeping limits fresh while alerts are armed (T29 §4), and what it costs: an MCP server
// (its tools, its alert watch and its own T8 service) and a TUI's service on one
// limits.json and one mocked clock, with fetchers that only count. Each run is three
// hours; the counts are the third's.
import { afterEach, describe, expect, test } from "bun:test";
import { runHook } from "../../src/alerts/hook.ts";
import { ALERT_MAX_AGE_S, ALERT_REFRESH_MS, AlertWatch } from "../../src/alerts/watch.ts";
import { limitsPath } from "../../src/limits/cache.ts";
import type { Capture } from "../../src/limits/capture.ts";
import { LimitsService } from "../../src/limits/service.ts";
import { guard } from "../guard.ts";
import {
  capture,
  cleanup,
  HOUR,
  MIN,
  machine,
  NOW,
  rootNamed,
  SESSION,
  transcript,
  wire,
} from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

const S = 1000;

interface Run {
  /** Whether a TUI runs beside the server. */
  tui: boolean;
  /** Set a session alert (5h at 80 %) at the start. */
  alert: boolean;
  /** An agent's should_wait every `poll` seconds (T18's case); none when absent. */
  poll?: number;
  /** When the server's watch ticks, after the TUI's first round (s). */
  offset?: number;
  /** The 5-hour window's use, by request: under 80 % by default. */
  pct?: (now: number) => number;
  /** How long to run; the counts are the last hour's. Three by default. */
  hours?: number;
  /** Run `tokenhud hook` (PostToolBatch) every `hook` seconds; never when absent. */
  hook?: number;
}

/** Requests in the last hour, by process; every request and every alert told. */
async function hourly(o: Run) {
  const m = machine();
  const personal = rootNamed(m, "personal");
  const path = transcript(m.claude);
  const clock = { now: NOW };
  const calls: { by: "tui" | "mcp"; at: number }[] = [];
  const resets = { at: NOW + 4 * HOUR };
  const fetch = (by: "tui" | "mcp") => async (): Promise<Capture> => {
    calls.push({ by, at: clock.now });
    if (clock.now >= resets.at) resets.at += 5 * HOUR;
    return capture(clock.now, {
      session: { pct: o.pct?.(clock.now) ?? 50, resetsAt: resets.at },
      weekly_all: { pct: 30, resetsAt: NOW + 100 * HOUR },
    });
  };
  const service = (by: "tui" | "mcp") =>
    new LimitsService({
      limitsPath: limitsPath(m.env, m.home),
      roots: () => [personal],
      fetchClaude: fetch(by),
      credentialsMtime: () => 1,
      usesRpc: () => false,
      now: () => clock.now,
    });
  const tui = service("tui");
  const mcp = service("mcp");
  const wiring = wire(m, {
    env: { ...m.env, CLAUDE_CODE_SESSION_ID: SESSION },
    now: () => clock.now,
    claude: null,
    refresh: (account, maxAgeS) => mcp.refresh(account, maxAgeS),
  });
  if (o.alert) await wiring.tools.setAlert({ window: "5h", at: 80 });
  let tuiAt = o.tui ? NOW : Number.POSITIVE_INFINITY;
  let tickAt = NOW + (o.offset ?? 97) * S;
  let pollAt = o.poll === undefined ? Number.POSITIVE_INFINITY : NOW;
  let hookAt = o.hook === undefined ? Number.POSITIVE_INFINITY : NOW + 30 * S;
  const told: number[] = [];
  const hours = o.hours ?? 3;
  const end = NOW + hours * HOUR;
  for (;;) {
    const t = Math.min(tuiAt, tickAt, pollAt, hookAt);
    if (t >= end) break;
    clock.now = t;
    if (t === tuiAt) tuiAt = t + (await tui.refreshDue());
    if (t === tickAt) {
      await wiring.watch.tick();
      tickAt = t + ALERT_REFRESH_MS;
    }
    if (t === pollAt) {
      await wiring.tools.shouldWait({});
      pollAt = t + (o.poll as number) * S;
    }
    if (t === hookAt) {
      const input = {
        session_id: SESSION,
        transcript_path: path,
        hook_event_name: "PostToolBatch",
      };
      const out = runHook(JSON.stringify(input), {
        env: m.env,
        home: m.home,
        now: t,
        ppid: 1,
        readProc: null,
        log: (message) => {
          throw new Error(message);
        },
      });
      if (out !== "") told.push(t);
      hookAt = t + (o.hook as number) * S;
    }
  }
  const last = calls.filter((c) => c.at >= end - HOUR);
  return {
    mcp: last.filter((c) => c.by === "mcp").length,
    tui: last.filter((c) => c.by === "tui").length,
    calls,
    told,
  };
}

describe("the 5-minute refresh runs only while an alert is armed", () => {
  test.each([
    // [alert, TUI, MCP requests/h, TUI requests/h]
    [false, false, 0, 0],
    [false, true, 0, 12],
    [true, false, 12, 0],
    [true, true, 0, 12],
  ] as const)(
    "alert %p, TUI %p: %i requests from the server + %i from the TUI",
    async (alert, tui, mcp, fromTui) => {
      const got = await hourly({ alert, tui });
      expect([got.mcp, got.tui]).toEqual([mcp, fromTui]);
    },
  );

  test.each([0, 97, 250, 280, 299])(
    "whatever the phase against the TUI's rounds (watch at +%i s), one request per 5 minutes in all",
    async (offset) => {
      const got = await hourly({ alert: true, tui: true, offset });
      expect(got.mcp + got.tui).toBe(12);
    },
  );

  test("an agent polling should_wait every 10 s already keeps the data fresh: the alert adds nothing", async () => {
    const without = await hourly({ alert: false, tui: false, poll: 10 });
    const withAlert = await hourly({ alert: true, tui: false, poll: 10 });
    // T18's on-demand cap: at most one request a minute (60 s data), here every 70 s.
    expect(without.mcp).toBe(52);
    expect(withAlert.mcp).toBe(without.mcp);
  });

  test("a fired alert asks for nothing until its window resets, then its account is watched again", async () => {
    // Over the line from 30 minutes in, in every instance; the hook runs once a minute.
    const got = await hourly({
      alert: true,
      tui: false,
      hours: 5,
      hook: 60,
      pct: (now) => (now >= NOW + 30 * MIN ? 85 : 50),
    });
    const told = got.told.map((t) => (t - NOW) / MIN);
    const [first, second] = told as [number, number];
    // Told once in the first instance (after the first capture over 80 %), and once in the
    // next, which starts at 4 h already over the line.
    expect(told).toHaveLength(2);
    expect(first).toBeGreaterThanOrEqual(30);
    expect(first).toBeLessThan(40);
    expect(second).toBeGreaterThanOrEqual(240);
    expect(second).toBeLessThan(250);
    // Between the two, nothing was asked: the alert had fired for that instance.
    const asked = got.calls.map((c) => (c.at - NOW) / MIN);
    expect(asked.filter((t) => t > first && t < 240)).toEqual([]);
    expect(asked.filter((t) => t >= 240 && t <= second).length).toBeGreaterThanOrEqual(1);
    expect(asked.filter((t) => t > second)).toEqual([]);
  });

  test("a cleared alert stops the refresh at the next tick", async () => {
    const m = machine();
    const asked: string[] = [];
    const wiring = wire(m, {
      env: { ...m.env, CLAUDE_CODE_SESSION_ID: SESSION },
      claude: null,
      refresh: async (account) => {
        asked.push(account);
      },
    });
    const { id } = await wiring.tools.setAlert({ window: "weekly", at: 90 });
    asked.length = 0;
    expect(await wiring.watch.tick()).toEqual([rootNamed(m, "personal").identity]);
    await wiring.tools.clearAlert({ id });
    expect(await wiring.watch.tick()).toEqual([]);
    expect(asked).toEqual([rootNamed(m, "personal").identity]);
  });
});

describe("AlertWatch", () => {
  test("asks for data at most 270 s old, one account at a time, and never overlaps a tick", async () => {
    const asked: Array<[string, number]> = [];
    let release: () => void = () => {};
    const watch = new AlertWatch({
      armed: () => ["a", "b"],
      refresh: (account, maxAgeS) => {
        asked.push([account, maxAgeS]);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = watch.tick();
    const second = watch.tick();
    expect(second).toBe(first);
    expect(asked).toEqual([["a", 270]]);
    release();
    await Bun.sleep(0);
    release();
    expect(await first).toEqual(["a", "b"]);
    expect(asked).toEqual([
      ["a", ALERT_MAX_AGE_S],
      ["b", ALERT_MAX_AGE_S],
    ]);
  });

  test("a failure to read the alerts is logged and asks for nothing", async () => {
    const logs: string[] = [];
    const watch = new AlertWatch({
      armed: () => {
        throw new Error("boom");
      },
      refresh: async () => {
        throw new Error("never");
      },
      log: (m) => logs.push(m),
    });
    expect(await watch.tick()).toEqual([]);
    expect(logs).toEqual(["alerts: cannot read the armed alerts (boom)"]);
  });
});

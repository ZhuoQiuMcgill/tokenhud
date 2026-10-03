// AC1: an in-process client drives every tool over a stdio pipe (the SDK's own
// StdioServerTransport over in-memory streams), against a fixture store and limits.json.
// T8's reading is real; its fetching is mocked: `refresh` only records its calls.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storePath } from "../../src/paths.ts";
import type { Root } from "../../src/sources/roots.ts";
import { guard } from "../guard.ts";
import {
  capture,
  cleanup,
  connect,
  FakeClock,
  HOUR,
  type Machine,
  MIN,
  machine,
  NOW,
  type RpcMessage,
  rootNamed,
  SESSION,
  toolResult,
  transcript,
  usageRow,
  wire,
  writeLimits,
  writeStore,
} from "./helpers.ts";

guard();

afterEach(cleanup);

const DAY = 24 * HOUR;

interface Fixture {
  m: Machine;
  personal: Root;
  work: Root;
  codex: Root;
  refreshed: Array<[string, number]>;
}

/**
 * personal (claude-opus-4-8 at $5/M in, $25/M out): $5.00 at 14:50Z and $11.00 at 13:00Z.
 * work (claude-sonnet-5 at $2/M in): $2.00 yesterday at 13:00Z. codex: one row today.
 * limits.json: personal at 95% (5-HOUR, resets 15:38Z) and 40% (WEEKLY, resets Oct 4),
 * captured 30 s ago; work detected as not signed in here; codex never checked.
 */
function fixture(): Fixture {
  const m = machine();
  const personal = rootNamed(m, "personal");
  const work = rootNamed(m, "work");
  const codex = rootNamed(m, "codex");
  writeStore(m, [
    usageRow(personal, NOW - 10 * MIN, { inp: 1_000_000, outp: 0 }),
    usageRow(personal, NOW - 2 * HOUR, { inp: 2_000_000, outp: 40_000 }),
    usageRow(work, NOW - 26 * HOUR, { model: "claude-sonnet-5", inp: 1_000_000, outp: 0 }),
    usageRow(codex, NOW - 3 * HOUR, { model: "gpt-5.6-sol", inp: 100, outp: 10 }),
  ]);
  writeLimits(m, {
    [personal.identity]: {
      capture: capture(NOW - 30_000, {
        session: { pct: 95, resetsAt: NOW + 38 * MIN },
        weekly_all: { pct: 40, resetsAt: NOW + 3 * DAY },
      }),
      status: { last_attempt_at: NOW - 30_000, next_at: NOW + 5 * MIN },
    },
    [work.identity]: {
      status: { signed_in: false, history_only: "detected", checked_at: NOW - HOUR },
    },
  });
  return { m, personal, work, codex, refreshed: [] };
}

async function serve(f: Fixture, env: Record<string, string> = {}, clock?: FakeClock) {
  const wiring = wire(f.m, {
    env: { ...f.m.env, ...env },
    refresh: async (account, maxAgeS) => {
      f.refreshed.push([account, maxAgeS]);
    },
    // T8 and the store read the same clock the wait sleeps on.
    ...(clock !== undefined && { clock, now: clock.now }),
  });
  return { wiring, pipe: await connect(wiring) };
}

describe("tools/list", () => {
  test("eight tools, findable: each limits tool names usage limit, rate limit, quota, reset, wait", async () => {
    const { pipe } = await serve(fixture());
    const reply = await pipe.request("tools/list");
    const tools = (
      reply.result as {
        tools: Array<{ name: string; description: string; inputSchema: { required?: string[] } }>;
      }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "limits",
      "should_wait",
      "wait_for_reset",
      "usage",
      "accounts",
      "set_alert",
      "list_alerts",
      "clear_alert",
    ]);
    for (const tool of tools.slice(0, 3)) {
      for (const phrase of ["usage limit", "rate limit", "quota", "reset", "wait"]) {
        expect(tool.description.toLowerCase()).toContain(phrase);
      }
    }
    for (const tool of tools.slice(3, 5)) expect(tool.description).toContain("usage limits");
    for (const tool of tools.slice(5)) expect(tool.description).toContain("usage limit alert");
    // set_alert says when to use it, and what it watches.
    const setAlert = tools.find((t) => t.name === "set_alert");
    for (const phrase of ["before a long autonomous task", "rate limit", "quota", "5-hour"]) {
      expect(setAlert?.description).toContain(phrase);
    }
    expect(setAlert?.inputSchema.required).toEqual(["window", "at"]);
    expect(tools.find((t) => t.name === "wait_for_reset")?.inputSchema.required).toEqual([
      "max_wait_s",
    ]);
    expect(tools.find((t) => t.name === "usage")?.inputSchema.required).toEqual(["period"]);
    expect(pipe.noise).toEqual([]);
  });
});

describe("limits", () => {
  test("this session's account, refreshed through T8 when over 60 s old", async () => {
    const f = fixture();
    transcript(f.m.claude);
    const { pipe } = await serve(f, { CLAUDE_CODE_SESSION_ID: SESSION });
    const { value, isError } = await pipe.call("limits");
    expect(isError).toBe(false);
    // Pace: $5 in the last 30 min = $10/h. 5-HOUR opened at 10:38Z; $16 spent before the
    // capture, so 0.95 / 16 per dollar; the last 5 % lasts 0.05 / (0.059375 * 10) h =
    // 303.158 s. WEEKLY (T18) projects from its average since it opened on Sep 27 at
    // 15:00Z: $16 over 96 h, $0.17/h. 0.4 / 16 per dollar: 0.6 / (0.025 / 6) = 144 h, after
    // the Oct 4 reset, so safe.
    expect(value).toEqual({
      account: {
        label: "personal",
        provider: "claude",
        config_dir: f.m.claude,
        signed_in: true,
        detected_via: "default",
        group: null,
        shared_with: [],
      },
      windows: [
        {
          kind: "session",
          label: "5-HOUR",
          utilization: 0.95,
          resets_at: "2026-10-01T15:38:00.000Z",
          pace_cost_per_h: 10,
          pace_basis: "30m",
          projected_exhaustion_at: "2026-10-01T15:05:03.158Z",
          // 303.158 s from 15:00:00Z, rounded down (T26).
          projected_exhaustion_in_s: 303,
          stale_s: 30,
        },
        {
          kind: "weekly_all",
          label: "WEEKLY",
          utilization: 0.4,
          resets_at: "2026-10-04T15:00:00.000Z",
          pace_cost_per_h: 0.17,
          pace_basis: "window_avg",
          projected_exhaustion_at: "safe",
          projected_exhaustion_in_s: null,
          stale_s: 30,
        },
      ],
      as_of: "2026-10-01T14:59:30.000Z",
      error: null,
      note: "projected_exhaustion_at, and projected_exhaustion_in_s (the seconds until it), are an estimate from this machine's spend pace: the last 30 minutes' (pace_basis 30m) or, for a weekly window, its average since the window began (window_avg); a weekly window's instant is coarse, good to about a part of a day",
      warnings: [],
    });
    expect(f.refreshed).toEqual([[f.personal.identity, 60]]);
  });

  test("the session's transcript under another account picks that account", async () => {
    const f = fixture();
    transcript(f.m.work);
    const { pipe } = await serve(f, { CLAUDE_CODE_SESSION_ID: SESSION });
    const { value } = await pipe.call("limits");
    expect(value.account).toEqual({
      label: "work",
      provider: "claude",
      config_dir: f.m.work,
      signed_in: false,
      detected_via: "transcript",
      group: null,
      shared_with: [],
    });
    expect(value.windows).toEqual([]);
  });

  test("CLAUDE_CONFIG_DIR picks its account; an explicit account wins over it", async () => {
    const f = fixture();
    const { pipe } = await serve(f, { CLAUDE_CONFIG_DIR: f.m.work });
    expect((await pipe.call("limits")).value.account).toMatchObject({
      label: "work",
      detected_via: "env",
    });
    expect((await pipe.call("limits", { account: "personal" })).value.account).toMatchObject({
      label: "personal",
      detected_via: "argument",
    });
    expect((await pipe.call("limits", { provider: "codex" })).value.account).toMatchObject({
      label: "codex",
      provider: "codex",
      detected_via: "recent",
    });
  });
});

describe("should_wait", () => {
  test("5-HOUR at 95%: wait until 15:38 plus 30 s", async () => {
    const f = fixture();
    const { pipe } = await serve(f);
    expect((await pipe.call("should_wait")).value).toEqual({
      wait: true,
      reason: "5-HOUR is at 95%, at or over 90%; it resets at 15:38 (in 38m)",
      window: "5-HOUR",
      utilization: 0.95,
      resets_at: "2026-10-01T15:38:00.000Z",
      pace_cost_per_h: 10,
      pace_basis: "30m",
      projected_exhaustion_at: "2026-10-01T15:05:03.158Z",
      projected_exhaustion_in_s: 303,
      wait_s: 38 * 60 + 30,
    });
    expect(f.refreshed).toEqual([[f.personal.identity, 60]]);
  });

  test("estimated_cost is scaled by the store's spend in the window", async () => {
    const { pipe } = await serve(fixture());
    // WEEKLY: 0.4 + (0.4 / 16) * 14 = 0.75, and 0.4 + 0.025 * 20 = 0.9.
    const fits = await pipe.call("should_wait", { window: "weekly", estimated_cost: 14 });
    expect(fits.value).toMatchObject({ wait: false, window: "WEEKLY" });
    expect(fits.value.reason).toContain("an estimated $14.00 takes WEEKLY to about 75%");
    const over = await pipe.call("should_wait", { window: "weekly", estimated_cost: 20 });
    expect(over.value).toMatchObject({ wait: true, window: "WEEKLY", wait_s: 3 * 86400 + 30 });
  });

  test("model makes a model's own weekly window bind; without it, it is only noted", async () => {
    const f = fixture();
    writeLimits(f.m, {
      [f.personal.identity]: {
        capture: capture(NOW - 30_000, {
          session: { pct: 95, resetsAt: NOW + 40 * MIN },
          weekly_scoped: { pct: 100, resetsAt: NOW + 4 * DAY, label: "FABLE WEEKLY" },
        }),
        status: {},
      },
    });
    const { pipe } = await serve(f);
    const plain = await pipe.call("should_wait");
    expect(plain.value).toMatchObject({ wait: true, window: "5-HOUR", wait_s: 40 * 60 + 30 });
    expect(plain.value.reason).toContain("note: FABLE WEEKLY is at 100% until Oct 5 15:00");
    const own = await pipe.call("should_wait", { model: "claude-fable-5" });
    expect(own.value).toMatchObject({ wait: true, window: "FABLE WEEKLY", wait_s: 4 * 86400 + 30 });
  });

  test("an account not signed in on this machine never waits", async () => {
    const { pipe } = await serve(fixture());
    expect((await pipe.call("should_wait", { account: "work" })).value).toEqual({
      wait: false,
      reason: "limits unavailable: not signed in on this machine",
      utilization: null,
      wait_s: 0,
    });
  });

  test("a bad argument is a tool error with a plain message", async () => {
    const { pipe } = await serve(fixture());
    const result = await pipe.call("should_wait", { window: "daily" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "no window 'daily' on this account (windows: 5-HOUR (session), WEEKLY (weekly_all))",
    );
    expect(result.value).toEqual({ error: { code: "bad_argument", message: result.text } });
    const schema = await pipe.call("should_wait", { min_headroom: 2 });
    expect(schema.isError).toBe(true);
    expect(schema.text).toContain("min_headroom");
  });
});

describe("wait_for_reset", () => {
  function progressOf(messages: RpcMessage[], token: string) {
    return messages
      .filter((m) => m.method === "notifications/progress" && m.params?.progressToken === token)
      .map((m) => m.params as { progress: number; total: number; message: string });
  }

  test("waits for 5-HOUR with progress notifications, then reports the reset", async () => {
    const f = fixture();
    // 5-HOUR resets in 2 minutes here.
    writeLimits(f.m, {
      [f.personal.identity]: {
        capture: capture(NOW - 30_000, { session: { pct: 100, resetsAt: NOW + 2 * MIN } }),
        status: {},
      },
    });
    const clock = new FakeClock();
    const { pipe } = await serve(f, {}, clock);
    const reply = await pipe.request("tools/call", {
      name: "wait_for_reset",
      arguments: { max_wait_s: 18_000 },
      _meta: { progressToken: "tok-1" },
    });
    expect(toolResult(reply).value).toEqual({
      waited_s: 150,
      reset: true,
      // limits.json still holds the old capture: past its reset it reads 0 % (T8's rule).
      utilization_now: 0,
      aborted: false,
      window: "5-HOUR",
      reason: "5-HOUR reset at 15:02; now at 0%",
    });
    const progress = progressOf(pipe.received, "tok-1");
    expect(progress.map((p) => [p.progress, p.total])).toEqual([
      [30, 150],
      [60, 150],
      [90, 150],
      [120, 150],
      [150, 150],
    ]);
    expect(progress[0]?.message).toBe("waited 30s of 2m 30s; 5-HOUR 100%, resets 15:02");
    // Refreshed at the start and after the reset.
    expect(f.refreshed).toEqual([
      [f.personal.identity, 60],
      [f.personal.identity, 60],
    ]);
  });

  test("a cancelled call stops at once and the server keeps answering", async () => {
    const f = fixture();
    const clock = new FakeClock();
    const { pipe } = await serve(f, {}, clock);
    let seen = 0;
    let requestId = 0;
    const cancelled = new Promise<void>((resolve) => {
      pipe.onNotification = (message) => {
        if (message.method !== "notifications/progress") return;
        seen++;
        if (seen === 2) {
          pipe.send({
            method: "notifications/cancelled",
            params: { requestId, reason: "user interrupted" },
          });
          resolve();
        }
      };
    });
    const started = pipe.start("tools/call", {
      name: "wait_for_reset",
      arguments: { max_wait_s: 18_000 },
      _meta: { progressToken: "tok-2" },
    });
    requestId = started.id;
    await cancelled;
    const sleepsAtCancel = clock.sleeps.length;
    // The server still answers, and the wait made no more progress.
    expect((await pipe.call("should_wait")).value.wait).toBe(true);
    await Bun.sleep(20);
    expect(progressOf(pipe.received, "tok-2")).toHaveLength(2);
    expect(clock.sleeps.length).toBeLessThanOrEqual(sleepsAtCancel + 1);
    expect(clock.t - NOW).toBeLessThanOrEqual(90_000);
  });

  test("max_wait_s over 5 hours is refused by the schema", async () => {
    const { pipe } = await serve(fixture());
    const result = await pipe.call("wait_for_reset", { max_wait_s: 18_001 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("max_wait_s");
  });
});

describe("usage", () => {
  test("T6's JSON for a period, with every account by default, plus stale_s", async () => {
    const { pipe } = await serve(fixture());
    const { value } = await pipe.call("usage", { period: "today", group_by: "account" });
    expect(value).toMatchObject({
      schema: 1,
      query: "usage",
      period: {
        name: "today",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
        tz: "UTC",
      },
      filter: { accounts: null, providers: null },
      group_by: "account",
      totals: { records: 3, tokens: { input: 3_000_100, output: 40_010 } },
      stale_s: 600,
    });
    const groups = value.groups as Array<{ account: { label: string }; cost_usd: number }>;
    expect(groups[0]).toMatchObject({ account: { label: "personal" }, cost_usd: 16 });
    expect(value.warnings).toEqual([
      "the store was not refreshed: this build of the MCP server does not ingest (no single-writer lock yet); data is as of the last tokenhud ingest",
    ]);
  });

  test("account and provider filters, and calendar groups", async () => {
    const { pipe } = await serve(fixture());
    const work = await pipe.call("usage", {
      period: "this_week",
      account: "WORK",
      group_by: "day",
    });
    expect(work.value.totals).toMatchObject({ records: 1, cost_usd: 2 });
    const days = work.value.groups as Array<{ key: string; cost_usd: number }>;
    expect(days.map((d) => d.key)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(days.find((d) => d.key === "2026-09-30")?.cost_usd).toBe(2);
    const codex = await pipe.call("usage", { period: "all", provider: "codex" });
    expect(codex.value.totals).toMatchObject({ records: 1, tokens: { input: 100, output: 10 } });
    expect(codex.value.filter).toEqual({ accounts: null, providers: ["codex"] });
  });

  test("custom periods read since and until as tokenhud json does", async () => {
    const { pipe } = await serve(fixture());
    const { value } = await pipe.call("usage", {
      period: "custom",
      since: "2026-09-30",
      until: "2026-09-30",
    });
    expect(value.period).toEqual({
      name: "custom",
      from: "2026-09-30T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      tz: "UTC",
    });
    expect(value.totals).toMatchObject({ records: 1, cost_usd: 2 });
  });

  test("more than 500 groups in one call is refused with a clear error", async () => {
    const { pipe } = await serve(fixture());
    const result = await pipe.call("usage", {
      period: "custom",
      since: "2024-01-01",
      group_by: "day",
    });
    expect(result.isError).toBe(true);
    // 2024-01-01 through 2026-10-01: 366 + 365 + 274 days.
    expect(result.text).toBe(
      "group_by 'day' over this period gives 1005 groups; at most 500 per call: use a coarser group_by or a shorter period",
    );
    const weeks = await pipe.call("usage", {
      period: "custom",
      since: "2024-01-01",
      group_by: "week",
    });
    expect(weeks.isError).toBe(false);
    // Exactly 500 days is allowed.
    const ok = await pipe.call("usage", {
      period: "custom",
      since: "2025-05-20",
      until: "2026-10-01",
      group_by: "day",
    });
    expect(ok.isError).toBe(false);
    expect(ok.value.groups as unknown[]).toHaveLength(500);
  });

  test("bad arguments are plain tool errors", async () => {
    const { pipe } = await serve(fixture());
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ period: "today", since: "2026-01-01" }, "since and until need period 'custom'"],
      [{ period: "custom" }, "period 'custom' needs since"],
      [
        { period: "custom", since: "yesterday" },
        "since must be a date (YYYY-MM-DD) or an ISO-8601 instant with an offset, got 'yesterday'",
      ],
      [
        { period: "today", tz: "Mars/Olympus" },
        "unknown time zone 'Mars/Olympus' (use an IANA name such as Europe/Paris)",
      ],
      [
        { period: "today", account: "nobody" },
        "unknown account 'nobody' (accounts: personal, work, codex)",
      ],
    ];
    for (const [args, message] of cases) {
      const result = await pipe.call("usage", args);
      expect(result.isError).toBe(true);
      expect(result.text).toBe(message);
    }
  });

  test("an unreadable store is a fixed message: no path, no SQLite text, no stack", async () => {
    const f = fixture();
    const path = storePath(f.m.env, f.m.home);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(path + suffix)) writeFileSync(path + suffix, "");
    }
    writeFileSync(path, "this is not a database, just text long enough to have a header");
    const { pipe } = await serve(f);
    const result = await pipe.call("usage", { period: "today" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("the usage store looks damaged; run `tokenhud doctor` for details");
    expect(result.value).toEqual({ error: { code: "store_error", message: result.text } });

    // The limit tools don't need the store: they answer without pace or projections.
    const limits = await pipe.call("limits");
    expect(limits.isError).toBe(false);
    expect(limits.value.warnings).toEqual([
      "the usage store can't be read, so the spend pace and projections are unknown (run `tokenhud doctor`)",
    ]);
    const windows = limits.value.windows as Array<{
      utilization: number;
      pace_cost_per_h: unknown;
      projected_exhaustion_at: unknown;
    }>;
    expect(
      windows.map((w) => [w.utilization, w.pace_cost_per_h, w.projected_exhaustion_at]),
    ).toEqual([
      [0.95, null, null],
      [0.4, null, null],
    ]);
    const verdict = await pipe.call("should_wait");
    expect(verdict.value).toMatchObject({ wait: true, window: "5-HOUR" });
    expect(verdict.value.reason).toEndWith(
      "; the usage store can't be read, so the spend pace and projections are unknown (run `tokenhud doctor`)",
    );
    const accounts = await pipe.call("accounts");
    expect(accounts.isError).toBe(false);
    expect((accounts.value.accounts as unknown[]).length).toBe(3);
  });

  test("a bad price overrides file is a fixed warning: no path, no file content", async () => {
    const f = fixture();
    mkdirSync(join(f.m.xdg, "tokenhud"), { recursive: true });
    writeFileSync(join(f.m.xdg, "tokenhud", "pricing.overrides.json"), "{ oops");
    const { pipe } = await serve(f);
    const { value } = await pipe.call("usage", { period: "today" });
    const warnings = value.warnings as string[];
    expect(warnings[0]).toBe(
      "the price overrides file has problems, so some or all of it is ignored (run `tokenhud doctor` for details)",
    );
    expect(JSON.stringify(value)).not.toContain(f.m.xdg);
    expect(JSON.stringify(value)).not.toContain("oops");
  });
});

describe("accounts", () => {
  test("every account from cached data only, with the current one marked", async () => {
    const f = fixture();
    const { pipe } = await serve(f, { CLAUDE_CONFIG_DIR: f.m.claude });
    expect((await pipe.call("accounts")).value).toEqual({
      accounts: [
        {
          id: f.personal.identity,
          label: "personal",
          provider: "claude",
          group: null,
          signed_in: true,
          last_seen: "2026-10-01T14:50:00.000Z",
          is_current: true,
        },
        {
          id: f.work.identity,
          label: "work",
          provider: "claude",
          group: null,
          signed_in: false,
          last_seen: "2026-09-30T13:00:00.000Z",
          is_current: false,
        },
        {
          id: f.codex.identity,
          label: "codex",
          provider: "codex",
          group: null,
          // Never checked: unknown until its limits are first read.
          signed_in: null,
          last_seen: "2026-10-01T12:00:00.000Z",
          is_current: false,
        },
      ],
    });
    // No request, no app-server, no sign-in refresh.
    expect(f.refreshed).toEqual([]);
  });

  test("history_only_roots in config: never fetched, signed_in false", async () => {
    const f = fixture();
    mkdirSync(join(f.m.xdg, "tokenhud"), { recursive: true });
    writeFileSync(
      join(f.m.xdg, "tokenhud", "config.json"),
      JSON.stringify({ history_only_roots: [f.codex.identity] }),
    );
    const { pipe } = await serve(f);
    const { value } = await pipe.call("accounts");
    const codex = (value.accounts as Array<{ label: string; signed_in: boolean }>).find(
      (a) => a.label === "codex",
    );
    expect(codex?.signed_in).toBe(false);
    expect(f.refreshed).toEqual([]);
  });
});

describe("the heartbeat file", () => {
  test("each call is recorded with its tool and account label, in T10's format", async () => {
    const f = fixture();
    const { pipe, wiring } = await serve(f);
    await pipe.call("limits");
    await pipe.call("usage", { period: "today" });
    await pipe.call("usage", { period: "today", account: "work" });
    const dir = join(f.m.xdg, "tokenhud", "mcp");
    expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
    const beat = JSON.parse(readFileSync(wiring.heartbeat.path, "utf8"));
    expect(Object.keys(beat)).toEqual([
      "pid",
      "host",
      "project",
      "session",
      "started_at",
      "updated_at",
      "calls",
    ]);
    expect(beat.pid).toBe(process.pid);
    expect(
      beat.calls.map((c: { tool: string; account: string | null }) => [c.tool, c.account]),
    ).toEqual([
      ["limits", "personal"],
      ["usage", null],
      ["usage", "work"],
    ]);
    wiring.heartbeat.stop();
    expect(readdirSync(dir)).toEqual([]);
  });
});

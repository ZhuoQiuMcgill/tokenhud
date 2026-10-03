// `tokenhud hook` (T29): golden stdin and stdout for PostToolBatch and UserPromptSubmit,
// SessionEnd, groups and scopes, and failures that must stay silent. On a fake machine:
// temp HOME and config home, synthetic ids, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookLog, hookLogPath, runHook } from "../../src/alerts/hook.ts";
import type { ProcInfo } from "../../src/alerts/proc.ts";
import {
  type Alert,
  alertsPath,
  editAlerts,
  hookSeenPath,
  loadAlerts,
  readHookSeen,
} from "../../src/alerts/store.ts";
import { limitsPath, loadLimitsCache, saveLimitsCache } from "../../src/limits/cache.ts";
import { tryLease } from "../../src/limits/lease.ts";
import { mcpDir } from "../../src/paths.ts";
import { guard } from "../guard.ts";
import {
  CLI,
  capture,
  cleanup,
  envOf,
  HOUR,
  type Machine,
  MIN,
  machine,
  NOW,
  rootNamed,
  SESSION,
  transcript,
  writeLimits,
} from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

const OTHER = "00000000-0000-4000-8000-000000000002";

interface Fixture {
  m: Machine;
  personal: string;
  work: string;
  transcript: string;
  logs: string[];
}

function fixture(): Fixture {
  const m = machine();
  return {
    m,
    personal: rootNamed(m, "personal").identity,
    work: rootNamed(m, "work").identity,
    transcript: transcript(m.claude),
    logs: [],
  };
}

function setAlerts(f: Fixture, ...alerts: Alert[]): void {
  editAlerts(alertsPath(f.m.env, f.m.home), (list) => {
    list.splice(0, list.length, ...alerts);
    return true;
  });
}

function alert(f: Fixture, over: Partial<Alert> = {}): Alert {
  return {
    id: "a1b2c3d4",
    created_at: NOW - HOUR,
    session: SESSION,
    account: {
      id: f.personal,
      label: "personal",
      provider: "claude",
      group: null,
      members: [f.personal],
    },
    window: "5h",
    at: 80,
    note: "pause the refactor and commit",
    delivered: [],
    ...over,
  };
}

/** The event Claude Code sends, as its hooks reference shows it. */
function event(f: Fixture, name: string, over: Record<string, unknown> = {}): string {
  const common = {
    session_id: SESSION,
    prompt_id: "00000000-0000-4000-8000-0000000000aa",
    transcript_path: f.transcript,
    cwd: join(f.m.home, "code", "demo-app"),
    permission_mode: "default",
    hook_event_name: name,
  };
  const extra =
    name === "PostToolBatch"
      ? {
          tool_calls: [
            { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_01" },
          ],
          tool_results: [
            { tool_use_id: "toolu_01", tool_name: "Bash", content: "PASS", is_error: false },
          ],
        }
      : name === "UserPromptSubmit"
        ? { prompt_text: "Refactor this module", is_continuation: false }
        : name === "SessionEnd"
          ? { reason: "prompt_input_exit" }
          : {};
  return JSON.stringify({ ...common, ...extra, ...over });
}

/** A made-up process table: the hook's shell 4242, under Claude Code 4000. */
const PROCS: Record<number, ProcInfo> = {
  4242: { ppid: 4000, start: "500", name: "sh" },
  4000: { ppid: 1, start: "777", name: "claude" },
};
const readProc = (pid: number) => PROCS[pid] ?? null;

function run(f: Fixture, input: string, now = NOW): string {
  return runHook(input, {
    env: f.m.env,
    home: f.m.home,
    now,
    ppid: 4242,
    readProc,
    log: (message) => f.logs.push(message),
  });
}

/** limits.json with personal's 5-hour window at `pct`, resetting in 1h12m, captured `age` ago. */
function limits(f: Fixture, pct: number, age = MIN): void {
  writeLimits(f.m, {
    [f.personal]: {
      capture: capture(NOW - age, {
        session: { pct, resetsAt: NOW + HOUR + 12 * MIN },
        weekly_all: { pct: 40, resetsAt: NOW + 50 * HOUR },
      }),
    },
  });
}

const reply = (event: string, context: string) =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`;

const LINE =
  "[tokenhud alert] 5-hour limit (personal) is at 82% (alert at 80%), resets in 1h12m. Note: pause the refactor and commit. Call should_wait before long tasks.";

describe("PostToolBatch and UserPromptSubmit", () => {
  test("PostToolBatch: the spec's line once the window crosses, then nothing for that instance", () => {
    const f = fixture();
    setAlerts(f, alert(f));
    limits(f, 79);
    expect(run(f, event(f, "PostToolBatch"))).toBe("");
    limits(f, 82);
    expect(run(f, event(f, "PostToolBatch"))).toBe(reply("PostToolBatch", LINE));
    expect(loadAlerts(alertsPath(f.m.env, f.m.home))[0]?.delivered).toEqual([
      { kind: "session", resets_at: NOW + HOUR + 12 * MIN, at: NOW },
    ]);
    // Told once per instance, however high it goes.
    limits(f, 95);
    expect(run(f, event(f, "PostToolBatch"), NOW + MIN)).toBe("");
    expect(run(f, event(f, "UserPromptSubmit"), NOW + 2 * MIN)).toBe("");
    expect(f.logs).toEqual([]);
  });

  test("UserPromptSubmit: the same reply under its own event name, with the capture's age when over 2 minutes", () => {
    const f = fixture();
    setAlerts(f, alert(f));
    limits(f, 82, 6 * MIN);
    expect(run(f, event(f, "UserPromptSubmit"))).toBe(
      reply(
        "UserPromptSubmit",
        "[tokenhud alert] 5-hour limit (personal) is at 82% (alert at 80%), resets in 1h12m (limits as of 6m ago). Note: pause the refactor and commit. Call should_wait before long tasks.",
      ),
    );
  });

  test("an alert set over the line fires only for the window's next instance", () => {
    const f = fixture();
    const resets = NOW + HOUR + 12 * MIN;
    setAlerts(
      f,
      alert(f, {
        delivered: [{ kind: "session", resets_at: resets, at: NOW - HOUR, on_set: true }],
      }),
    );
    limits(f, 85);
    expect(run(f, event(f, "PostToolBatch"))).toBe("");
    // After the reset the next instance starts low, then crosses.
    const next = resets + 5 * HOUR;
    writeLimits(f.m, {
      [f.personal]: {
        capture: capture(resets + 3 * HOUR, { session: { pct: 81, resetsAt: next } }),
      },
    });
    expect(run(f, event(f, "PostToolBatch"), resets + 3 * HOUR + MIN)).toBe(
      reply(
        "PostToolBatch",
        "[tokenhud alert] 5-hour limit (personal) is at 81% (alert at 80%), resets in 1h59m. Note: pause the refactor and commit. Call should_wait before long tasks.",
      ),
    );
  });

  test("several alerts: one line each; a window that hasn't crossed says nothing", () => {
    const f = fixture();
    setAlerts(
      f,
      alert(f, { id: "a1", note: null }),
      alert(f, { id: "a2", window: "weekly", at: 40, note: "wrap up" }),
      alert(f, { id: "a3", window: "weekly", at: 90 }),
    );
    limits(f, 82);
    expect(run(f, event(f, "PostToolBatch"))).toBe(
      reply(
        "PostToolBatch",
        [
          "[tokenhud alert] 5-hour limit (personal) is at 82% (alert at 80%), resets in 1h12m. Call should_wait before long tasks.",
          "[tokenhud alert] weekly limit (personal) is at 40% (alert at 40%), resets in 2d2h. Note: wrap up. Call should_wait before long tasks.",
        ].join("\n"),
      ),
    );
  });

  test("past Claude Code's 10,000-character cap, the rest are counted", () => {
    const f = fixture();
    setAlerts(
      f,
      ...Array.from({ length: 60 }, (_, i) =>
        alert(f, { id: `a${i}`, note: `${i} ${"x".repeat(190)}` }),
      ),
    );
    limits(f, 82);
    const out = JSON.parse(run(f, event(f, "PostToolBatch")));
    const lines: string[] = out.hookSpecificOutput.additionalContext.split("\n");
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(9_100);
    expect(lines.at(-1)).toMatch(/^\[tokenhud alert\] \d+ more alerts fired: call list_alerts\.$/);
    expect(lines.length - 1 + Number(/(\d+) more/.exec(lines.at(-1) as string)?.[1])).toBe(60);
    // Every one is marked: the counted ones are in list_alerts, not told again.
    expect(loadAlerts(alertsPath(f.m.env, f.m.home)).every((a) => a.delivered.length === 1)).toBe(
      true,
    );
  });
});

describe("whose alerts", () => {
  test("another session's alerts and persistent ones on another account stay quiet", () => {
    const f = fixture();
    setAlerts(
      f,
      alert(f, { id: "theirs", session: OTHER }),
      alert(f, {
        id: "work",
        session: null,
        account: { id: f.work, label: "work", provider: "claude", group: null, members: [f.work] },
      }),
    );
    writeLimits(f.m, {
      [f.personal]: { capture: capture(NOW - MIN, { session: { pct: 90, resetsAt: NOW + HOUR } }) },
      [f.work]: { capture: capture(NOW - MIN, { session: { pct: 90, resetsAt: NOW + HOUR } }) },
    });
    expect(run(f, event(f, "PostToolBatch"))).toBe("");
    // A session alert on another account is this session's all the same.
    setAlerts(
      f,
      alert(f, {
        account: { id: f.work, label: "work", provider: "claude", group: null, members: [f.work] },
        note: null,
      }),
    );
    expect(run(f, event(f, "PostToolBatch"))).toContain("5-hour limit (work) is at 90%");
  });

  test("a persistent alert on a group member applies to the group: told to a session on another root, from the group's freshest capture", () => {
    const f = fixture();
    setAlerts(
      f,
      alert(f, {
        session: null,
        note: null,
        account: { id: f.work, label: "work", provider: "claude", group: null, members: [f.work] },
      }),
    );
    const record = { id: "group-1", detected_at: NOW - HOUR, source: "auto" as const };
    saveLimitsCache(
      {
        providers: {
          // personal's own capture is older; work's, the group's freshest, is over the line.
          [f.personal]: capture(NOW - 10 * MIN, { session: { pct: 60, resetsAt: NOW + HOUR } }),
          [f.work]: capture(NOW - MIN, { session: { pct: 84, resetsAt: NOW + HOUR } }),
        },
        status: {},
        groups: { [f.personal]: record, [f.work]: record },
      },
      limitsPath(f.m.env, f.m.home),
    );
    expect(run(f, event(f, "PostToolBatch"))).toBe(
      reply(
        "PostToolBatch",
        "[tokenhud alert] 5-hour limit (work) is at 84% (alert at 80%), resets in 1h. Call should_wait before long tasks.",
      ),
    );
    // Unlinked: personal's sessions no longer hear about work's alert.
    setAlerts(
      f,
      alert(f, {
        session: null,
        account: { id: f.work, label: "work", provider: "claude", group: null, members: [f.work] },
      }),
    );
    const file = loadLimitsCache(limitsPath(f.m.env, f.m.home));
    file.groups = {};
    saveLimitsCache(file, limitsPath(f.m.env, f.m.home));
    expect(run(f, event(f, "PostToolBatch"))).toBe("");
  });

  test("without a transcript path, the session's account is CLAUDE_CONFIG_DIR's", () => {
    const f = fixture();
    setAlerts(
      f,
      alert(f, {
        session: null,
        note: null,
        account: { id: f.work, label: "work", provider: "claude", group: null, members: [f.work] },
      }),
    );
    writeLimits(f.m, {
      [f.work]: { capture: capture(NOW - MIN, { session: { pct: 90, resetsAt: NOW + HOUR } }) },
    });
    const input = event(f, "PostToolBatch", { transcript_path: undefined });
    expect(run(f, input)).toBe("");
    const out = runHook(input, {
      env: { ...f.m.env, CLAUDE_CONFIG_DIR: f.m.work },
      home: f.m.home,
      now: NOW,
      ppid: 1,
      readProc: null,
      log: () => {},
    });
    expect(out).toContain("5-hour limit (work) is at 90%");
  });

  test("inside a subagent nothing is told: the main thread hears it at its next event", () => {
    const f = fixture();
    setAlerts(f, alert(f));
    limits(f, 82);
    expect(run(f, event(f, "PostToolBatch", { agent_id: "agent-1", agent_type: "Explore" }))).toBe(
      "",
    );
    expect(readHookSeen(mcpDir(f.m.env, f.m.home), SESSION)?.seen_at).toBe(NOW);
    expect(run(f, event(f, "PostToolBatch", { agent_type: "reviewer" }))).toBe(
      reply("PostToolBatch", LINE),
    );
  });
});

describe("the session's record and SessionEnd", () => {
  test("each run records the session, with the Claude Code process above its shell and its config dir", () => {
    const f = fixture();
    run(f, event(f, "UserPromptSubmit"));
    expect(readHookSeen(mcpDir(f.m.env, f.m.home), SESSION)).toEqual({
      session: SESSION,
      seen_at: NOW,
      ppid: 4242,
      claude: { pid: 4000, start: "777" },
      root: f.personal,
    });
  });

  test("SessionEnd waits at most 300 ms for a held lock, then leaves the alerts to expire", () => {
    const f = fixture();
    setAlerts(f, alert(f));
    const path = alertsPath(f.m.env, f.m.home);
    const lease = tryLease(`${path}.lock`, 60_000);
    const t = performance.now();
    expect(run(f, event(f, "SessionEnd"))).toBe("");
    expect(performance.now() - t).toBeLessThan(1_000);
    lease?.release();
    expect(loadAlerts(path)).toHaveLength(1);
    expect(f.logs).toEqual(["SessionEnd: alerts.json stayed locked; its alerts expire in 24 h"]);
  });

  test("SessionEnd removes the session's alerts and record, and prints nothing", () => {
    const f = fixture();
    setAlerts(
      f,
      alert(f, { id: "mine" }),
      alert(f, { id: "theirs", session: OTHER }),
      alert(f, { id: "kept", session: null }),
    );
    run(f, event(f, "PostToolBatch"));
    expect(run(f, event(f, "SessionEnd"))).toBe("");
    expect(loadAlerts(alertsPath(f.m.env, f.m.home)).map((a) => a.id)).toEqual(["theirs", "kept"]);
    expect(existsSync(hookSeenPath(mcpDir(f.m.env, f.m.home), SESSION))).toBe(false);
  });
});

describe("failures never reach the agent", () => {
  test("bad input prints nothing and is logged", () => {
    const f = fixture();
    for (const input of ["", "not json", "[]", '{"hook_event_name":"PostToolBatch"}']) {
      expect(run(f, input)).toBe("");
    }
    expect(run(f, JSON.stringify({ session_id: SESSION }))).toBe("");
    expect(run(f, event(f, "PostToolBatch", { session_id: "../../x" }))).toBe("");
    expect(f.logs).toEqual([
      "the hook input is not JSON",
      "the hook input is not JSON",
      "the hook input is not a JSON object",
      "the hook input has no valid session_id",
      "the hook input has no hook_event_name",
      "the hook input has no valid session_id",
    ]);
  });

  test("a malformed alerts.json or limits.json is no alert, not an error", () => {
    const f = fixture();
    limits(f, 99);
    writeFileSync(alertsPath(f.m.env, f.m.home), "{ damaged");
    expect(run(f, event(f, "PostToolBatch"))).toBe("");
    setAlerts(f, alert(f));
    writeFileSync(limitsPath(f.m.env, f.m.home), "[1, 2");
    expect(run(f, event(f, "PostToolBatch"))).toBe("");
    // The damaged alerts.json is logged (once: the log skips a repeat), and moved aside
    // by the next writer.
    expect(f.logs).toEqual(["alerts.json is unreadable; it is moved aside on the next change"]);
  });

  test("other events are ignored", () => {
    const f = fixture();
    setAlerts(f, alert(f));
    limits(f, 82);
    expect(run(f, event(f, "Stop"))).toBe("");
    expect(loadAlerts(alertsPath(f.m.env, f.m.home))[0]?.delivered).toEqual([]);
  });

  test("the log holds a failure once while it repeats", () => {
    const f = fixture();
    const path = hookLogPath(f.m.env, f.m.home);
    const log = hookLog(path, f.m.home);
    log("the hook input is not JSON");
    log("the hook input is not JSON");
    log("failed (Error: boom)");
    log("the hook input is not JSON");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((l) => l.replace(/^\S+ /, ""))).toEqual([
      "warn the hook input is not JSON",
      "warn failed (Error: boom)",
      "warn the hook input is not JSON",
    ]);
  });
});

describe("tokenhud hook, as Claude Code runs it", () => {
  /** The test guard's TOKENHUD_TEST=1 lets the fresh process take NOW as its clock. */
  function spawn(f: Fixture, input: string) {
    return Bun.spawn([process.execPath, CLI, "hook"], {
      env: { ...envOf(f.m), TOKENHUD_TEST_NOW: String(NOW) },
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test.each(["PostToolBatch", "UserPromptSubmit"])(
    "golden, %s: event in on stdin, hook reply out, exit 0",
    async (name) => {
      const f = fixture();
      setAlerts(f, alert(f));
      limits(f, 82);
      const proc = spawn(f, event(f, name));
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stdout).text()).toBe(reply(name, LINE));
      expect(await new Response(proc.stderr).text()).toBe("");
    },
  );

  test("errors: exit 0, nothing on stdout, one line in the log", async () => {
    const f = fixture();
    for (const input of ["garbage", "garbage"]) {
      const proc = spawn(f, input);
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stdout).text()).toBe("");
    }
    const log = readFileSync(hookLogPath(f.m.env, f.m.home), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(log[0]).toEndWith(" warn the hook input is not JSON");
  });

  test("two hooks at once tell a persistent alert once", async () => {
    const f = fixture();
    setAlerts(f, alert(f, { session: null }));
    limits(f, 90);
    const procs = [
      spawn(f, event(f, "PostToolBatch")),
      spawn(f, event(f, "PostToolBatch", { session_id: OTHER })),
    ];
    const outs = await Promise.all(procs.map(async (p) => new Response(p.stdout).text()));
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0]);
    expect(outs.filter((o) => o !== "")).toHaveLength(1);
    expect(loadAlerts(alertsPath(f.m.env, f.m.home))[0]?.delivered).toHaveLength(1);
  });
});

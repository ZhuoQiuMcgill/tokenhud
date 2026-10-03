// The alert tools over the stdio pipe (T29): set_alert, list_alerts and clear_alert
// payloads, the "not delivered" warning, scopes and groups. T8's reading is real; its
// fetching is mocked.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../../src/alerts/hook.ts";
import type { ProcId } from "../../src/alerts/proc.ts";
import { alertsPath, loadAlerts, recordHookSeen, type SeenBy } from "../../src/alerts/store.ts";
import { HOOK_WARNING, NO_SESSION_WARNING, STALE_WARNING } from "../../src/mcp/alerts.ts";
import { mcpDir } from "../../src/paths.ts";
import type { Root } from "../../src/sources/roots.ts";
import { guard } from "../guard.ts";
import {
  capture,
  cleanup,
  connect,
  HOUR,
  type Machine,
  MIN,
  machine,
  NOW,
  rootNamed,
  SESSION,
  transcript,
  wire,
  writeLimits,
} from "./helpers.ts";

guard();

afterEach(cleanup);

const OTHER = "00000000-0000-4000-8000-000000000002";
const iso = (t: number) => new Date(t).toISOString();

interface Fixture {
  m: Machine;
  personal: Root;
  work: Root;
  refreshed: Array<[string, number]>;
}

/** personal's 5-hour window at `pct` (resets 16:00Z) and weekly at 40 %, captured 30 s ago. */
function fixture(pct = 50): Fixture {
  const m = machine();
  const personal = rootNamed(m, "personal");
  writeLimits(m, {
    [personal.identity]: {
      capture: capture(NOW - 30_000, {
        session: { pct, resetsAt: NOW + HOUR },
        weekly_all: { pct: 40, resetsAt: NOW + 72 * HOUR },
      }),
    },
  });
  return { m, personal, work: rootNamed(m, "work"), refreshed: [] };
}

async function serve(
  f: Fixture,
  env: Record<string, string> = { CLAUDE_CODE_SESSION_ID: SESSION },
) {
  const wiring = wire(f.m, {
    env: { ...f.m.env, ...env },
    claude: null,
    refresh: async (account, maxAgeS) => {
      f.refreshed.push([account, maxAgeS]);
    },
  });
  return { wiring, pipe: await connect(wiring) };
}

const stored = (f: Fixture) => loadAlerts(alertsPath(f.m.env, f.m.home));

/** A hook run in `~/.claude` (personal), in Claude Code process `claude`. */
const seenBy = (f: Fixture, claude: ProcId | null = null): SeenBy => ({
  ppid: 1,
  claude: () => claude,
  root: () => f.personal.identity,
});

describe("set_alert", () => {
  test("arms an alert on this session's account, refreshed first, and warns without the hook", async () => {
    const f = fixture();
    const { pipe } = await serve(f);
    const { value, isError } = await pipe.call("set_alert", {
      window: "5h",
      at: 80,
      note: "pause the refactor and commit",
    });
    expect(isError).toBe(false);
    expect(value).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      scope: "session",
      window: "5h",
      at: 80,
      note: "pause the refactor and commit",
      account: { label: "personal", provider: "claude", group: null, shared_with: [] },
      windows: [
        {
          kind: "session",
          label: "5-HOUR",
          utilization: 0.5,
          resets_at: iso(NOW + HOUR),
          status: "armed",
          fired_at: null,
        },
      ],
      as_of: iso(NOW - 30_000),
      message: "armed: you'll be told when 5-HOUR (now 50%) reaches 80%",
      delivery: { hook_seen_at: null, warning: HOOK_WARNING },
      warnings: [],
    });
    expect(HOOK_WARNING).toBe(
      "alerts are stored but this session hasn't run the tokenhud hook: install the tokenhud plugin, or run `tokenhud mcp install --hooks`",
    );
    expect(f.refreshed).toEqual([[f.personal.identity, 60]]);
    expect(stored(f)).toEqual([
      {
        id: value.id as string,
        created_at: NOW,
        session: SESSION,
        account: {
          id: f.personal.identity,
          label: "personal",
          provider: "claude",
          group: null,
          members: [f.personal.identity],
        },
        window: "5h",
        at: 80,
        note: "pause the refactor and commit",
        delivered: [],
      },
    ]);
  });

  test("a window already over the threshold is said so, and counts as told for this instance", async () => {
    const f = fixture(85);
    recordHookSeen(mcpDir(f.m.env, f.m.home), SESSION, NOW - MIN, seenBy(f));
    const { pipe } = await serve(f);
    const { value } = await pipe.call("set_alert", { window: "any", at: 80 });
    expect(value.windows).toEqual([
      expect.objectContaining({ kind: "session", status: "already_reached", fired_at: iso(NOW) }),
      expect.objectContaining({ kind: "weekly_all", status: "armed", fired_at: null }),
    ]);
    expect(value.message).toBe(
      "5-HOUR is already at 85% (resets at 16:00): at or over 80% already, so that counts as told, and the alert fires for it again only after its reset; armed: you'll be told when WEEKLY (now 40%) reaches 80%",
    );
    // The hook runs in this session: no warning.
    expect(value.delivery).toEqual({ hook_seen_at: iso(NOW - MIN), warning: null });
    expect(stored(f)[0]?.delivered).toEqual([
      { kind: "session", resets_at: NOW + HOUR, at: NOW, on_set: true },
    ]);
  });

  test("no window of that kind, or no limits at all yet: armed, and said so", async () => {
    const f = fixture();
    const { pipe } = await serve(f);
    expect((await pipe.call("set_alert", { window: "weekly_scoped", at: 90 })).value.message).toBe(
      "armed: this account has no model's own weekly window now; the alert fires if one reaches 90%",
    );
    const other = await pipe.call("set_alert", { window: "5h", at: 90, account: "work" });
    expect(other.value.message).toBe(
      "armed: no limits captured for this account yet; the alert fires once a 5-hour window shows 90%",
    );
    expect(other.value.as_of).toBeNull();
  });

  test("scope persistent stores no session; a Codex or signed-out account is warned about", async () => {
    const f = fixture();
    writeLimits(f.m, {
      [f.work.identity]: { status: { signed_in: false, history_only: "detected" } },
    });
    const { pipe } = await serve(f);
    const work = await pipe.call("set_alert", {
      window: "weekly",
      at: 90,
      scope: "persistent",
      account: "work",
    });
    expect(work.value.scope).toBe("persistent");
    expect(work.value.warnings).toEqual([
      "this account is not signed in on this machine: its limits are not refreshed here, so the alert may never fire",
    ]);
    const codex = await pipe.call("set_alert", {
      window: "weekly",
      at: 90,
      scope: "persistent",
      provider: "codex",
    });
    expect(codex.value.warnings).toEqual([
      "only Claude Code sessions run the tokenhud hook, so a persistent alert on a Codex account is never told: use scope session",
    ]);
    expect(stored(f).map((a) => a.session)).toEqual([null, null]);
  });

  test("after /clear, a server follows its Claude Code process to the new session; where it can't, the warning says the id is stale", async () => {
    const f = fixture();
    const mcp = mcpDir(f.m.env, f.m.home);
    const claude = { pid: 4000, start: "777" };
    // The hook ran for the new session in the same Claude Code process and config dir.
    recordHookSeen(mcp, OTHER, NOW + MIN, seenBy(f, claude));
    const followed = wire(f.m, {
      env: { ...f.m.env, CLAUDE_CODE_SESSION_ID: SESSION },
      claude,
      refresh: async () => {},
    });
    const told = await (await connect(followed)).call("set_alert", { window: "5h", at: 80 });
    expect(told.value.delivery).toEqual({ hook_seen_at: iso(NOW + MIN), warning: null });
    expect(stored(f).map((a) => a.session)).toEqual([OTHER]);
    // Unverifiable (Windows): the env's id, and a warning that names the real cause.
    const { pipe } = await serve(f);
    const stale = await pipe.call("set_alert", { window: "5h", at: 90 });
    expect(stale.value.delivery).toEqual({ hook_seen_at: null, warning: STALE_WARNING });
    expect(STALE_WARNING).toContain("after /clear or a resume");
    expect(stored(f).map((a) => a.session)).toEqual([OTHER, SESSION]);
  });

  test("without a session id, a session alert is refused and a persistent one warns", async () => {
    const f = fixture();
    const { pipe } = await serve(f, {});
    const refused = await pipe.call("set_alert", { window: "5h", at: 80 });
    expect(refused.isError).toBe(true);
    expect(refused.value).toEqual({
      error: {
        code: "bad_argument",
        message:
          "this session's id is unknown (Claude Code passes it as CLAUDE_CODE_SESSION_ID), so a session alert could never be told to it: pass scope persistent",
      },
    });
    const kept = await pipe.call("set_alert", { window: "5h", at: 80, scope: "persistent" });
    expect(kept.value.delivery).toEqual({ hook_seen_at: null, warning: NO_SESSION_WARNING });
  });

  test("an account on a group (T16) records its roots; bad arguments are plain errors", async () => {
    const f = fixture();
    writeLimits(f.m, {
      [f.personal.identity]: {
        capture: capture(NOW - 30_000, { session: { pct: 50, resetsAt: NOW + HOUR } }),
      },
    });
    const config = JSON.stringify({ same_account: [[f.personal.identity, f.work.identity]] });
    mkdirSync(join(f.m.xdg, "tokenhud"), { recursive: true });
    writeFileSync(join(f.m.xdg, "tokenhud", "config.json"), config);
    const { pipe } = await serve(f);
    const { value } = await pipe.call("set_alert", { window: "5h", at: 80, account: "work" });
    expect(value.account).toEqual({
      label: "work",
      provider: "claude",
      group: expect.stringMatching(/^[0-9a-f]{32}$/),
      shared_with: ["personal"],
    });
    // The group's capture: personal's, at 50 %.
    expect(value.windows).toEqual([expect.objectContaining({ kind: "session", utilization: 0.5 })]);
    expect(stored(f)[0]?.account.members.sort()).toEqual(
      [f.personal.identity, f.work.identity].sort(),
    );
    for (const [args, text] of [
      [{ window: "monthly", at: 80 }, "window"],
      [{ window: "5h", at: 0 }, "at"],
      [{ window: "5h", at: 101 }, "at"],
      [{ window: "5h", at: 80, note: "x".repeat(201) }, "note"],
      [{ window: "5h", at: 80, scope: "forever" }, "scope"],
      [{ window: "5h", at: 80, account: "nobody" }, "unknown account 'nobody'"],
    ] as const) {
      const result = await pipe.call("set_alert", args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(text);
    }
  });
});

describe("list_alerts and clear_alert", () => {
  async function seeded() {
    const f = fixture();
    const { pipe } = await serve(f);
    const mine = (await pipe.call("set_alert", { window: "5h", at: 80, note: "commit" })).value;
    const kept = (await pipe.call("set_alert", { window: "weekly", at: 90, scope: "persistent" }))
      .value;
    // Another session's alert, set by its own server.
    const { pipe: theirs } = await serve(f, { CLAUDE_CODE_SESSION_ID: OTHER });
    const other = (await theirs.call("set_alert", { window: "5h", at: 50 })).value;
    return { f, pipe, mine, kept, other };
  }

  test("this session's alerts and every persistent one, each armed or fired, from the cache", async () => {
    const { f, pipe, mine, kept } = await seeded();
    // The hook tells this session's alert once the window crosses.
    const path = transcript(f.m.claude);
    writeLimits(f.m, {
      [f.personal.identity]: {
        capture: capture(NOW, {
          session: { pct: 82, resetsAt: NOW + HOUR },
          weekly_all: { pct: 40, resetsAt: NOW + 72 * HOUR },
        }),
      },
    });
    const told = runHook(
      JSON.stringify({
        session_id: SESSION,
        transcript_path: path,
        hook_event_name: "PostToolBatch",
      }),
      { env: f.m.env, home: f.m.home, now: NOW + MIN, ppid: 1, readProc: null, log: () => {} },
    );
    expect(told).toContain("[tokenhud alert] 5-hour limit (personal) is at 82%");
    f.refreshed.length = 0;
    const { value } = await pipe.call("list_alerts");
    expect(f.refreshed).toEqual([]);
    expect(value).toEqual({
      alerts: [
        {
          id: mine.id,
          scope: "session",
          window: "5h",
          at: 80,
          note: "commit",
          account: { label: "personal", provider: "claude" },
          created_at: iso(NOW),
          status: "fired",
          fired_at: iso(NOW + MIN),
          delivered_to: "this session",
          windows: [
            {
              kind: "session",
              label: "5-HOUR",
              utilization: 0.82,
              resets_at: iso(NOW + HOUR),
              status: "fired",
              fired_at: iso(NOW + MIN),
            },
          ],
        },
        {
          id: kept.id,
          scope: "persistent",
          window: "weekly",
          at: 90,
          note: null,
          account: { label: "personal", provider: "claude" },
          created_at: iso(NOW),
          status: "armed",
          fired_at: null,
          delivered_to: "Claude Code sessions on personal",
          windows: [
            {
              kind: "weekly_all",
              label: "WEEKLY",
              utilization: 0.4,
              resets_at: iso(NOW + 72 * HOUR),
              status: "armed",
              fired_at: null,
            },
          ],
        },
      ],
      // The hook ran for this session just now.
      delivery: { hook_seen_at: iso(NOW + MIN), warning: null },
    });
  });

  test("clear by id, then all of this session's, then the persistent ones too", async () => {
    const { f, pipe, mine, kept, other } = await seeded();
    const none = await pipe.call("clear_alert", {});
    expect(none.isError).toBe(true);
    expect(none.text).toBe("pass id (from list_alerts), or all: true");
    // Another session's alert can't be cleared from here.
    const theirs = await pipe.call("clear_alert", { id: other.id });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain(`no alert '${other.id}'`);
    const one = await pipe.call("clear_alert", { id: mine.id });
    expect(one.value).toEqual({
      cleared: [
        {
          id: mine.id,
          scope: "session",
          window: "5h",
          at: 80,
          account: { label: "personal", provider: "claude" },
        },
      ],
      remaining: 1,
    });
    await pipe.call("set_alert", { window: "5h", at: 95 });
    const all = await pipe.call("clear_alert", { all: true });
    expect((all.value.cleared as Array<{ scope: string }>).map((c) => c.scope)).toEqual([
      "session",
    ]);
    expect(all.value.remaining).toBe(1);
    const everything = await pipe.call("clear_alert", { all: true, persistent: true });
    expect((everything.value.cleared as Array<{ id: string }>).map((c) => c.id)).toEqual([
      kept.id as string,
    ]);
    expect(everything.value.remaining).toBe(0);
    // The other session's alert is still there.
    expect(stored(f).map((a) => a.id)).toEqual([other.id as string]);
    const bad = await pipe.call("clear_alert", { id: "x", persistent: true });
    expect(bad.text).toBe("persistent goes with all: true");
  });

  test("the heartbeat records each alert call with this session", async () => {
    const f = fixture();
    const { pipe, wiring } = await serve(f);
    await pipe.call("set_alert", { window: "5h", at: 80 });
    await pipe.call("list_alerts");
    const beat = JSON.parse(readFileSync(wiring.heartbeat.path, "utf8"));
    expect(beat.session).toBe(SESSION);
    expect(
      beat.calls.map((c: { tool: string; account: string | null }) => [c.tool, c.account]),
    ).toEqual([
      ["set_alert", "personal"],
      ["list_alerts", null],
    ]);
  });
});

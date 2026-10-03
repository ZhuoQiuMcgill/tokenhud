// alerts.json and the hook's session records (T29): parsing, locked edits across processes,
// session scope and the 24-hour expiry.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcId } from "../../src/alerts/proc.ts";
import {
  type Alert,
  cleanNote,
  corruptPath,
  currentSession,
  editAlerts,
  expired,
  hookSeenPath,
  loadAlerts,
  prune,
  readAlerts,
  readHookSeen,
  recordHookSeen,
  SESSION_TTL_MS,
  type SeenBy,
  type ServerPlace,
  sessionActivity,
  staleSession,
  sweepHookSeen,
  tryEditAlerts,
} from "../../src/alerts/store.ts";
import { tryLease } from "../../src/limits/lease.ts";
import { guard } from "../guard.ts";
import { cleanup, HOUR, MIN, NOW, SESSION, tempDir } from "../mcp/helpers.ts";

guard();

afterEach(cleanup);

const OTHER = "00000000-0000-4000-8000-000000000002";

function alert(id: string, over: Partial<Alert> = {}): Alert {
  return {
    id,
    created_at: NOW - HOUR,
    session: SESSION,
    account: { id: "acct", label: "personal", provider: "claude", group: null, members: ["acct"] },
    window: "5h",
    at: 80,
    note: null,
    delivered: [],
    ...over,
  };
}

describe("alerts.json", () => {
  test("a missing file has no alerts; a written one reads back as written", () => {
    const path = join(tempDir(), "alerts.json");
    expect(readAlerts(path)).toEqual({ alerts: [], unreadable: false });
    const a = alert("a1", {
      note: "commit first",
      delivered: [{ kind: "session", resets_at: NOW + HOUR, at: NOW, on_set: true }],
    });
    editAlerts(path, (alerts) => {
      alerts.push(a, alert("a2", { session: null, window: "weekly_scoped", at: 95.5 }));
      return true;
    });
    expect(loadAlerts(path)).toEqual([
      a,
      alert("a2", { session: null, window: "weekly_scoped", at: 95.5 }),
    ]);
    expect(JSON.parse(readFileSync(path, "utf8")).alerts[0].delivered).toEqual([
      { kind: "session", resets_at: NOW + HOUR, at: NOW, on_set: true },
    ]);
  });

  test("a malformed file reads as no alerts, and the next write replaces it; bad entries are skipped", () => {
    const path = join(tempDir(), "alerts.json");
    for (const text of ["{ not json", "[]", '{"alerts": 3}', ""]) {
      writeFileSync(path, text);
      expect(readAlerts(path)).toEqual({ alerts: [], unreadable: true });
    }
    writeFileSync(
      path,
      JSON.stringify({
        alerts: [
          alert("ok"),
          { ...alert("bad-window"), window: "monthly" },
          { ...alert("bad-at"), at: 0 },
          { ...alert("bad-session"), session: "../../etc" },
          { ...alert("bad-account"), account: { id: "x", provider: "gemini" } },
          "nonsense",
          { ...alert("bad-delivery"), delivered: [{ kind: "session" }, { kind: 1 }] },
        ],
      }),
    );
    expect(loadAlerts(path).map((a) => [a.id, a.delivered.length])).toEqual([
      ["ok", 0],
      ["bad-delivery", 0],
    ]);
    // An edit of an unreadable file starts it over, even when the edit itself changes nothing.
    writeFileSync(path, "{ not json");
    editAlerts(path, () => false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ alerts: [] });
  });

  test("notes are one line, without control characters, at most 200 characters", () => {
    expect(cleanNote("  pause\nthe\trefactor\u001b[31m  ")).toBe("pause the refactor [31m");
    expect(cleanNote("x".repeat(250))).toHaveLength(200);
    expect(cleanNote("   ")).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
  });

  test("two processes writing at once lose nothing", async () => {
    const path = join(tempDir(), "alerts.json");
    const child = join(import.meta.dir, "writer-child.ts");
    const run = (prefix: string) =>
      Bun.spawn([process.execPath, child, path, prefix, "40"], {
        env: process.env,
        stdout: "ignore",
        stderr: "pipe",
      });
    const [a, b] = [run("a"), run("b")];
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    const ids = loadAlerts(path).map((x) => x.id);
    expect(ids).toHaveLength(80);
    for (const prefix of ["a", "b"]) {
      for (let n = 0; n < 40; n++) expect(ids).toContain(`${prefix}-${n}`);
    }
    // No temp file or lock left behind.
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 30_000);
});

/** What a hook run in Claude Code process `claude` (pid 7000) on config dir "root-a" says. */
function by(ppid: number, claude: ProcId | null = CLAUDE, root: string | null = "root-a"): SeenBy {
  return { ppid, claude: () => claude, root: () => root };
}
const CLAUDE: ProcId = { pid: 7000, start: "1234567" };

describe("sessions", () => {
  test("the hook's record is rewritten at most once a minute, or when its parent changes", () => {
    const mcp = join(tempDir(), "mcp");
    expect(readHookSeen(mcp, SESSION)).toBeNull();
    recordHookSeen(mcp, SESSION, NOW, by(4242));
    expect(readHookSeen(mcp, SESSION)).toEqual({
      session: SESSION,
      seen_at: NOW,
      ppid: 4242,
      claude: CLAUDE,
      root: "root-a",
    });
    recordHookSeen(mcp, SESSION, NOW + 30_000, by(4242));
    expect(readHookSeen(mcp, SESSION)?.seen_at).toBe(NOW);
    recordHookSeen(mcp, SESSION, NOW + 61_000, by(4242));
    expect(readHookSeen(mcp, SESSION)?.seen_at).toBe(NOW + 61_000);
    recordHookSeen(mcp, SESSION, NOW + 62_000, by(777, null, null));
    expect(readHookSeen(mcp, SESSION)).toEqual({
      session: SESSION,
      seen_at: NOW + 62_000,
      ppid: 777,
      claude: null,
      root: null,
    });
    // The process is looked up only when the record is rewritten (macOS asks `ps`).
    let asked = 0;
    recordHookSeen(mcp, SESSION, NOW + 63_000, {
      ppid: 777,
      claude: () => {
        asked++;
        return CLAUDE;
      },
      root: () => "root-a",
    });
    expect(asked).toBe(0);
    // Never a path from a session id.
    expect(readHookSeen(mcp, "../alerts")).toBeNull();
  });

  test("activity: the hook's records and the heartbeats of MCP servers serving a session", () => {
    const mcp = join(tempDir(), "mcp");
    recordHookSeen(mcp, SESSION, NOW - 2 * HOUR, by(1));
    writeFileSync(
      join(mcp, "4242.json"),
      JSON.stringify({ pid: 4242, host: "h", session: SESSION, updated_at: NOW - MIN, calls: [] }),
    );
    writeFileSync(
      join(mcp, "4343.json"),
      JSON.stringify({ pid: 4343, host: "h", session: null, updated_at: NOW, calls: [] }),
    );
    writeFileSync(join(mcp, "4444.json"), "{ damaged");
    recordHookSeen(mcp, OTHER, NOW - 30 * HOUR, by(1));
    expect(sessionActivity(mcp)).toEqual(
      new Map([
        [SESSION, NOW - MIN],
        [OTHER, NOW - 30 * HOUR],
      ]),
    );
    expect(sessionActivity(join(mcp, "missing"))).toEqual(new Map());
  });

  test("session alerts expire after 24 h without activity; persistent ones never do", () => {
    const activity = new Map([[SESSION, NOW - HOUR]]);
    const mine = alert("mine", { created_at: NOW - 3 * SESSION_TTL_MS });
    const quiet = alert("quiet", { session: OTHER, created_at: NOW - SESSION_TTL_MS - MIN });
    const fresh = alert("fresh", { session: OTHER, created_at: NOW - HOUR });
    const kept = alert("kept", { session: null, created_at: NOW - 30 * SESSION_TTL_MS });
    expect([mine, quiet, fresh, kept].map((a) => expired(a, NOW, activity))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // Exactly 24 h is still alive.
    expect(
      expired(alert("edge", { session: OTHER, created_at: NOW - SESSION_TTL_MS }), NOW, activity),
    ).toBe(false);
    // prune drops them, and deliveries of window instances long over.
    mine.delivered = [
      { kind: "session", resets_at: NOW - HOUR, at: NOW - 2 * HOUR },
      { kind: "session", resets_at: NOW - 5 * MIN, at: NOW - HOUR },
      { kind: "weekly_all", resets_at: NOW + HOUR, at: NOW - HOUR },
    ];
    const list = [mine, quiet, fresh, kept];
    expect(prune(list, NOW, activity)).toBe(true);
    expect(list.map((a) => a.id)).toEqual(["mine", "fresh", "kept"]);
    // 5 minutes past a reset is within the instance tolerance: kept until it is long over.
    expect(mine.delivered.map((d) => d.resets_at)).toEqual([NOW - 5 * MIN, NOW + HOUR]);
    expect(prune(list, NOW, activity)).toBe(false);
  });

  test("records of sessions quiet for 24 h are swept", () => {
    const mcp = join(tempDir(), "mcp");
    recordHookSeen(mcp, SESSION, NOW - HOUR, by(1));
    recordHookSeen(mcp, OTHER, NOW - SESSION_TTL_MS - MIN, by(1));
    sweepHookSeen(mcp, NOW);
    expect(existsSync(hookSeenPath(mcp, SESSION))).toBe(true);
    expect(existsSync(hookSeenPath(mcp, OTHER))).toBe(false);
  });

  test("an MCP server follows its Claude Code process (pid and start time) and config dir to a new session; else the env's", () => {
    const mcp = join(tempDir(), "mcp");
    mkdirSync(mcp, { recursive: true });
    const env = { CLAUDE_CODE_SESSION_ID: SESSION };
    const place: ServerPlace = { claude: CLAUDE, root: "root-a", startedAt: NOW };
    expect(currentSession(env, mcp, place)).toBe(SESSION);
    expect(currentSession({}, mcp, place)).toBeNull();
    expect(currentSession({ CLAUDE_CODE_SESSION_ID: "a/b" }, mcp, place)).toBeNull();
    const id = (n: number) => `00000000-0000-4000-8000-00000000001${n}`;
    // Not ours: another Claude Code; the same pid reused by a process started later (or in
    // another container); another config dir; a record from before the server started.
    recordHookSeen(mcp, id(1), NOW + MIN, by(1, { pid: 8000, start: "1234567" }));
    recordHookSeen(mcp, id(2), NOW + MIN, by(1, { pid: 7000, start: "7654321" }));
    recordHookSeen(mcp, id(3), NOW + MIN, by(1, CLAUDE, "root-b"));
    recordHookSeen(mcp, id(4), NOW - MIN, by(1));
    recordHookSeen(mcp, id(5), NOW + 3 * MIN, by(1, null));
    expect(currentSession(env, mcp, place)).toBe(SESSION);
    // After /clear, the same Claude Code runs the hook for a new session.
    recordHookSeen(mcp, OTHER, NOW + 2 * MIN, by(1));
    expect(currentSession(env, mcp, place)).toBe(OTHER);
    // Where the process can't be verified (Windows), the fallback is off.
    expect(currentSession(env, mcp, { ...place, claude: null })).toBe(SESSION);
  });

  test("a stale session id: the hook ran in this config dir since the server started, but not for it", () => {
    const mcp = join(tempDir(), "mcp");
    const place: ServerPlace = { claude: null, root: "root-a", startedAt: NOW };
    expect(staleSession(mcp, SESSION, place)).toBe(false);
    recordHookSeen(mcp, OTHER, NOW - MIN, by(1));
    expect(staleSession(mcp, SESSION, place)).toBe(false);
    recordHookSeen(mcp, "00000000-0000-4000-8000-000000000013", NOW + MIN, by(1, null, "root-b"));
    expect(staleSession(mcp, SESSION, place)).toBe(false);
    recordHookSeen(mcp, OTHER, NOW + MIN, by(2));
    expect(staleSession(mcp, SESSION, place)).toBe(true);
    recordHookSeen(mcp, SESSION, NOW + 2 * MIN, by(3));
    expect(staleSession(mcp, SESSION, place)).toBe(false);
  });
});

describe("a busy lock and a damaged file", () => {
  test("tryEditAlerts gives up within its wait while the lock is held, and edits once it is free", () => {
    const path = join(tempDir(), "alerts.json");
    editAlerts(path, (alerts) => {
      alerts.push(alert("a1"));
      return true;
    });
    const lease = tryLease(`${path}.lock`, 60_000);
    expect(lease).not.toBeNull();
    const t = performance.now();
    expect(tryEditAlerts(path, () => true, { waitMs: 300 })).toBeNull();
    const waited = performance.now() - t;
    expect(waited).toBeGreaterThanOrEqual(290);
    expect(waited).toBeLessThan(1_000);
    lease?.release();
    const after = tryEditAlerts(
      path,
      (alerts) => {
        alerts.splice(0, 1);
        return true;
      },
      { waitMs: 300 },
    );
    expect(after).toEqual([]);
    expect(loadAlerts(path)).toEqual([]);
  });

  test("an unreadable file is moved aside, logged once, and a new one started", () => {
    const dir = tempDir();
    const path = join(dir, "alerts.json");
    writeFileSync(path, "{ not json");
    const logs: string[] = [];
    editAlerts(
      path,
      (alerts) => {
        alerts.push(alert("a1"));
        return true;
      },
      { now: NOW, log: (m) => logs.push(m) },
    );
    expect(logs).toEqual([
      "alerts.json was unreadable; moved it to alerts.json.corrupt-20261001T150000000Z and started a new one",
    ]);
    expect(readFileSync(corruptPath(path, NOW), "utf8")).toBe("{ not json");
    expect(loadAlerts(path).map((a) => a.id)).toEqual(["a1"]);
    editAlerts(path, () => false, { now: NOW + 1, log: (m) => logs.push(m) });
    expect(logs).toHaveLength(1);
  });

  test("temp files a killed writer left are swept on the next write, once a minute old", () => {
    const dir = tempDir();
    const path = join(dir, "alerts.json");
    const old = `${path}.4242.tmp`;
    const recent = `${path}.4343.tmp`;
    writeFileSync(old, "{}");
    writeFileSync(recent, "{}");
    const past = new Date(Date.now() - 2 * MIN);
    utimesSync(old, past, past);
    editAlerts(path, () => true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});

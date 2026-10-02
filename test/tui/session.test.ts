// The view-model Worker's logic, in-process with fake timers: what it posts, when it
// recomputes, and that its engine forgets cached data only when told to.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import { Heartbeat } from "../../src/mcp/heartbeat.ts";
import { rootIdentity } from "../../src/sources/roots.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import {
  Coalescer,
  createQueries,
  RECOMPUTE_INTERVAL_MS,
  type Timers,
  VmSession,
} from "../../src/tui/vm/session.ts";
import type { AccountsVM, OverviewVM, VmMessage, VmStart } from "../../src/tui/vm/types.ts";
import { bundledTable, type Fixture, fixtureConfig, makeFixtureStore, NOW, TZ } from "./fixture.ts";

/** Timers that move only when told to. */
class FakeTimers implements Timers {
  now = 0;
  #seq = 0;
  readonly #queue = new Map<number, { at: number; fn: () => void }>();
  monotonic(): number {
    return this.now;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#queue.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#queue.delete(handle as number);
  }
  /** Runs every timer due by now + ms, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#queue]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#queue.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = end;
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  // Last in, first out: a connection closes before its directory is removed (Windows).
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function harness(over: Partial<VmStart> = {}, fixture?: Fixture) {
  const fx = fixture ?? makeFixtureStore();
  const timers = new FakeTimers();
  const posted: VmMessage[] = [];
  const mcpDir = mkdtempSync(join(tmpdir(), "tokenhud-session-mcp-"));
  const session = new VmSession(
    {
      type: "start",
      storePath: fx.storePath,
      overridesPath: join(fx.dir, "no-overrides.json"),
      mcpDir,
      limitsPath: join(fx.dir, "limits.json"),
      cachePath: join(fx.dir, "cache.db"),
      mode: "owner",
      settings: { tz: TZ, window: "all", scope: null },
      scopeLabel: null,
      config: fixtureConfig(),
      discover: { home: join(fx.dir, "home"), env: {}, wslUsersDir: null } as VmStart["discover"],
      now: NOW,
      ...over,
    },
    (m) => posted.push(m),
    timers,
  );
  cleanups.push(() => {
    session.close();
    fx.remove();
    rmSync(mcpDir, { recursive: true, force: true });
  });
  const views = () => posted.filter((m) => m.type === "views");
  const last = () => {
    const v = views();
    return v[v.length - 1] as Extract<VmMessage, { type: "views" }>;
  };
  return { fx, timers, posted, session, views, last };
}

let key = 1n << 40n;
function newRow(ts: number, identity = "fixture-identity-personal", inp = 1_000_000): UsageRow {
  return {
    key: key++,
    provider: "claude",
    identity,
    label: "personal",
    ts,
    model: "claude-opus-4-8",
    inp,
    outp: 0,
    cr: 0,
    cc: 0,
    e5: null,
    e1: null,
    tier: 0,
  };
}

/** Another connection writes, as the ingest Worker does. */
function write(path: string, rows: UsageRow[]): void {
  const store = openStore(path);
  store.upsert(rows);
  store.close();
}

const todayCost = (m: Extract<VmMessage, { type: "views" }>) =>
  (m.views.overview as OverviewVM).spend.today.cost;

describe("Coalescer", () => {
  test("at most one run per interval, as soon as allowed", () => {
    const timers = new FakeTimers();
    let runs = 0;
    const c = new Coalescer(() => runs++, 250, timers);
    c.request();
    c.request();
    timers.advance(0);
    expect(runs).toBe(1);
    timers.advance(100);
    c.request();
    timers.advance(100);
    expect(runs).toBe(1); // 200 ms since the last run
    timers.advance(50);
    expect(runs).toBe(2); // 250 ms
    timers.advance(1000);
    c.request();
    timers.advance(0);
    expect(runs).toBe(3); // long idle: immediately
  });
});

test("the engine is built with autoInvalidate off: another connection's commit isn't seen until invalidate()", () => {
  const fx = makeFixtureStore();
  cleanups.push(fx.remove);
  const db = openStoreReader(fx.storePath);
  if (db === null) throw new Error("no store");
  cleanups.push(() => db.close());
  const q = createQueries(db, bundledTable(), TZ, () => NOW);
  const before = q.totals({ period: "today" }).usage.tokens.total;
  write(fx.storePath, [newRow(NOW - 60_000)]);
  expect(q.totals({ period: "today" }).usage.tokens.total).toBe(before);
  q.invalidate({ from: NOW - 60_000, to: NOW - 59_999 });
  expect(q.totals({ period: "today" }).usage.tokens.total).toBe(before + 1_000_000);
});

describe("VmSession", () => {
  test("begin: warm, then every view at once, then roots and MCP activity", () => {
    const h = harness();
    h.session.begin();
    expect(h.posted.map((m) => m.type)).toEqual(["views", "roots", "mcp"]);
    expect(Object.keys(h.last().views).sort()).toEqual([
      "accounts",
      "history",
      "models",
      "overview",
    ]);
    expect(h.last().accounts).toHaveLength(5);
    expect(h.posted[2]).toEqual({
      type: "mcp",
      activity: { servers: 0, agents: 0, recent: [], latest: [] },
    });
  });

  test("the Overview's first views already have the limit cards and the MCP agents", () => {
    const fx = makeFixtureStore();
    const home = join(fx.dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const identity = rootIdentity(join(home, ".claude"), home);
    const limitsPath = join(fx.dir, "limits.json");
    const save = (used: number) =>
      saveLimitsCache(
        {
          providers: {
            [identity]: {
              captured_at: (NOW - 60_000) / 1000,
              source: "claude",
              rate_limits: {
                session: { used_percentage: used, resets_at: (NOW + 3_600_000) / 1000 },
              },
            },
          },
          status: {},
        },
        limitsPath,
      );
    save(50);
    const mcpDir = mkdtempSync(join(tmpdir(), "tokenhud-session-mcp-"));
    const beat = new Heartbeat(mcpDir, { pid: process.pid, now: () => Date.now() });
    beat.record("limits", "personal");
    cleanups.push(() => rmSync(mcpDir, { recursive: true, force: true }));
    const h = harness({ limitsPath, mcpDir }, fx);
    h.session.begin();
    expect(h.views()).toHaveLength(1);
    const first = h.last().views.overview as OverviewVM;
    const personal = first.cards?.find((c) => c.label === "personal");
    expect(personal?.fiveHour?.utilization).toBe(0.5);
    expect(first.agents?.calls.map((c) => c.tool)).toEqual(["limits"]);
    expect(h.posted.map((m) => m.type)).toEqual(["views", "roots", "mcp"]);

    // Someone else fetched: limits.json is rewritten. The next tick recomputes the views
    // that show limits, and only those.
    save(70);
    h.session.handle({ type: "tick" });
    h.timers.advance(RECOMPUTE_INTERVAL_MS);
    expect(Object.keys(h.last().views)).toEqual(["overview", "accounts"]);
    const after = (h.last().views.overview as OverviewVM).cards?.find(
      (c) => c.label === "personal",
    );
    expect(after?.fiveHour?.utilization).toBe(0.7);

    // An agent calls a tool: the footer's activity and the agents card both move.
    const views = h.views().length;
    beat.record("should_wait", "personal");
    h.session.handle({ type: "tick" });
    h.timers.advance(RECOMPUTE_INTERVAL_MS);
    expect(h.views()).toHaveLength(views + 1);
    expect((h.last().views.overview as OverviewVM).agents?.calls[0]?.tool).toBe("should_wait");
    // Nothing changed: a tick recomputes nothing.
    h.session.handle({ type: "tick" });
    h.timers.advance(RECOMPUTE_INTERVAL_MS);
    expect(h.views()).toHaveLength(views + 1);
    beat.stop();
  });

  test("a changed message: invalidate that range, recompute off the input path", () => {
    const h = harness();
    h.session.begin();
    const before = todayCost(h.last());
    write(h.fx.storePath, [newRow(NOW - 60_000)]);
    h.session.handle({
      type: "changed",
      fromTs: NOW - 60_000,
      toTs: NOW - 60_000,
      accounts: ["fixture-identity-personal"],
    });
    expect(h.views()).toHaveLength(1); // nothing yet: the recompute is a timer away
    h.timers.advance(0);
    expect(h.views()).toHaveLength(2);
    // 1M input tokens of Opus 4.8 at $5/M.
    expect(todayCost(h.last()) - before).toBeCloseTo(5, 9);
  });

  test("changes are coalesced: at most one recompute per 250 ms", () => {
    const h = harness();
    h.session.begin();
    const change = (ts: number) => {
      write(h.fx.storePath, [newRow(ts)]);
      h.session.handle({
        type: "changed",
        fromTs: ts,
        toTs: ts,
        accounts: ["fixture-identity-personal"],
      });
    };
    change(NOW - 1000);
    h.timers.advance(0);
    expect(h.views()).toHaveLength(2);
    for (let i = 0; i < 5; i++) {
      h.timers.advance(40);
      change(NOW - 2000 - i);
    }
    expect(h.views()).toHaveLength(2);
    h.timers.advance(RECOMPUTE_INTERVAL_MS - 200);
    expect(h.views()).toHaveLength(3); // the five changes in one recompute
    expect(todayCost(h.last()) - todayCost(h.views()[0] as never)).toBeCloseTo(30, 9);
  });

  test("only the views a change touches are recomputed and posted", () => {
    const h = harness();
    h.session.begin();
    const old = Date.parse("2025-06-01T12:00:00Z"); // before the 26 weeks History shows
    write(h.fx.storePath, [newRow(old)]);
    h.session.handle({
      type: "changed",
      fromTs: old,
      toTs: old,
      accounts: ["fixture-identity-personal"],
    });
    h.timers.advance(0);
    expect(Object.keys(h.last().views).sort()).toEqual(["accounts", "models", "overview"]);
  });

  test("owner mode: a commit nobody reported changes nothing (the engine is told, not polled)", () => {
    const h = harness();
    h.session.begin();
    const before = todayCost(h.last());
    write(h.fx.storePath, [newRow(NOW - 60_000)]);
    h.session.handle({ type: "settings", settings: { tz: TZ, window: "all", scope: null } });
    h.timers.advance(0);
    expect(h.views()).toHaveLength(2);
    expect(todayCost(h.last())).toBe(before);
    h.session.handle({ type: "tick" });
    h.timers.advance(0);
    expect(todayCost(h.last())).toBe(before);
  });

  test("reader mode: another process's commit is picked up on the next tick", () => {
    const h = harness({ mode: "reader" });
    h.session.begin();
    const before = todayCost(h.last());
    write(h.fx.storePath, [newRow(NOW - 60_000)]);
    h.session.handle({ type: "tick" });
    h.timers.advance(0);
    expect(todayCost(h.last()) - before).toBeCloseTo(5, 9);
  });

  test("taking over the lock drops every cache: the old owner's last writes were never reported", () => {
    const h = harness({ mode: "reader" });
    h.session.begin();
    const before = todayCost(h.last());
    write(h.fx.storePath, [newRow(NOW - 60_000)]);
    h.session.handle({ type: "mode", mode: "owner" });
    h.timers.advance(0);
    expect(todayCost(h.last()) - before).toBeCloseTo(5, 9);
  });

  test("an import beside the TUI (meta.imports changes) is caught on the tick in owner mode", () => {
    const h = harness();
    h.session.begin();
    const before = todayCost(h.last());
    const store = openStore(h.fx.storePath);
    store.importRows([newRow(NOW - 60_000)], [], [], {
      at: "2026-09-29T15:00:00Z",
      source: "test",
      lineage: null,
      rows: 1,
      accounts: 1,
    });
    store.close();
    h.session.handle({ type: "tick" });
    h.timers.advance(0);
    expect(todayCost(h.last()) - before).toBeCloseTo(5, 9);
  });

  test("a scope filters the views; a change to another account recomputes only the list", () => {
    const h = harness({ scopeLabel: "work" });
    h.session.begin();
    const work = h.last().accounts.find((a) => a.label === "work")?.id;
    expect(h.last().scope).toBe(work as number);
    // Every Overview section is the scoped account's: its all-time spend is the Accounts row's.
    const overview = h.last().views.overview as OverviewVM;
    const row = (h.last().views.accounts as AccountsVM).rows.find((r) => r.label === "work");
    expect(overview.spend.all.tokens).toBe(row?.tokens as number);
    write(h.fx.storePath, [newRow(NOW - 60_000)]);
    h.session.handle({
      type: "changed",
      fromTs: NOW - 60_000,
      toTs: NOW - 60_000,
      accounts: ["fixture-identity-personal"],
    });
    h.timers.advance(0);
    expect(Object.keys(h.last().views)).toEqual(["accounts"]);
  });

  test("no store yet: zeros now, the real store as soon as ingest reports a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "tokenhud-session-empty-"));
    const fx: Fixture = {
      dir,
      storePath: join(dir, "tokenhud.db"),
      remove: () => rmSync(dir, { recursive: true, force: true }),
    };
    const h = harness({}, fx);
    h.session.begin();
    expect((h.last().views.overview as OverviewVM).spend.all.tokens).toBe(0);
    write(fx.storePath, [newRow(NOW - 60_000)]);
    h.session.handle({
      type: "changed",
      fromTs: NOW - 60_000,
      toTs: NOW - 60_000,
      accounts: ["fixture-identity-personal"],
    });
    h.timers.advance(0);
    expect((h.last().views.overview as OverviewVM).spend.all.tokens).toBe(1_000_000);
    expect(h.last().accounts.map((a) => a.label)).toEqual(["personal"]);
  });

  test("a new account in a change reloads the account list", () => {
    const h = harness();
    h.session.begin();
    write(h.fx.storePath, [
      { ...newRow(NOW - 60_000, "fixture-identity-new"), label: "brand-new" },
    ]);
    h.session.handle({
      type: "changed",
      fromTs: NOW - 60_000,
      toTs: NOW - 60_000,
      accounts: ["fixture-identity-new"],
    });
    h.timers.advance(0);
    expect(h.last().accounts.map((a) => a.label)).toContain("brand-new");
    expect(Object.keys(h.last().views)).toHaveLength(4);
  });

  test("nothing is posted after close", () => {
    const h = harness();
    h.session.begin();
    const count = h.posted.length;
    h.session.close();
    h.session.handle({ type: "invalidate" });
    h.timers.advance(1000);
    expect(h.posted).toHaveLength(count);
  });
});

test("a config change re-reads history-only marks and recomputes every view", () => {
  const fx = makeFixtureStore();
  const timers = new FakeTimers();
  const posted: VmMessage[] = [];
  const mcp = mkdtempSync(join(tmpdir(), "tokenhud-session-mcp-"));
  const session = new VmSession(
    {
      type: "start",
      storePath: fx.storePath,
      overridesPath: join(fx.dir, "none.json"),
      mcpDir: mcp,
      limitsPath: join(fx.dir, "limits.json"),
      cachePath: join(fx.dir, "cache.db"),
      mode: "owner",
      settings: { tz: TZ, window: "all", scope: null },
      scopeLabel: null,
      config: fixtureConfig(),
      discover: { home: join(fx.dir, "home"), env: {}, wslUsersDir: null } as VmStart["discover"],
      now: NOW,
    },
    (m) => posted.push(m),
    timers,
  );
  cleanups.push(() => {
    session.close();
    fx.remove();
    rmSync(mcp, { recursive: true, force: true });
  });
  session.begin();
  session.handle({
    type: "config",
    config: fixtureConfig({ history_only_roots: ["fixture-identity-work"] }),
  });
  timers.advance(0);
  const last = posted.filter((m) => m.type === "views").at(-1) as Extract<
    VmMessage,
    { type: "views" }
  >;
  expect(last.accounts.filter((a) => a.historyOnly).map((a) => a.label)).toEqual(["work"]);
  expect(Object.keys(last.views)).toHaveLength(4);
  expect(posted.filter((m) => m.type === "roots")).toHaveLength(2);
});

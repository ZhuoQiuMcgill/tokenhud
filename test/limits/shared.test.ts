// Roots on one subscription account (T16) in the limits service and reader: one fetch per
// group per round plus verification, fail-over to another signed-in member, auto-detection
// over real rounds (jittered resets, an MCP refresh between rounds, a root that switches
// account), events once per group, and the group's windows with its members' spend summed.
// Fetchers are mocked and the clock is the harness's.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig, liveConfig, saveConfig } from "../../src/config.ts";
import { leasePath, loadLimitsCache, saveLimitsCache } from "../../src/limits/cache.ts";
import { type Capture, LimitFetchError, SignedOut } from "../../src/limits/capture.ts";
import { spendFromQueries } from "../../src/limits/derive.ts";
import { dedupeEvents, readLimitEvents, recordCaptureEvents } from "../../src/limits/events.ts";
import {
  groupId,
  type ManualLinks,
  manualLinks,
  NO_LINKS,
  pairKey,
} from "../../src/limits/groups.ts";
import { Limits } from "../../src/limits/index.ts";
import { tryLease } from "../../src/limits/lease.ts";
import { LimitsService, type LimitsServiceOptions } from "../../src/limits/service.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { UsageQueries } from "../../src/query/engine.ts";
import type { Root } from "../../src/sources/roots.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { capture, cleanup, fakeRoot, tempDir } from "./helpers.ts";

guard();

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  cleanup();
});

const T0 = Date.parse("2026-10-01T12:00:00Z");
const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
/** Whole-minute and whole-hour resets, before the provider's jitter. */
const FIVE_HOUR = (T0 + 3 * 3_600_000) / 1000;
const WEEK = (T0 + 4 * 86_400_000) / 1000;
/** Per-request jitter of the reset times, within the ±0.7 s seen live (seconds). */
const JITTER = [0.337, -0.153, 0.66, -0.5, 0.12, -0.69, 0.5, 0.01, -0.35, 0.41];

/**
 * The account both roots are signed in to, as of `ms`: its 5-hour use grows 1 % a minute
 * (an account in use), and each request's resets carry their own jitter.
 */
function account(ms: number, request: number): Capture {
  const j = (i: number) => JITTER[i % JITTER.length] as number;
  return capture("claude", ms / 1000, {
    session: {
      pct: 20 + Math.floor((ms - T0) / MIN),
      resets: FIVE_HOUR + j(request),
      label: "5-HOUR",
    },
    weekly_all: { pct: 40, resets: WEEK + j(request + 3), label: "WEEKLY" },
  });
}

/** Another account: other use, other resets. */
const other = (ms: number) =>
  capture("claude", ms / 1000, {
    session: { pct: 3, resets: FIVE_HOUR + 7200, label: "5-HOUR" },
    weekly_all: { pct: 11, resets: WEEK - 86_400, label: "WEEKLY" },
  });

/** A service over fake Claude roots with a mocked fetcher and a hand-driven clock. */
function harness(roots: Root[], over: Partial<LimitsServiceOptions> = {}) {
  const dir = tempDir();
  const clock = { now: T0 };
  const calls: string[] = [];
  let requests = 0;
  const state = {
    links: NO_LINKS as ManualLinks,
    fetch: (async () => account(clock.now, requests)) as (root: Root) => Promise<Capture>,
    /** Credential-file mtimes by label (1 unless set). */
    mtimes: new Map<string, number>(),
    recorded: [] as [string, number, string[]][],
  };
  const limitsPath = join(dir, "limits.json");
  const service = new LimitsService({
    limitsPath,
    roots: () => roots,
    fetchClaude: (root) => {
      calls.push(root.label);
      requests++;
      return state.fetch(root);
    },
    credentialsMtime: (root) => state.mtimes.get(root.label) ?? 1,
    links: () => state.links,
    recordEvents: (root, c, shared) =>
      state.recorded.push([
        root.label,
        (c.captured_at * 1000 - T0) / MIN,
        shared.map((r) => r.label),
      ]),
    now: () => clock.now,
    ...over,
  });
  const file = () => loadLimitsCache(limitsPath);
  const limits = () =>
    new Limits({
      limitsPath,
      roots: () => roots,
      db: null,
      spend: null,
      links: () => state.links,
      now: () => clock.now,
    });
  /** Scheduled rounds at each of `minutes` after T0. */
  const rounds = async (...minutes: number[]) => {
    for (const m of minutes) {
      clock.now = T0 + m * MIN;
      await service.refreshDue();
    }
  };
  return { service, clock, calls, state, file, limits, limitsPath, rounds };
}

const pair = () => [
  fakeRoot("claude", "personal-like", "/home/x/.claude", { source: "auto" }),
  fakeRoot("claude", "win-like", "/mnt/c/Users/x/.claude", { source: "wsl" }),
];

const p_ = "personal-like";
const w_ = "win-like";

describe("fetch economy: one fetch per group per round, plus verification", () => {
  test("linked once the use moved on both, then one fetch a round; the other member every 30 min", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    await h.rounds(0, 5, 10, 15, 20, 25, 30, 35, 40);
    // Rounds 0 and 5 fetch both (the use moved 20 → 25 % on both: linked), then one a round.
    // win-like was last asked at 5: it is verified, back to back, at 35.
    expect(h.calls).toEqual([p_, w_, p_, w_, p_, p_, p_, p_, p_, p_, w_, p_]);
    const file = h.file();
    const id = groupId([p.identity, w.identity]);
    expect(file.groups?.[p.identity]).toEqual({ id, detected_at: T0 + 5 * MIN, source: "auto" });
    expect(file.groups?.[w.identity]?.id).toBe(id);
    expect(file.pairs?.[pairKey(p.identity, w.identity)]).toMatchObject({
      linked: true,
      disagree: 0,
    });
    // Both read the group's windows: the freshest capture.
    const shown = h.limits().getLimits();
    expect(shown.map((l) => l.as_of)).toEqual([T0 + 40 * MIN, T0 + 40 * MIN]);
    expect(shown.map((l) => l.group?.members.map((m) => m.label))).toEqual([
      [p_, w_],
      [p_, w_],
    ]);
  });

  test("a switched root unlinks after two verifications, and shows apart from the first", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    await h.rounds(0, 5, 10, 15);
    // win-like is now signed in to another account.
    h.state.fetch = async (root) => (root === w ? other(h.clock.now) : account(h.clock.now, 0));
    await h.rounds(20, 25, 30);
    expect(h.limits().getLimits(w.identity)?.group).not.toBeNull();
    await h.rounds(35);
    // The verification at 35 disagreed: suspended, so each root shows its own limits now.
    const key = pairKey(p.identity, w.identity);
    expect(h.file().pairs?.[key]).toMatchObject({ linked: true, disagree: 1 });
    const own = h.limits().getLimits(w.identity);
    expect(own?.group).toBeNull();
    expect(own?.windows.map((x) => x.utilization)).toEqual([0.03, 0.11]);
    // Next round both are fetched on their own: the second mismatch unlinks.
    await h.rounds(40);
    expect(h.file().pairs?.[key]).toMatchObject({ linked: false, disagree: 2 });
    expect(h.file().groups?.[w.identity]).toBeUndefined();
    expect(h.calls.slice(-4)).toEqual([p_, w_, p_, w_]);
  });

  test("a credential file that changes has its root verified at once", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    await h.rounds(0, 5, 10);
    expect(h.calls).toEqual([p_, w_, p_, w_, p_]);
    // win-like signs in again (another account, say): its credential file changes. The
    // group isn't due until 15, but is fetched and verified at the next round.
    h.state.mtimes.set(w_, 2);
    await h.rounds(12);
    expect(h.calls).toEqual([p_, w_, p_, w_, p_, p_, w_]);
    // Recorded after that fetch: no further verification until 30 minutes on.
    await h.rounds(17, 22);
    expect(h.calls.slice(7)).toEqual([p_, p_]);
  });

  test("an MCP refresh between rounds no longer desyncs the pair", async () => {
    // The critic's case: the 5-hour use rises 1 % a minute, and an on-demand refresh of
    // personal-like 2 minutes into each 5-minute cycle shifts its schedule off its partner's.
    // Its partner is fetched back to back, so the pair compared is seconds apart.
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    for (let cycle = 0; cycle < 24; cycle++) {
      await h.rounds(cycle * 5);
      h.clock.now = T0 + (cycle * 5 + 2) * MIN;
      await h.service.refresh(p_, 60);
    }
    const state = h.file().pairs?.[pairKey(p.identity, w.identity)];
    expect(state).toMatchObject({ linked: true, disagree: 0 });
    expect(
      h
        .limits()
        .getLimits(w.identity)
        ?.group?.members.map((m) => m.label),
    ).toEqual([p_, w_]);
    // Two minutes, 24 cycles: one fetch a cycle once linked, plus verification.
    expect(h.calls.length).toBeLessThanOrEqual(24 + 2 + 2 * 5);
  });

  test("the cross-process lease is the group's, not a member's", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    const ttl = 2 * MIN;
    // Another process fetching personal-like alone doesn't hold the group back...
    const member = tryLease(leasePath(h.limitsPath, p.identity), ttl, () => h.clock.now);
    await h.service.refresh(null, 0);
    member?.release();
    // (win-like, never asked yet, is verified right after.)
    expect(h.calls).toEqual([p_, w_]);
    // ...while one fetching the group does, for either member.
    h.clock.now += 5 * MIN;
    const group = tryLease(
      leasePath(h.limitsPath, groupId([p.identity, w.identity])),
      ttl,
      () => h.clock.now,
    );
    expect(group).not.toBeNull();
    await h.service.refresh(w_, 0);
    await h.service.refreshDue();
    expect(h.calls).toEqual([p_, w_]);
    group?.release();
    await h.service.refresh(w_, 0);
    expect(h.calls).toEqual([p_, w_, p_]);
  });

  test("a manual link: one fetch a round from the first; the next round is 5 minutes off", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    // The member that isn't fetched must not make every round due at once.
    expect(await h.service.refreshDue()).toBe(5 * MIN);
    h.clock.now += 5 * MIN;
    expect(await h.service.refreshDue()).toBe(5 * MIN);
    expect(h.calls).toEqual([p_, w_, p_]);
    expect(h.file().groups?.[w.identity]?.source).toBe("manual");
  });

  test("a manual link whose roots disagree is kept, and says so", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    h.state.fetch = async (root) => (root === w ? other(h.clock.now) : account(h.clock.now, 0));
    await h.rounds(0, 5);
    const shown = h.limits().getLimits(w.identity);
    expect(shown?.group).toMatchObject({ source: "manual", differs: true });
    // The group's limits stay those of the member fetched for it.
    expect(shown?.windows.map((x) => x.utilization)).toEqual([0.25, 0.4]);
  });

  test("a server error fails over to the other signed-in member", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    h.state.fetch = async (root) => {
      if (root === p) throw new LimitFetchError("Claude usage fetch failed: HTTP 500");
      return account(h.clock.now, 0);
    };
    const outcomes = await h.service.refresh(null, 0);
    expect(h.calls).toEqual([p_, w_]);
    expect(outcomes).toEqual([
      { account: p.identity, fetched: true, error: null },
      { account: w.identity, fetched: true, error: null },
    ]);
    // The account's data came through win-like; personal-like shows it too.
    const personal = h.limits().getLimits(p.identity);
    expect(personal?.windows[0]?.utilization).toBe(0.2);
    expect(personal?.error).toBeNull();
    expect(h.file().status[p.identity]).toMatchObject({ errors: 1, signed_in: true });
    // Next round the member that worked goes first: one fetch.
    h.clock.now += 5 * MIN;
    await h.service.refreshDue();
    expect(h.calls).toEqual([p_, w_, w_]);
  });

  test.each([
    ["a 429", "Claude usage fetch failed: HTTP 429"],
    ["a time-out", "Claude usage fetch failed: timed out"],
  ])("%s backs off the whole group: no fail-over", async (_, message) => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    h.state.fetch = async (root) => {
      if (root === p) throw new LimitFetchError(message);
      return account(h.clock.now, 0);
    };
    await h.service.refresh(null, 0);
    expect(h.calls).toEqual([p_]);
    // 10 s on, the back-off (30 s) still holds for both members, on demand too.
    h.clock.now += 10 * S;
    expect(await h.service.refreshDue()).toBe(20 * S);
    expect((await h.service.refresh(w_, 0))[0]?.fetched).toBe(false);
    expect(h.calls).toEqual([p_]);
    // After it, the group is asked again, through the member that didn't fail.
    h.clock.now += 20 * S;
    await h.service.refreshDue();
    expect(h.calls).toEqual([p_, w_]);
  });

  test("when every member fails, the group shows the last error and keeps its data", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    await h.service.refreshDue();
    h.state.fetch = async () => {
      throw new LimitFetchError("Claude usage fetch failed: HTTP 503");
    };
    h.clock.now += 5 * MIN;
    await h.service.refreshDue();
    expect(h.calls).toEqual([p_, w_, p_, w_]);
    const shown = h.limits().getLimits(w.identity);
    expect(shown?.as_of).toBe(T0);
    expect(shown?.error).toBe("Claude usage fetch failed: HTTP 503");
  });

  test("a member not signed in here never hides the group, and is re-checked", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    let signedIn = false;
    h.state.fetch = async (root) => {
      if (root === p && !signedIn) throw new SignedOut("no Claude credentials in this config dir");
      return account(h.clock.now, 0);
    };
    await h.rounds(0, 5);
    // personal-like is history-only now; the group is still fetched once a round.
    expect(h.calls).toEqual([p_, w_, w_]);
    const shown = h.limits().getLimits(p.identity);
    expect(shown?.account.signed_in).toBe(true);
    expect(shown?.as_of).toBe(T0 + 5 * MIN);
    expect(h.file().status[p.identity]?.history_only).toBe("detected");
    // It signs in again: its credential file changes, and the group's next fetch checks it.
    signedIn = true;
    h.state.mtimes.set(p_, 2);
    await h.rounds(7);
    expect(h.calls).toEqual([p_, w_, w_, w_, p_]);
    expect(h.file().status[p.identity]).toMatchObject({ signed_in: true, history_only: null });
  });

  test("a history-only member (config) in a group: fetched through the other", async () => {
    const p = fakeRoot("claude", p_, "/home/x/.claude", { historyOnly: true });
    const w = fakeRoot("claude", w_, "/mnt/c/Users/x/.claude", { source: "wsl" });
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    await h.service.refreshDue();
    expect(h.calls).toEqual([w_]);
    expect(h.limits().getLimits(p.identity)?.account.signed_in).toBe(true);
  });

  test("on demand from either member: fresh group data is not fetched again", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    await h.service.refresh(w_, 60);
    h.clock.now += 40 * S;
    expect((await h.service.refresh(p_, 60))[0]?.fetched).toBe(false);
    expect((await h.service.refresh(w_, 60))[0]?.fetched).toBe(false);
    h.clock.now += 30 * S;
    const [outcome] = await h.service.refresh(w_, 60);
    expect(outcome).toEqual({ account: w.identity, fetched: true, error: null });
    expect(h.calls).toEqual([p_, w_, p_]);
  });

  test("two Codex homes on one ChatGPT account are fetched once too", async () => {
    const c = fakeRoot("codex", "codex-like", "/home/x/.codex", { source: "auto" });
    const d = fakeRoot("codex", "codex-win-like", "/mnt/c/Users/x/.codex", { source: "wsl" });
    const calls: string[] = [];
    const h = harness([c, d], {
      usesRpc: () => true,
      fetchCodex: async (root) => {
        calls.push(root.label);
        return capture("codex", h.clock.now / 1000, {
          codex_primary: {
            pct: 12 + Math.floor((h.clock.now - T0) / MIN),
            resets: (T0 + 7_200_000) / 1000,
            minutes: 300,
          },
        });
      },
    });
    await h.rounds(0, 5, 10);
    expect(calls).toEqual([
      "codex-like",
      "codex-win-like",
      "codex-like",
      "codex-win-like",
      "codex-like",
    ]);
  });
});

describe("limit events: once per group window", () => {
  test("recorded from the group's capture, under one member, with the others shared", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    await h.rounds(0, 5, 10);
    // Round 0 fetched both (win-like's first verification): still one record a round.
    expect(h.state.recorded).toEqual([
      [p_, 0, [w_]],
      [p_, 5, [w_]],
      [p_, 10, [w_]],
    ]);
  });

  test("a member's open `reached` is resumed by the group, and no instance is recorded twice", () => {
    const [p, w] = pair() as [Root, Root];
    const dbPath = join(tempDir(), "tokenhud.db");
    const store = openStore(dbPath);
    try {
      const full = (root: Root, ms: number, pct: number, resets: number) =>
        recordCaptureEvents(
          store,
          root,
          capture("claude", ms / 1000, {
            session: { pct, resets: resets / 1000, label: "5-HOUR" },
          }),
          root === p ? [w] : [],
        );
      const reset = T0 + HOUR;
      // Before the link, win-like saw the 5-hour window full.
      expect(full(w, T0, 100, reset)).toBe(1);
      // personal-like, linked, sees the same instance full: nothing new.
      expect(full(p, T0 + 5 * MIN, 100, reset + 400)).toBe(0);
      // After the reset, personal-like's capture resumes win-like's event.
      expect(full(p, reset + MIN, 4, reset + 5 * HOUR)).toBe(2);
      const db = openStoreReader(dbPath) as Database;
      open.push(db);
      const events = readLimitEvents(db, { from: 0, to: Number.MAX_SAFE_INTEGER });
      expect(events.map((e) => [e.account.label, e.kind, e.resumed_at])).toEqual([
        [w_, "reached", reset + MIN],
        [p_, "resumed", null],
      ]);
    } finally {
      store.close();
    }
  });

  test("readers show an instance recorded under two members once", () => {
    const event = (
      id: string,
      label: string,
      at: number,
      resetsAt: number,
      resumed: number | null,
    ) => ({
      account: { id, label, provider: "claude" },
      kind: "reached" as const,
      window: "session",
      label: "5-HOUR",
      resets_at: resetsAt,
      at,
      resumed_at: resumed,
    });
    const events = [
      event("p", p_, 1, T0, null),
      event("w", w_, 2, T0 + 0.7 * S, T0 + MIN),
      event("x", "work-like", 3, T0, null),
      event("w", w_, 4, T0 + 5 * HOUR, null),
    ];
    const groupOf = (id: string) => (id === "x" ? null : "g");
    expect(dedupeEvents(events, groupOf)).toEqual([
      { ...event("p", p_, 1, T0, null), resumed_at: T0 + MIN },
      event("x", "work-like", 3, T0, null),
      event("w", w_, 4, T0 + 5 * HOUR, null),
    ]);
  });
});

describe("groups in limits.json across processes", () => {
  test("a process that sees fewer roots never flips the record; links come from config.json", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    const configFile = join(tempDir(), "config.json");
    saveConfig({ ...defaultConfig(), same_account: [[p.identity, w.identity]] }, configFile);
    const read = liveConfig(configFile);
    const links = () => manualLinks(read());
    // The TUI's Worker sees both roots; an MCP server sees only personal-like.
    const worker = new LimitsService({
      limitsPath: h.limitsPath,
      roots: () => [p, w],
      fetchClaude: async () => account(h.clock.now, 0),
      credentialsMtime: () => 1,
      links,
      now: () => h.clock.now,
    });
    const mcp = new LimitsService({
      limitsPath: h.limitsPath,
      roots: () => [p],
      fetchClaude: async () => account(h.clock.now, 0),
      credentialsMtime: () => 1,
      links,
      now: () => h.clock.now,
    });
    const id = groupId([p.identity, w.identity]);
    const record = { id, detected_at: T0, source: "manual" as const };
    for (let k = 0; k < 4; k++) {
      h.clock.now = T0 + k * 5 * MIN;
      await worker.refreshDue();
      h.clock.now += 2 * MIN;
      await mcp.refresh(p_, 60);
      expect(h.file().groups).toEqual({ [p.identity]: record, [w.identity]: record });
    }
    // An unlink saved to config.json is seen by both at their next call.
    saveConfig({ ...defaultConfig(), separate_accounts: [[w.identity, p.identity]] }, configFile);
    h.clock.now += 5 * MIN;
    await worker.refreshDue();
    expect(h.file().groups).toEqual({});
  });
});

describe("combined pace and projection", () => {
  // claude-opus-4-8 output is $25 per 1M tokens: a row of 20,000 output tokens is $0.50.
  let key = 1n;
  const opus = (root: Root, iso: string): UsageRow => ({
    key: key++,
    provider: "claude",
    identity: root.identity,
    label: root.label,
    ts: Date.parse(iso),
    model: "claude-opus-4-8",
    inp: 0,
    outp: 20_000,
    cr: 0,
    cc: 0,
    e5: null,
    e1: null,
    tier: 0,
  });
  const NOW = Date.parse("2026-09-30T14:00:00Z");
  const s = (iso: string) => Date.parse(iso) / 1000;

  /** Two roots with usage; linked by hand when `linked`. */
  function setup(linked: boolean) {
    const dir = tempDir();
    const [p, w] = pair() as [Root, Root];
    const store = openStore(join(dir, "tokenhud.db"));
    store.upsert([
      ...["11:30", "13:20", "13:40", "13:50"].map((t) => opus(p, `2026-09-30T${t}:00Z`)),
      ...["13:45", "13:58", "14:00"].map((t) => opus(w, `2026-09-30T${t}:00Z`)),
    ]);
    store.close();
    const db = openStoreReader(join(dir, "tokenhud.db")) as Database;
    open.push(db);
    const queries = new UsageQueries(db, new PriceTable(bundledPricing().models), {
      tz: "UTC",
      now: () => NOW,
    });
    const limitsPath = join(dir, "limits.json");
    saveLimitsCache(
      {
        providers: {
          [p.identity]: capture("claude", s("2026-09-30T13:55:00Z"), {
            session: { pct: 30, resets: s("2026-09-30T16:00:00Z"), label: "5-HOUR" },
            weekly_all: { pct: 0.5, resets: s("2026-10-03T00:00:00Z"), label: "WEEKLY" },
          }),
          // An older capture of the same account: the group shows the freshest.
          [w.identity]: capture("claude", s("2026-09-30T13:50:00Z"), {
            session: { pct: 28, resets: s("2026-09-30T16:00:00Z"), label: "5-HOUR" },
          }),
        },
        status: {},
      },
      limitsPath,
    );
    const limits = new Limits({
      limitsPath,
      roots: () => [p, w],
      db,
      spend: spendFromQueries(queries),
      links: () => (linked ? { same: [[p.identity, w.identity]], separate: [] } : NO_LINKS),
      now: () => NOW,
    });
    return { limits, p, w };
  }

  test("each root alone: its own spend", () => {
    const { limits } = setup(false);
    // Pace window [13:30, 14:00]: personal-like 13:40, 13:50 ($1.00); win-like 13:45,
    // 13:58, 14:00 ($1.50).
    expect(limits.getLimits("personal-like")?.pace).toEqual({
      cost_per_h: 2,
      tokens_per_h: 80_000,
    });
    expect(limits.getLimits("win-like")?.pace).toEqual({ cost_per_h: 3, tokens_per_h: 120_000 });
  });

  test("linked: both members get the sum, and a projection from the combined spend", () => {
    const { limits, p, w } = setup(true);
    for (const root of [p, w]) {
      const got = limits.getLimits(root.identity);
      // $1.00 + $1.50 in the last 30 minutes = $5/h, the sum of $2/h and $3/h.
      expect(got?.pace).toEqual({ cost_per_h: 5, tokens_per_h: 200_000 });
      expect(got?.as_of).toBe(Date.parse("2026-09-30T13:55:00Z"));
      const session = got?.windows.find((x) => x.kind === "session");
      expect(session?.utilization).toBe(0.3);
      expect(session?.pace_cost_per_h).toBe(5);
      // 5-hour window from 11:00. Spent to the 13:55 capture: 11:30, 13:20, 13:40, 13:50
      // and 13:45 = $2.50 at 30 %: 0.12 per dollar. Since: 13:58 and 14:00 = $1.00, so
      // 42 % now. 0.58 / (0.12 * $5/h) = 0.9667 h = 58 min: 14:58.
      expect(session?.projected_exhaustion_at).toBe(Date.parse("2026-09-30T14:58:00Z"));
      // Weekly: $2.50 at 0.5 %, 0.7 % now; 0.993 / (0.002 * 5) = 99.3 h, after Oct 3: safe.
      expect(got?.windows.find((x) => x.kind === "weekly_all")?.projected_exhaustion_at).toBe(
        "safe",
      );
      expect(got?.group).toMatchObject({ source: "manual" });
    }
  });
});

// Roots on one subscription account (T16) in the limits service and reader: one fetch per
// group per round, failing over to another signed-in member, auto-detection over real
// rounds, and the group's windows with its members' spend summed. Fetchers are mocked and
// the clock is the harness's.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { leasePath, loadLimitsCache, saveLimitsCache } from "../../src/limits/cache.ts";
import { type Capture, LimitFetchError, SignedOut } from "../../src/limits/capture.ts";
import { spendFromQueries } from "../../src/limits/derive.ts";
import { groupId, type ManualLinks, NO_LINKS } from "../../src/limits/groups.ts";
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

/** The account both roots are signed in to: its windows, as of `ms`. */
const account = (ms: number, pct = 26) =>
  capture("claude", ms / 1000, {
    session: { pct, resets: (T0 + 3 * 3_600_000) / 1000 + 0.25, label: "5-HOUR" },
    weekly_all: { pct: 69, resets: (T0 + 4 * 86_400_000) / 1000, label: "WEEKLY" },
  });

/** A service over fake Claude roots with a mocked fetcher and a hand-driven clock. */
function harness(roots: Root[], over: Partial<LimitsServiceOptions> = {}) {
  const dir = tempDir();
  const clock = { now: T0 };
  const calls: string[] = [];
  const state = {
    links: NO_LINKS as ManualLinks,
    fetch: (async () => account(clock.now)) as (root: Root) => Promise<Capture>,
  };
  const limitsPath = join(dir, "limits.json");
  const service = new LimitsService({
    limitsPath,
    roots: () => roots,
    fetchClaude: (root) => {
      calls.push(root.label);
      return state.fetch(root);
    },
    credentialsMtime: () => 1,
    links: () => state.links,
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
  return { service, clock, calls, state, file, limits, limitsPath };
}

const pair = () => [
  fakeRoot("claude", "personal-like", "/home/x/.claude", { source: "auto" }),
  fakeRoot("claude", "win-like", "/mnt/c/Users/x/.claude", { source: "wsl" }),
];

describe("fetch economy: one fetch per group per round", () => {
  test("auto-detected over two rounds, then one fetch a round through the first member", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    for (let round = 0; round < 4; round++) {
      await h.service.refreshDue();
      h.clock.now += 5 * MIN;
    }
    // Rounds 1 and 2 fetch both (the second pair confirms the link); 3 and 4 fetch one.
    expect(h.calls).toEqual([
      "personal-like",
      "win-like",
      "personal-like",
      "win-like",
      "personal-like",
      "personal-like",
    ]);
    const file = h.file();
    const id = groupId([p.identity, w.identity]);
    expect(file.groups?.[p.identity]).toEqual({ id, detected_at: T0 + 5 * MIN, source: "auto" });
    expect(file.groups?.[w.identity]?.id).toBe(id);
    // Both read the group's windows: the freshest capture, fetched through personal-like.
    const shown = h.limits().getLimits();
    expect(shown.map((l) => l.as_of)).toEqual([T0 + 15 * MIN, T0 + 15 * MIN]);
    expect(shown.map((l) => l.group?.members.map((m) => m.label))).toEqual([
      ["personal-like", "win-like"],
      ["personal-like", "win-like"],
    ]);
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
    expect(h.calls).toEqual(["personal-like"]);
    // ...while one fetching the group does, for either member.
    h.clock.now += 5 * MIN;
    const group = tryLease(
      leasePath(h.limitsPath, groupId([p.identity, w.identity])),
      ttl,
      () => h.clock.now,
    );
    expect(group).not.toBeNull();
    await h.service.refresh("win-like", 0);
    await h.service.refreshDue();
    expect(h.calls).toEqual(["personal-like"]);
    group?.release();
    await h.service.refresh("win-like", 0);
    expect(h.calls).toEqual(["personal-like", "personal-like"]);
  });

  test("a manual link fetches once from the first round; the next round is 5 minutes off", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    // The member that is never fetched must not make every round due at once.
    expect(await h.service.refreshDue()).toBe(5 * MIN);
    h.clock.now += 5 * MIN;
    expect(await h.service.refreshDue()).toBe(5 * MIN);
    expect(h.calls).toEqual(["personal-like", "personal-like"]);
    expect(h.file().groups?.[w.identity]?.source).toBe("manual");
  });

  test("a transient failure fails over to the other signed-in member", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    h.state.fetch = async (root) => {
      if (root === p) throw new LimitFetchError("Claude usage fetch failed: HTTP 500");
      return account(h.clock.now, 31);
    };
    const outcomes = await h.service.refresh(null, 0);
    expect(h.calls).toEqual(["personal-like", "win-like"]);
    expect(outcomes).toEqual([
      { account: p.identity, fetched: true, error: null },
      { account: w.identity, fetched: true, error: null },
    ]);
    // The account's data came through win-like; personal-like shows it too.
    const personal = h.limits().getLimits(p.identity);
    expect(personal?.windows[0]?.utilization).toBe(0.31);
    expect(personal?.error).toBeNull();
    expect(h.file().status[p.identity]).toMatchObject({ errors: 1, signed_in: true });
    // Next round the member that worked goes first: one fetch.
    h.clock.now += 5 * MIN;
    await h.service.refreshDue();
    expect(h.calls).toEqual(["personal-like", "win-like", "win-like"]);
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
    expect(h.calls).toEqual(["personal-like", "personal-like", "win-like"]);
    const shown = h.limits().getLimits(w.identity);
    expect(shown?.as_of).toBe(T0);
    expect(shown?.error).toBe("Claude usage fetch failed: HTTP 503");
  });

  test("a member not signed in here never hides the group: it fetches through another", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    h.state.fetch = async (root) => {
      if (root === p) throw new SignedOut("no Claude credentials in this config dir");
      return account(h.clock.now);
    };
    await h.service.refreshDue();
    h.clock.now += 5 * MIN;
    await h.service.refreshDue();
    // personal-like is history-only now; the group is still fetched once a round.
    expect(h.calls).toEqual(["personal-like", "win-like", "win-like"]);
    const shown = h.limits().getLimits(p.identity);
    expect(shown?.account.signed_in).toBe(true);
    expect(shown?.as_of).toBe(T0 + 5 * MIN);
    expect(h.file().status[p.identity]?.history_only).toBe("detected");
  });

  test("a history-only member (config) in a group: fetched through the other", async () => {
    const p = fakeRoot("claude", "personal-like", "/home/x/.claude", { historyOnly: true });
    const w = fakeRoot("claude", "win-like", "/mnt/c/Users/x/.claude", { source: "wsl" });
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    await h.service.refreshDue();
    expect(h.calls).toEqual(["win-like"]);
    expect(h.limits().getLimits(p.identity)?.account.signed_in).toBe(true);
  });

  test("on demand from either member: fresh group data is not fetched again", async () => {
    const [p, w] = pair() as [Root, Root];
    const h = harness([p, w]);
    h.state.links = { same: [[p.identity, w.identity]], separate: [] };
    await h.service.refresh("win-like", 60);
    h.clock.now += 40 * S;
    expect((await h.service.refresh("personal-like", 60))[0]?.fetched).toBe(false);
    expect((await h.service.refresh("win-like", 60))[0]?.fetched).toBe(false);
    h.clock.now += 30 * S;
    const [outcome] = await h.service.refresh("win-like", 60);
    expect(outcome).toEqual({ account: w.identity, fetched: true, error: null });
    expect(h.calls).toEqual(["personal-like", "personal-like"]);
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
          codex_primary: { pct: 12, resets: (T0 + 7_200_000) / 1000, minutes: 300 },
        });
      },
    });
    for (let round = 0; round < 3; round++) {
      await h.service.refreshDue();
      h.clock.now += 5 * MIN;
    }
    expect(calls).toEqual([
      "codex-like",
      "codex-win-like",
      "codex-like",
      "codex-win-like",
      "codex-like",
    ]);
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

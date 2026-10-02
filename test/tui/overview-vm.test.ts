// The Overview's view model against an independent oracle: each row priced on its own with
// the pricing module, summed over hand-computed ranges, and the limits arithmetic redone by
// hand from those sums. The query layer's exactness is T6's and the projections' T8's; this
// checks the view model asks them the right questions and decides the cards' verdicts by
// its stated rules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import type { UsageRow } from "../../src/store/store.ts";
import { ACTIVITY, activityRange } from "../../src/tui/vm/overview.ts";
import type { LimitCard, OverviewVM } from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";
import { bundledTable, FIXTURE_ACCOUNTS, NOW } from "./fixture.ts";
import {
  CAPTURES,
  MCP,
  makeOverviewFixture,
  type OverviewFixture,
  overviewRows,
} from "./overview-fixture.ts";

guard();

const rows = overviewRows();
const table = bundledTable();
const MIN = 60_000;
const HOUR = 60 * MIN;
let fx: OverviewFixture;
let vm: OverviewVM;
let ids: Map<string, number>;

beforeAll(() => {
  fx = makeOverviewFixture();
  vm = fx.overview();
  ids = new Map(fx.views().accounts.map((a) => [a.label, a.id]));
});
afterAll(() => fx.remove());

function oracle(from: number, to: number, keep: (r: UsageRow) => boolean = () => true) {
  let cost = 0;
  let tokens = 0;
  for (const r of rows) {
    if (r.ts < from || r.ts >= to || !keep(r)) continue;
    tokens += r.inp + r.outp + r.cr + r.cc;
    const c = table.cost({
      model: r.model,
      tier: r.tier === 1 ? "fast" : "standard",
      atMs: r.ts,
      input: r.inp,
      output: r.outp,
      cacheRead: r.cr,
      cacheCreation: r.cc,
      ephemeral5m: r.e5,
      ephemeral1h: r.e1,
    });
    if (typeof c === "number") cost += c;
  }
  return { cost, tokens };
}

const of = (label: string) => {
  const identity = FIXTURE_ACCOUNTS.find((a) => a.label === label)?.identity;
  return (r: UsageRow) => r.identity === identity;
};
const spent = (label: string, from: number, to: number) => oracle(from, to, of(label)).cost;

function close(actual: number, expected: number, digits = 6) {
  expect(Math.abs(actual - expected)).toBeLessThan(10 ** -digits);
}

function card(label: string): LimitCard {
  return (vm.cards ?? []).find((c) => c.label === label) as LimitCard;
}

// NOW is Tue 2026-09-29 11:40 EDT (15:40Z), worked out by hand.
const TODAY = { from: Date.parse("2026-09-29T04:00:00Z"), to: Date.parse("2026-09-30T04:00:00Z") };
const WEEK = { from: Date.parse("2026-09-28T04:00:00Z"), to: Date.parse("2026-10-05T04:00:00Z") };
const MONTH = { from: Date.parse("2026-09-01T04:00:00Z"), to: Date.parse("2026-10-01T04:00:00Z") };

describe("spend", () => {
  test("rolling 1 h and 5 h up to now, then today, this week, this month, all-time", () => {
    for (const [column, range] of [
      ["1h", { from: NOW - HOUR, to: NOW + 1 }],
      ["5h", { from: NOW - 5 * HOUR, to: NOW + 1 }],
      ["today", TODAY],
      ["this_week", WEEK],
      ["this_month", MONTH],
      ["all", { from: 0, to: Number.MAX_SAFE_INTEGER }],
    ] as const) {
      const want = oracle(range.from, range.to);
      close(vm.spend[column].cost, want.cost);
      expect(vm.spend[column].tokens).toBe(want.tokens);
    }
    expect(vm.spend["1h"].cost).toBeGreaterThan(0);
  });
});

describe("activity", () => {
  test("5 h by the minute, 24 h by 5 minutes, 7 days by the hour, each ending in the bucket holding now", () => {
    const ranges = {
      "5h": { from: Date.parse("2026-09-29T10:41:00Z"), to: Date.parse("2026-09-29T15:41:00Z") },
      "24h": { from: Date.parse("2026-09-28T15:45:00Z"), to: Date.parse("2026-09-29T15:45:00Z") },
      "7d": { from: Date.parse("2026-09-22T16:00:00Z"), to: Date.parse("2026-09-29T16:00:00Z") },
    } as const;
    for (const window of ["5h", "24h", "7d"] as const) {
      const range = ranges[window];
      const series = vm.activity[window];
      expect(activityRange(NOW, window)).toEqual(range);
      expect(series.from).toBe(range.from);
      expect(series.bucketMs).toBe(ACTIVITY[window].bucket);
      expect(series.cost).toHaveLength((range.to - range.from) / ACTIVITY[window].bucket);
      series.cost.forEach((cost, i) => {
        const from = range.from + i * series.bucketMs;
        const want = oracle(from, from + series.bucketMs);
        close(cost, want.cost);
        expect(series.tokens[i]).toBe(want.tokens);
      });
    }
  });
});

describe("top models", () => {
  test("over the 24 h chart: at most 5, by cost with cost shares, and by tokens with token shares", () => {
    const day = activityRange(NOW, "24h");
    const total = oracle(day.from, day.to);
    expect(vm.topModels.length).toBeGreaterThan(0);
    expect(vm.topModels.length).toBeLessThanOrEqual(5);
    for (const m of vm.topModels) {
      const tier = m.tier === "fast" ? 1 : 0;
      const want = oracle(day.from, day.to, (r) => r.model === m.model && r.tier === tier);
      close(m.cost, want.cost);
      close(m.share, want.cost / total.cost);
    }
    const costs = vm.topModels.map((m) => m.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    for (const m of vm.topModelsByTokens) {
      const tier = m.tier === "fast" ? 1 : 0;
      const want = oracle(day.from, day.to, (r) => r.model === m.model && r.tier === tier);
      expect(m.tokens).toBe(want.tokens);
      close(m.share, want.tokens / total.tokens);
    }
    const counts = vm.topModelsByTokens.map((m) => m.tokens);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe("limit cards", () => {
  test("one per enabled account, in root order, with its store account", () => {
    expect((vm.cards ?? []).map((c) => c.label)).toEqual(FIXTURE_ACCOUNTS.map((a) => a.label));
    for (const c of vm.cards ?? []) expect(c.account).toBe(ids.get(c.label) as number);
  });

  test("meters are the account-wide 5-hour and weekly windows; a model's own weekly isn't one", () => {
    const personal = card("personal");
    expect(personal.fiveHour).toEqual({ utilization: 0.78, resetsAt: NOW + 108 * MIN });
    expect(personal.week).toEqual({ utilization: 0.27, resetsAt: NOW + 102 * HOUR });
    expect(card("codex").week).toEqual({ utilization: 0.83, resetsAt: NOW + 1145 * MIN });
    expect(personal.capturedAt).toBe(NOW - 2 * MIN);
    expect(card("work").capturedAt).toBe(NOW - 47 * MIN);
  });

  test("the pace is the last 30 minutes' spend, per hour", () => {
    for (const c of vm.cards ?? []) {
      const want = oracle(NOW - 30 * MIN, NOW + 1, of(c.label));
      close(c.pace.cost, want.cost * 2);
      expect(c.pace.tokens).toBe(want.tokens * 2);
    }
    expect(card("personal").pace.cost).toBeGreaterThan(1);
  });

  test("personal hits 100 % at the earlier of its windows' projections, worked by hand", () => {
    const capture = NOW - 2 * MIN;
    const pace = card("personal").pace.cost;
    const at = (u: number, resets: number, windowMs: number) => {
      const k = u / spent("personal", resets - windowMs, capture);
      const now = u + k * spent("personal", capture, NOW + 1);
      return NOW + ((1 - now) / (k * pace)) * HOUR;
    };
    const fiveHour = at(0.78, NOW + 108 * MIN, 5 * HOUR);
    expect(fiveHour).toBeLessThan(NOW + 108 * MIN);
    const verdict = card("personal").verdict;
    expect(verdict.kind).toBe("hits");
    // The weekly window's projection, if any, comes later than the 5-hour one.
    if (verdict.kind === "hits") expect(Math.abs(verdict.at - fiveHour)).toBeLessThan(1);
  });

  test("codex's week ends high but under 100 %: its projected share, worked by hand", () => {
    const capture = NOW - MIN;
    const resets = NOW + 1145 * MIN;
    const pace = card("codex").pace.cost;
    const k = 0.83 / spent("codex", resets - 7 * 24 * HOUR, capture);
    const end = 0.83 + k * spent("codex", capture, NOW + 1) + k * pace * ((resets - NOW) / HOUR);
    expect(end).toBeGreaterThanOrEqual(0.8);
    expect(end).toBeLessThan(1);
    const verdict = card("codex").verdict;
    expect(verdict.kind).toBe("week");
    if (verdict.kind === "week") close(verdict.utilization, end, 9);
  });

  test("codex-win lasts to its resets; work and the history-only account are idle", () => {
    expect(card("codex-win").verdict).toEqual({ kind: "safe" });
    expect(card("work").verdict).toEqual({ kind: "idle" });
    const old = card("old-laptop");
    expect(old.signedIn).toBe(false);
    expect(old.verdict).toEqual({ kind: "idle" });
    expect([old.fiveHour, old.week, old.capturedAt]).toEqual([null, null, null]);
  });

  test("a window at 100 %: full until the last full window resets; no data to project: unknown", () => {
    saveLimitsCache(
      {
        providers: {
          ...CAPTURES,
          "fixture-identity-personal": {
            captured_at: (NOW - MIN) / 1000,
            source: "claude",
            rate_limits: {
              session: { used_percentage: 100, resets_at: (NOW + 30 * MIN) / 1000 },
              weekly_all: { used_percentage: 100, resets_at: (NOW + 50 * HOUR) / 1000 },
            },
          },
          // A 5-hour window only, with under $0.50 spent in it: nothing to project from.
          "fixture-identity-codex": {
            captured_at: (NOW - MIN) / 1000,
            source: "codex",
            rate_limits: {
              codex_primary: {
                used_percentage: 8,
                resets_at: (NOW + 290 * MIN) / 1000,
                window_minutes: 300,
              },
            },
          },
        },
        status: {},
      },
      fx.limitsPath,
    );
    try {
      const other = fx.overview();
      const find = (label: string) => (other.cards ?? []).find((c) => c.label === label);
      expect(find("personal")?.verdict).toEqual({ kind: "full", until: NOW + 50 * HOUR });
      expect(spent("codex", NOW - 10 * MIN, NOW - MIN)).toBeLessThan(0.5);
      expect(find("codex")?.verdict).toEqual({ kind: "unknown" });
      expect(find("codex")?.week).toBeNull();
    } finally {
      saveLimitsCache({ providers: { ...CAPTURES }, status: {} }, fx.limitsPath);
    }
  });
});

describe("limit events and agents", () => {
  test("the last 7 days of limit events, newest first, under the accounts' labels", () => {
    const t = (iso: string) => Date.parse(iso);
    expect(vm.events).toEqual([
      {
        at: t("2026-09-29T13:30:00Z"),
        account: "work",
        kind: "reached",
        window: "5-HOUR",
        resetsAt: t("2026-09-29T14:00:00Z"),
        resumedAt: null,
      },
      {
        at: t("2026-09-28T20:05:00Z"),
        account: "personal",
        kind: "resumed",
        window: "5-HOUR",
        resetsAt: t("2026-09-29T01:05:00Z"),
        resumedAt: null,
      },
      {
        at: t("2026-09-28T18:10:00Z"),
        account: "personal",
        kind: "reached",
        window: "5-HOUR",
        resetsAt: t("2026-09-28T20:00:00Z"),
        resumedAt: t("2026-09-28T20:05:00Z"),
      },
      {
        at: t("2026-09-28T01:10:00Z"),
        account: "codex",
        kind: "passed_80",
        window: "WEEKLY",
        resetsAt: t("2026-09-30T10:45:00Z"),
        resumedAt: null,
      },
      {
        at: t("2026-09-25T16:57:00Z"),
        account: "personal",
        kind: "resumed",
        window: "5-HOUR",
        resetsAt: t("2026-09-25T21:57:00Z"),
        resumedAt: null,
      },
      {
        at: t("2026-09-25T15:05:00Z"),
        account: "personal",
        kind: "reached",
        window: "5-HOUR",
        resetsAt: t("2026-09-25T16:00:00Z"),
        resumedAt: t("2026-09-25T16:57:00Z"),
      },
    ]);
  });

  test("each MCP agent session's latest call; no card without an MCP server", () => {
    expect(vm.agents).toEqual({ servers: 2, calls: MCP.latest });
    expect(fx.overview(null, { mcp: null }).agents).toBeNull();
    const idle = { servers: 0, agents: 0, recent: [], latest: [] };
    expect(fx.overview(null, { mcp: idle }).agents).toBeNull();
    const quiet = { ...idle, servers: 1 };
    expect(fx.overview(null, { mcp: quiet }).agents).toEqual({ servers: 1, calls: [] });
  });
});

describe("account scope", () => {
  test("every section is the scoped account's: card, spend, activity, events, agents", () => {
    const scoped = fx.overview(ids.get("work") as number);
    expect((scoped.cards ?? []).map((c) => c.label)).toEqual(["work"]);
    close(scoped.spend.this_week.cost, oracle(WEEK.from, WEEK.to, of("work")).cost);
    const day = activityRange(NOW, "24h");
    close(
      scoped.activity["24h"].cost.reduce((a, b) => a + b, 0),
      oracle(day.from, day.to, of("work")).cost,
    );
    expect(scoped.events.map((e) => e.account)).toEqual(["work"]);
    expect(scoped.agents?.calls.map((c) => c.account)).toEqual(["work"]);
  });
});

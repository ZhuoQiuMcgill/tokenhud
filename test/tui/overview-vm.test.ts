// The Overview's view model against an independent oracle: each row priced on its own with
// the pricing module, summed over hand-computed ranges, and the limits arithmetic redone by
// hand from those sums. The query layer's exactness is T6's and the projections' T8's; this
// checks the view model asks them the right questions and decides the cards' verdicts by
// its stated rules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { saveLimitsCache } from "../../src/limits/cache.ts";
import type { SpendSource } from "../../src/limits/derive.ts";
import type { AccountLimits, LimitWindow } from "../../src/limits/index.ts";
import { Zone } from "../../src/query/tz.ts";
import type { UsageRow } from "../../src/store/store.ts";
import { ACTIVITY, activityRange, limitCard } from "../../src/tui/vm/overview.ts";
import type { AccountInfo, LimitCard, OverviewVM } from "../../src/tui/vm/types.ts";
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

  test("the pace is the verdict's: a weekly window's average, else the last 30 minutes", () => {
    for (const c of vm.cards ?? []) {
      if (c.label === "codex") continue;
      expect(c.pace.basis).toBe("30m");
      const want = oracle(NOW - 30 * MIN, NOW + 1, of(c.label));
      close(c.pace.cost, want.cost * 2);
      expect(c.pace.tokens).toBe(want.tokens * 2);
    }
    expect(card("personal").pace.cost).toBeGreaterThan(1);
    // codex's verdict is its week's (T18): the spend since that window began, 148 h 55 min
    // ago, per hour.
    const codex = card("codex").pace;
    const start = NOW + 1145 * MIN - 7 * 24 * HOUR;
    const want = oracle(start, NOW + 1, of("codex"));
    expect(codex.basis).toBe("window_avg");
    close(codex.cost, want.cost / ((NOW - start) / HOUR));
    close(codex.tokens, want.tokens / ((NOW - start) / HOUR));
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
    // The weekly window's projection, if any, comes later than the 5-hour one, whose time
    // is shown to the minute.
    if (verdict.kind === "hits") {
      expect(Math.abs(verdict.at - fiveHour)).toBeLessThan(1);
      expect(verdict.rough).toBeNull();
    }
  });

  test("codex's week ends high but under 100 %: its projected share, worked by hand", () => {
    const capture = NOW - MIN;
    const resets = NOW + 1145 * MIN;
    // At the week's average pace (checked above).
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
    expect(card("work").verdict).toEqual({ kind: "idle", high: null });
    const old = card("old-laptop");
    expect(old.signedIn).toBe(false);
    expect(old.verdict).toEqual({ kind: "idle", high: null });
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

describe("a card's verdict and pace, window by window (T18)", () => {
  // The user's case, synthetic and rounded (test/limits/derive.test.ts works it through
  // T8): Fri Oct 2, 11:00 in Toronto; the week began Wed 05:00 and resets next Wed 05:00.
  const now = Date.parse("2026-10-02T15:00:00Z");
  const reset = Date.parse("2026-10-07T09:00:00Z");
  const toronto = Zone.of("America/Toronto");
  const acct: AccountInfo = {
    id: 7,
    label: "burst-like",
    provider: "claude",
    identity: "00000000000000000000000000000007",
    historyOnly: false,
  };
  const byIdentity = new Map([[acct.identity, acct]]);
  /** USD spent at each instant: $820 on Wednesday, and by default a $60 burst just now. */
  const spendOf = (spends: readonly (readonly [number, number])[]): SpendSource => ({
    pace: () => ({ costPerHour: 0, tokensPerHour: 0 }),
    rate: () => ({ costPerHour: 0, tokensPerHour: 0 }),
    cost: (_, from, to) =>
      spends.filter(([t]) => t >= from && t < to).reduce((sum, [, usd]) => sum + usd, 0),
  });
  const BURST = spendOf([
    [Date.parse("2026-09-30T20:00:00Z"), 820],
    [now - 25 * MIN, 20],
    [now - 15 * MIN, 20],
    [now - 5 * MIN, 20],
  ]);
  const five = (over: Partial<LimitWindow> = {}): LimitWindow => ({
    kind: "session",
    label: "5-HOUR",
    utilization: 0.3,
    resets_at: now + 2 * HOUR,
    window_s: 5 * 3600,
    pace_cost_per_h: 120,
    pace_tokens_per_h: 4_800_000,
    pace_basis: "30m",
    projected_exhaustion_at: "safe",
    stale_s: 60,
    ...over,
  });
  const week = (over: Partial<LimitWindow> = {}): LimitWindow => ({
    kind: "weekly_all",
    label: "WEEKLY",
    utilization: 0.48,
    resets_at: reset,
    window_s: 7 * 24 * 3600,
    pace_cost_per_h: 880 / 54,
    pace_tokens_per_h: (880 * 40_000) / 54,
    pace_basis: "window_avg",
    projected_exhaustion_at: Date.parse("2026-10-05T01:30:00Z"),
    stale_s: 60,
    ...over,
  });
  const limits = (windows: LimitWindow[], pace = 120): AccountLimits => ({
    account: { id: acct.identity, label: acct.label, provider: "claude", signed_in: true },
    group: null,
    windows,
    as_of: now - MIN,
    source: "api",
    error: null,
    pace: { cost_per_h: pace, tokens_per_h: pace * 40_000 },
  });
  const cardOf = (l: AccountLimits, spend = BURST) => limitCard(l, byIdentity, spend, now, toronto);

  test("the week's 100 % at its average pace, as a part of a day: ~Sun evening", () => {
    const c = cardOf(limits([five(), week()]));
    expect(c.verdict).toEqual({
      kind: "hits",
      at: Date.parse("2026-10-05T01:30:00Z"),
      rough: "~Sun evening",
    });
    // The pace shown is the one the verdict comes from: the week's average, not the burst's.
    expect(c.pace).toEqual({
      cost: 880 / 54,
      tokens: (880 * 40_000) / 54,
      basis: "window_avg",
    });
  });

  test("the 5-hour window filling first: its 30-minute pace, and a time to the minute", () => {
    const c = cardOf(limits([five({ projected_exhaustion_at: now + 70 * MIN }), week()]));
    expect(c.verdict).toEqual({ kind: "hits", at: now + 70 * MIN, rough: null });
    expect(c.pace).toEqual({ cost: 120, tokens: 4_800_000, basis: "30m" });
  });

  test("a weekly window under 6 hours old: the 30-minute pace, the time still coarse", () => {
    const young = week({
      resets_at: now - 5 * HOUR + 7 * 24 * HOUR,
      pace_cost_per_h: 120,
      pace_tokens_per_h: 4_800_000,
      pace_basis: "30m",
      // Sat 03:10 in Toronto: Friday night.
      projected_exhaustion_at: now + (16 * 60 + 10) * MIN,
    });
    const c = cardOf(limits([five(), young]));
    expect(c.verdict).toEqual({ kind: "hits", at: now + 970 * MIN, rough: "~tonight" });
    expect(c.pace.basis).toBe("30m");
  });

  test("a quiet half hour no longer hides where the week is heading", () => {
    // Nothing in the last 30 minutes, but $6 an hour on average this week: 0.48 + (0.48 /
    // 880) * 6 * 114 h to the reset = 85.3 %.
    const quiet = spendOf([[Date.parse("2026-09-30T20:00:00Z"), 880]]);
    const c = cardOf(
      limits(
        [
          five({ projected_exhaustion_at: null, pace_cost_per_h: 0 }),
          week({ pace_cost_per_h: 6, projected_exhaustion_at: "safe" }),
        ],
        0,
      ),
      quiet,
    );
    expect(c.verdict.kind).toBe("week");
    if (c.verdict.kind === "week") close(c.verdict.utilization, 0.48 + (0.48 / 880) * 6 * 114, 12);
    expect(c.pace.basis).toBe("window_avg");
  });

  test("idle with a window at 80 % or more names the fullest; otherwise just idle", () => {
    // Used elsewhere: 83 % on the meter, $0.30 on this machine, too little to project.
    const elsewhere = spendOf([[Date.parse("2026-09-30T20:00:00Z"), 0.3]]);
    const idle = (fiveHour: number, weekly: number) =>
      cardOf(
        limits(
          [
            five({ utilization: fiveHour, projected_exhaustion_at: null, pace_cost_per_h: 0 }),
            week({ utilization: weekly, projected_exhaustion_at: null, pace_cost_per_h: 0.01 }),
          ],
          0,
        ),
        elsewhere,
      );
    expect(idle(0.3, 0.83).verdict).toEqual({
      kind: "idle",
      high: { window: "week", utilization: 0.83 },
    });
    expect(idle(0.85, 0.83).verdict).toEqual({
      kind: "idle",
      high: { window: "5h", utilization: 0.85 },
    });
    expect(idle(0.3, 0.79).verdict).toEqual({ kind: "idle", high: null });
    expect(idle(0.3, 0.83).pace).toEqual({ cost: 0, tokens: 0, basis: "30m" });
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

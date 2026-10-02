// View models against an independent oracle: each row priced on its own with the pricing
// module, summed over hand-computed Toronto boundaries. The query layer's exactness is
// T6's; this checks the view models ask it the right questions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UsageRow } from "../../src/store/store.ts";
import {
  ALL_TIME,
  activityRange,
  affectedViews,
  changeRange,
  overlaps,
} from "../../src/tui/vm/compute.ts";
import type {
  AccountRow,
  AccountsVM,
  HistoryDay,
  HistoryVM,
  ModelsVM,
  OverviewVM,
  ViewModels,
} from "../../src/tui/vm/types.ts";
import {
  bundledTable,
  FIXTURE_ACCOUNTS,
  type Fixture,
  fixtureConfig,
  fixtureRows,
  fixtureViews,
  makeFixtureStore,
  NOW,
} from "./fixture.ts";

const rows = fixtureRows();
const table = bundledTable();
let fixture: Fixture;
let views: ViewModels;
let accountIds: Map<string, number>;

beforeAll(() => {
  fixture = makeFixtureStore(rows);
  const out = fixtureViews(fixture.storePath);
  views = out.views;
  accountIds = new Map(out.accounts.map((a) => [a.label, a.id]));
});
afterAll(() => fixture.remove());

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

// NOW is Tue 2026-09-29 11:40 EDT (UTC-4), worked out by hand:
const TODAY = { from: Date.parse("2026-09-29T04:00:00Z"), to: Date.parse("2026-09-30T04:00:00Z") };
const WEEK = { from: Date.parse("2026-09-28T04:00:00Z"), to: Date.parse("2026-10-05T04:00:00Z") };
const MONTH = { from: Date.parse("2026-09-01T04:00:00Z"), to: Date.parse("2026-10-01T04:00:00Z") };
// The activity chart's 24 h end at the next 20-minute edge after 15:40Z.
const DAY24 = { from: Date.parse("2026-09-28T16:00:00Z"), to: Date.parse("2026-09-29T16:00:00Z") };

function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
}

describe("Overview", () => {
  test("spend: today, this week, this month, all-time", () => {
    const vm = views.overview as OverviewVM;
    for (const [period, range] of [
      ["today", TODAY],
      ["this_week", WEEK],
      ["this_month", MONTH],
      ["all", { from: 0, to: Number.MAX_SAFE_INTEGER }],
    ] as const) {
      const want = oracle(range.from, range.to);
      close(vm.spend[period].cost, want.cost);
      expect(vm.spend[period].tokens).toBe(want.tokens);
    }
    expect(vm.spend.today.cost).toBeGreaterThan(0);
  });

  test("activity: 72 buckets of 20 minutes ending at the next 20-minute edge", () => {
    const vm = views.overview as OverviewVM;
    expect(activityRange(NOW)).toEqual(DAY24);
    expect(vm.activity.from).toBe(DAY24.from);
    expect(vm.activity.bucketMs).toBe(20 * 60_000);
    expect(vm.activity.cost).toHaveLength(72);
    for (let i = 0; i < 72; i++) {
      const from = DAY24.from + i * 20 * 60_000;
      const want = oracle(from, from + 20 * 60_000);
      close(vm.activity.cost[i] as number, want.cost);
      expect(vm.activity.tokens[i]).toBe(want.tokens);
    }
  });

  test("top models over the chart's 24 h: at most 5, most cost first, shares of that cost", () => {
    const vm = views.overview as OverviewVM;
    expect(vm.topModels.length).toBeLessThanOrEqual(5);
    expect(vm.topModels.length).toBeGreaterThan(0);
    const total = oracle(DAY24.from, DAY24.to).cost;
    for (const m of vm.topModels) {
      const tier = m.tier === "fast" ? 1 : 0;
      const want = oracle(DAY24.from, DAY24.to, (r) => r.model === m.model && r.tier === tier);
      close(m.cost, want.cost);
      close(m.share, want.cost / total);
    }
    const costs = vm.topModels.map((m) => m.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  test("one entry per account, the history-only one marked, today and 24 h per account", () => {
    const vm = views.overview as OverviewVM;
    // In store id order, which is the store's to choose.
    expect(vm.accounts.map((a) => a.label).sort()).toEqual(
      FIXTURE_ACCOUNTS.map((a) => a.label).sort(),
    );
    expect(vm.accounts.map((a) => a.id)).toEqual(
      [...vm.accounts.map((a) => a.id)].sort((x, y) => x - y),
    );
    expect(vm.accounts.filter((a) => a.historyOnly).map((a) => a.label)).toEqual(["old-laptop"]);
    for (const a of vm.accounts) {
      const identity = FIXTURE_ACCOUNTS.find((f) => f.label === a.label)?.identity;
      const mine = (r: UsageRow) => r.identity === identity;
      close(a.today.cost, oracle(TODAY.from, TODAY.to, mine).cost);
      close(a.last24h.cost, oracle(DAY24.from, DAY24.to, mine).cost);
    }
  });

  test("a scope filters every section to that account", () => {
    const work = accountIds.get("work") as number;
    const scoped = fixtureViews(fixture.storePath, fixtureConfig(), work).views
      .overview as OverviewVM;
    const mine = (r: UsageRow) => r.identity === "fixture-identity-work";
    expect(scoped.accounts.map((a) => a.label)).toEqual(["work"]);
    close(scoped.spend.this_week.cost, oracle(WEEK.from, WEEK.to, mine).cost);
    close(
      scoped.activity.cost.reduce((a, b) => a + b, 0),
      oracle(DAY24.from, DAY24.to, mine).cost,
    );
  });
});

describe("History", () => {
  test("26 Monday-first weeks ending with this week; nothing after today", () => {
    const vm = views.history as HistoryVM;
    expect(vm.weeks).toBe(26);
    expect(vm.days).toHaveLength(182);
    // This week starts Mon Sep 28; 25 weeks (175 days) earlier is Mon Apr 6.
    expect(vm.days[0]?.key).toBe("2026-04-06");
    expect(vm.today).toBe(25 * 7 + 1);
    expect(vm.days[vm.today]?.key).toBe("2026-09-29");
    expect(vm.days.slice(vm.today + 1)).toEqual([null, null, null, null, null]);
  });

  test("each day is its local day's usage", () => {
    const vm = views.history as HistoryVM;
    for (const [i, offset] of [
      [vm.today, 0],
      [vm.today - 1, 1],
      [vm.today - 30, 30],
    ] as const) {
      const day = vm.days[i] as HistoryDay;
      // EDT all along these dates: local midnight is 04:00Z.
      const from = TODAY.from - offset * 86_400_000;
      const want = oracle(from, from + 86_400_000);
      close(day.cost, want.cost);
      expect(day.tokens).toBe(want.tokens);
    }
    // The fixture starts 60 days back: older days are empty, not missing.
    expect(vm.days[0]).toEqual({
      key: "2026-04-06",
      cost: 0,
      tokens: 0,
      pricedShare: 1,
      estimatedCost: 0,
      input: 0,
      output: 0,
      cache: 0,
      topModel: null,
    });
  });
});

describe("Models", () => {
  test("per model and tier over the window; unpriced and fast rows kept; a total", () => {
    const vm = views.models as ModelsVM;
    expect(vm.window).toBe("all");
    const keys = vm.rows.map((r) => `${r.model}/${r.tier}`);
    expect(keys).toContain("claude-opus-4-8/fast");
    const mystery = vm.rows.find((r) => r.model === "claude-mystery-9");
    expect(mystery).toMatchObject({ status: "unpriced", cost: 0, rates: null });
    close(
      vm.rows.reduce((a, r) => a + r.cost, 0),
      vm.total.cost,
    );
    close(vm.total.cost, oracle(0, Number.MAX_SAFE_INTEGER).cost);
    expect(vm.pricedShare).toBeLessThan(1);
    expect(
      vm.rows.find((r) => r.model === "claude-opus-4-8" && r.tier === "standard")?.rates,
    ).not.toBeNull();
  });
});

describe("Accounts", () => {
  test("all accounts, most cost first, first/last seen, a 30-day daily sparkline", () => {
    const vm = views.accounts as AccountsVM;
    expect(vm.rows).toHaveLength(5);
    const costs = vm.rows.map((r) => r.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    for (const row of vm.rows) {
      const identity = FIXTURE_ACCOUNTS.find((f) => f.label === row.label)?.identity;
      const mine = rows.filter((r) => r.identity === identity).map((r) => r.ts);
      expect(row.firstSeen).toBe(Math.min(...mine));
      expect(row.lastSeen).toBe(Math.max(...mine));
      expect(row.spark).toHaveLength(30);
      close(
        row.spark[29] as number,
        oracle(TODAY.from, TODAY.to, (r) => r.identity === identity).cost,
      );
    }
    // The history-only account stopped 20 days ago: its last 19 days are zero.
    const old = vm.rows.find((r) => r.label === "old-laptop") as AccountRow;
    expect(old.historyOnly).toBe(true);
    expect(old.spark.slice(-19).every((v) => v === 0)).toBe(true);
  });
});

describe("which views a change affects", () => {
  const deps = new Map([
    ["overview", { deps: [TODAY, DAY24, ALL_TIME] }],
    ["history", { deps: [{ from: Date.parse("2026-04-06T04:00:00Z"), to: TODAY.to }] }],
    ["models", { deps: [TODAY] }],
    ["accounts", { deps: [ALL_TIME] }],
  ] as const);

  test("ranges overlap when they share an instant (half-open)", () => {
    expect(overlaps({ from: 0, to: 10 }, { from: 9, to: 20 })).toBe(true);
    expect(overlaps({ from: 0, to: 10 }, { from: 10, to: 20 })).toBe(false);
    expect(overlaps(ALL_TIME, { from: 5, to: 6 })).toBe(true);
    expect(changeRange(100, 100)).toEqual({ from: 100, to: 101 });
  });

  test("a change now touches every view", () => {
    expect(affectedViews(deps, changeRange(NOW, NOW), [1], null)).toEqual([
      "overview",
      "history",
      "models",
      "accounts",
    ]);
  });

  test("a change a year ago touches only the all-time views", () => {
    const old = Date.parse("2025-09-29T12:00:00Z");
    expect(affectedViews(deps, changeRange(old, old), [1], null)).toEqual(["overview", "accounts"]);
  });

  test("a change to an account outside the scope touches only the account list", () => {
    expect(affectedViews(deps, changeRange(NOW, NOW), [2], 1)).toEqual(["accounts"]);
    expect(affectedViews(deps, changeRange(NOW, NOW), [1, 2], 1)).toHaveLength(4);
    expect(affectedViews(deps, changeRange(NOW, NOW), null, 1)).toHaveLength(4);
  });
});

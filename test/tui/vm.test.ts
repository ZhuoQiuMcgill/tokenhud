// View models against an independent oracle: each row priced on its own with the pricing
// module, summed over hand-computed Toronto boundaries. The query layer's exactness is
// T6's; this checks the view models ask it the right questions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UsageRow } from "../../src/store/store.ts";
import { ALL_TIME, affectedViews, changeRange, overlaps } from "../../src/tui/vm/compute.ts";
import type {
  AccountRow,
  AccountsVM,
  HistoryDay,
  HistoryPeriod,
  HistoryVM,
  ModelsVM,
  OverviewVM,
  ViewModels,
} from "../../src/tui/vm/types.ts";
import {
  bundledTable,
  FIXTURE_ACCOUNTS,
  type Fixture,
  fixtureRows,
  fixtureViews,
  makeFixtureStore,
  NOW,
} from "./fixture.ts";

const rows = fixtureRows();
const table = bundledTable();
let fixture: Fixture;
let views: ViewModels;

beforeAll(() => {
  fixture = makeFixtureStore(rows);
  const out = fixtureViews(fixture.storePath);
  views = out.views;
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
// A rolling 24 h, for the views' dependencies.
const DAY24 = { from: Date.parse("2026-09-28T16:00:00Z"), to: Date.parse("2026-09-29T16:00:00Z") };

function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
}

describe("History", () => {
  test("days from the 1st of the heat map's first month to today; 26 Monday weeks; whole months", () => {
    const vm = views.history as HistoryVM;
    // This week starts Mon Sep 28; 25 weeks (175 days) earlier is Mon Apr 6, in April.
    expect(vm.days[0]?.key).toBe("2026-04-01");
    expect(vm.days[vm.gridStart]?.key).toBe("2026-04-06");
    expect(vm.days.at(-1)?.key).toBe("2026-09-29");
    expect(vm.weeks).toHaveLength(26);
    expect(vm.weeks[0]?.key).toBe("2026-04-06");
    expect(vm.weeks.at(-1)).toMatchObject({ key: "2026-09-28", days: 2 });
    expect(vm.months.map((m) => [m.key, m.days])).toEqual([
      ["2026-04", 30],
      ["2026-05", 31],
      ["2026-06", 30],
      ["2026-07", 31],
      ["2026-08", 31],
      ["2026-09", 29],
    ]);
  });

  test("each day is its local day's usage", () => {
    const vm = views.history as HistoryVM;
    for (const offset of [0, 1, 30]) {
      const day = vm.days[vm.days.length - 1 - offset] as HistoryDay;
      // EDT all along these dates: local midnight is 04:00Z.
      const from = TODAY.from - offset * 86_400_000;
      const want = oracle(from, from + 86_400_000);
      close(day.cost, want.cost);
      expect(day.tokens).toBe(want.tokens);
    }
    // The fixture starts 60 days back: older days are empty, not missing.
    expect(vm.days[0]).toMatchObject({ key: "2026-04-01", cost: 0, tokens: 0, models: [] });
    // This week and this month are calendar ones, as the Overview's spend row.
    const overview = views.overview as OverviewVM;
    close((vm.weeks.at(-1) as HistoryPeriod).cost, overview.spend.this_week.cost);
    close((vm.months.at(-1) as HistoryPeriod).cost, overview.spend.this_month.cost);
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

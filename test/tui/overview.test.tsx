// The Overview (T11 AC 1): the user's half-screen sizes (105×50, 120×45), 80×24 and 160×50,
// plus 60×20 and 50×20, on a fixture with five accounts (one history-only, one near its
// 5-hour limit with a projection, one with stale limits), limit events and MCP agents. At
// every size no number is cut, clipped or overlapped: each number the view model holds,
// for every section on screen, appears whole.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../../src/config.ts";
import { Frame } from "../../src/tui/app.tsx";
import type { Line } from "../../src/tui/components/base.ts";
import {
  BASELINE,
  chartColumns,
  columnEdges,
  type XLabel,
} from "../../src/tui/components/vchart.ts";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { percent, tokens } from "../../src/tui/format.ts";
import { theme } from "../../src/tui/theme.ts";
import type { AccountsState } from "../../src/tui/views/accounts.tsx";
import { costText } from "../../src/tui/views/cells.ts";
import {
  fitBuckets,
  fitLabels,
  listedEvents,
  type OverviewState,
  paceLine,
} from "../../src/tui/views/overview.tsx";
import type { ViewContext } from "../../src/tui/views/types.ts";
import type {
  AccountInfo,
  ActivityWindow,
  LimitCard,
  OverviewVM,
  ViewModels,
} from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";
import { fixtureConfig, NOW, TZ } from "./fixture.ts";
import { MCP, makeOverviewFixture, type OverviewFixture } from "./overview-fixture.ts";
import { expectOverviewWhole } from "./overview-numbers.ts";
import { chars, cleanupRenderers, render, roles, settle } from "./render.ts";
import { appearsWhole, expectWhole } from "./whole.ts";

guard();

cleanupRenderers();

let fx: OverviewFixture;
let views: ViewModels;
let accounts: AccountInfo[];
beforeAll(() => {
  fx = makeOverviewFixture();
  ({ views, accounts } = fx.views());
});
afterAll(() => fx.remove());

const ports: Ports = {
  saveConfig: () => {},
  vmSettings: () => {},
  vmConfig: () => {},
  vmRoots: () => {},
  accountsEdited: () => {},
  quit: () => {},
};

function controller(config: Config = fixtureConfig(), over: ViewModels = {}) {
  const c = new Controller(initialState(config, "owner"), ports, TZ);
  c.vmMessage({ type: "views", views: { ...views, ...over }, accounts, scope: null, ms: 1 });
  c.vmMessage({ type: "mcp", activity: MCP });
  c.setIngest("live");
  return c;
}

const key = (name: string) => ({ name, sequence: name, ctrl: false });

async function frame(width: number, height: number, c = controller()) {
  const setup = await render(<Frame controller={c} width={width} height={height} />, width, height);
  return { setup, text: chars(setup), c };
}

// ── the sizes ──────────────────────────────────────────────────────────────────────

test("the checker catches a cut number, one touching …, and a number inside a longer one", () => {
  expect(appearsWhole(" 5h  78%  1h48m ", "1h48m")).toBe(true);
  expect(appearsWhole(" 5h  78%  1h4… ", "1h48m")).toBe(false);
  expect(appearsWhole(" $12.59 ", "$12.5")).toBe(false);
  expect(appearsWhole(" 112:59 ", "12:59")).toBe(false);
  expect(() => expectWhole(" hits 100% at 12:5…", [], 40)).toThrow();
  expect(() => expectWhole("x".repeat(41), [], 40)).toThrow();
});

describe.each([
  [105, 50],
  [120, 45],
  [80, 24],
  [160, 50],
  [60, 20],
  [50, 20],
] as const)("%i×%i", (width, height) => {
  test("snapshot, and every number on screen whole", async () => {
    const { text } = await frame(width, height);
    expect(text.split("\n").slice(0, height)).toHaveLength(height);
    expectOverviewWhole(text, views.overview as OverviewVM, width, fixtureConfig());
    expect(text).toMatchSnapshot();
  });

  test("costs hidden: tokens only, every number whole", async () => {
    const config = fixtureConfig({ show_cost: false });
    const { text } = await frame(width, height, controller(config));
    expect(text).not.toContain("$");
    expectOverviewWhole(text, views.overview as OverviewVM, width, config);
  });
});

describe("what each size keeps (limits first)", () => {
  test("105×50 and 120×45 show every section; cards 2 and 3 to a row", async () => {
    for (const [width, height, perRow] of [
      [105, 50, 2],
      [120, 45, 3],
    ] as const) {
      const { text } = await frame(width, height);
      for (const title of [" LIMITS", " SPEND", " ACTIVITY", " TOP MODELS", " LIMIT EVENTS"]) {
        expect(text).toContain(title);
      }
      const firstRow = text.split("\n").find((l) => l.includes("╭─ personal")) ?? "";
      expect(firstRow.split("╭─").length - 1).toBe(perRow);
    }
  });

  test("at 120 the chart and top models share rows; at 105 top models go below", async () => {
    const wide = (await frame(120, 45)).text.split("\n");
    expect(wide.some((l) => l.includes("ACTIVITY") && l.includes("TOP MODELS"))).toBe(true);
    const medium = (await frame(105, 50)).text.split("\n");
    expect(medium.some((l) => l.includes("ACTIVITY") && l.includes("TOP MODELS"))).toBe(false);
  });

  test("80×24: compact two-line cards keep all five accounts; lower sections go first", async () => {
    const { text } = await frame(80, 24);
    expect(text).not.toContain("╭─");
    for (const a of accounts) expect(text).toContain(a.label);
    expect(text).toContain("not signed in here");
    expect(text).toContain("(47m old)");
    expect(text).not.toContain(" ACTIVITY");
    expect(text).not.toContain(" LIMIT EVENTS");
  });

  test("the history-only account says so instead of meters; stale limits show their age", async () => {
    const { text } = await frame(105, 50);
    const lines = text.split("\n");
    const old = lines.findIndex((l) => l.includes("old-laptop · claude"));
    expect(lines[old + 1]).toContain("not signed in here");
    expect(text).toContain("work · claude (47m old)");
    expect(text).toContain("pace $1.3/h (30m) → 100% in <1.5h (12:59)");
    // codex's week at its average since the window began (T18).
    expect(text).toContain("avg $0.08/h this week → week ends ~94%");
    expect(text).toContain("safe until reset");
  });

  // Critique m1: a list cut short read as the whole week.
  test("limit events: reached first, and every hidden event counted, at every height", async () => {
    const vm = views.overview as OverviewVM;
    const listed = listedEvents(vm);
    expect(listed.map((e) => e.kind)).toEqual(["reached", "reached", "reached", "passed_80"]);
    let cut = 0;
    for (const [width, from, to] of [
      [105, 36, 50],
      [120, 26, 45],
      [100, 38, 46],
      [90, 36, 42],
    ] as const) {
      for (let height = from; height <= to; height++) {
        const { text } = await frame(width, height);
        if (!text.includes(" LIMIT EVENTS")) continue;
        expectOverviewWhole(text, vm, width, fixtureConfig());
        const rows = text.split("\n").filter((l) => /^ {2}\w{3} \d\d:\d\d /.test(l)).length;
        const more = Number(/\+(\d+) more events/.exec(text)?.[1] ?? 0);
        expect({ width, height, seen: rows + more }).toEqual({
          width,
          height,
          seen: listed.length,
        });
        if (more > 0) cut++;
      }
    }
    expect(cut).toBeGreaterThan(0);
  });

  test("a short terminal keeps the limit cards whole and drops sections below them", async () => {
    const { text } = await frame(105, 24);
    expect(text).toContain(" LIMITS");
    expect(text.split("╰─").length - 1).toBe(6);
    expect(text).not.toContain(" SPEND");
  });
});

// ── the activity chart's width (T24) ───────────────────────────────────────────────

// A user's wide terminal drew 24 h across the section and 7 d over about 60 % of it: 84
// columns of 2 h took a cell each. The columns now fill the plot, whatever their number.
describe("the activity chart fills its width (T24)", () => {
  /** Each window's finest buckets, as the view model holds them (ACTIVITY): count, minutes. */
  const FINEST: Readonly<Record<ActivityWindow, readonly [number, number]>> = {
    "5h": [300, 1],
    "24h": [288, 5],
    "7d": [168, 60],
  };
  /** Positive whole amounts, so every column draws and sums are exact. */
  const series = (n: number) => Array.from({ length: n }, (_, i) => 1 + ((i * 37) % 11));
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  const widthsOf = (edges: readonly number[]) =>
    edges.slice(1).map((e, i) => e - (edges[i] as number));

  /** The y labels and their gap, before the plot. */
  const CHART_LABELS = 7;
  /** A chart alone, `plot` cells of bars after its labels. */
  async function chart(values: readonly number[], plot: number, xLabels: XLabel[] = []) {
    const width = CHART_LABELS + plot;
    // One spare row: OpenTUI's test renderer drops a 1-row frame's box-drawing characters.
    const setup = await render(
      <box width={width} height={10} flexDirection="column">
        <th-vchart
          values={values}
          xLabels={xLabels}
          theme={theme("dark")}
          width={width}
          height={9}
        />
      </box>,
      width,
      10,
    );
    return chars(setup).split("\n").slice(0, 9);
  }

  // By hand: the finest bucket that divides the window evenly with at most a column a
  // cell (as before T24), and how many columns take floor(plot / columns) + 1 cells.
  const CASES: [ActivityWindow, plot: number, columns: number, minutes: number, wide: number][] = [
    ["5h", 60, 60, 5, 0],
    ["5h", 84, 75, 4, 9],
    ["5h", 100, 100, 3, 0],
    ["5h", 150, 150, 2, 0],
    ["5h", 200, 150, 2, 50],
    ["24h", 60, 48, 30, 12],
    ["24h", 84, 72, 20, 12],
    ["24h", 100, 96, 15, 4],
    ["24h", 150, 144, 10, 6],
    ["24h", 200, 144, 10, 56],
    ["7d", 60, 56, 180, 4],
    ["7d", 84, 84, 120, 0],
    ["7d", 100, 84, 120, 16],
    ["7d", 150, 84, 120, 66],
    // 7 d by the hour only once 168 columns fit.
    ["7d", 200, 168, 60, 32],
  ];

  test.each(CASES)(
    "%s in %i cells: %i columns of %i min, the plot filled, bars 1 cell apart at most",
    async (window, plot, columns, minutes, wide) => {
      const [n, finest] = FINEST[window];
      const values = series(n);
      const plotted = fitBuckets(values, plot);
      expect(plotted.values).toHaveLength(columns);
      expect(plotted.group * finest).toBe(minutes);
      const layout = chartColumns(plotted.values, plot);
      expect(layout.columns).toEqual(plotted.values);
      expect(sum(layout.columns)).toBe(sum(values));
      expect(layout.edges[0]).toBe(0);
      expect(layout.edges[columns]).toBe(plot);
      const widths = widthsOf(layout.edges);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
      expect(widths.filter((w) => w > Math.floor(plot / columns))).toHaveLength(wide);

      // As drawn: the bottom row is bars from the first plot cell to the last, and the
      // top row, with every other column at the peak, shows each column's width.
      const rows = await chart(values, plot);
      expect((rows[8] as string).slice(CHART_LABELS)).toMatch(new RegExp(`^[▁-█]{${plot}}$`));
      const alternate = plotted.values.map((_, i) => (i % 2 === 0 ? 2 : 1));
      const top = ((await chart(alternate, plot))[0] as string).slice(CHART_LABELS);
      const drawn = (top.match(/█+| +/g) ?? []).map((run) => run.length);
      expect(drawn).toEqual(widths);
    },
  );

  test("a run of empty buckets keeps its true time span, to within a cell", async () => {
    for (const [columns, plot] of [
      [84, 150],
      [144, 200],
      [75, 84],
      [56, 60],
    ] as const) {
      const edges = columnEdges(columns, plot);
      for (let from = 0; from < columns; from++) {
        for (let to = from + 1; to <= columns; to++) {
          const cells = (edges[to] as number) - (edges[from] as number);
          expect(Math.abs(cells - ((to - from) * plot) / columns)).toBeLessThan(1);
        }
      }
    }
    // As drawn: 7 d in 150 cells, a day with no usage (12 columns of 2 h from the 25th)
    // is 22 cells of baseline, 12 × 150 / 84 = 21.4 rounded by where it falls.
    const hours = series(168).map((v, h) => (h >= 48 && h < 72 ? 0 : v));
    const plotted = fitBuckets(hours, 150);
    expect(plotted.values.slice(24, 36)).toEqual(Array(12).fill(0));
    const bottom = ((await chart(plotted.values, 150))[8] as string).slice(CHART_LABELS);
    expect(bottom.indexOf(BASELINE)).toBe(42);
    expect(bottom.slice(42).search(/[^▁]/)).toBe(22);
    expect(bottom).not.toContain(" ");
    expect(bottom).toHaveLength(150);
  });

  test("x ticks start at the column they fall in; now ends at the plot's last cell", async () => {
    const days = ["-7d", "-6d", "-5d", "-4d", "-3d", "-2d", "-1d", "now"];
    const labels = days.map((text, i) => ({ at: i / 7, text }));
    // 84 columns of 2 h in 150 cells: a day is 12 columns, column 12k starts at
    // floor(12k × 150 / 84).
    const ticks = (await chart(Array(84).fill(1), 150, labels))[8] as string;
    const at = days.map((d) => ticks.indexOf(d) - CHART_LABELS);
    expect(at).toEqual([0, 21, 42, 64, 85, 107, 128, 147]);
    expect(ticks.trimEnd()).toHaveLength(CHART_LABELS + 150);
  });

  test("at the user's sizes every window's chart ends where the section does", async () => {
    // The chart's width: the screen's, or what the top models beside it leave. The
    // fixture spends in every window's last bucket, so its bar ends the plot.
    for (const [width, height, edge] of [
      [160, 50, 103],
      [120, 45, 80],
      [105, 50, 105],
    ] as const) {
      const ends: Record<string, { bars: number; now: number }> = {};
      for (const [window, press] of [
        ["5h", "a"],
        ["24h", null],
        ["7d", "d"],
      ] as const) {
        const c = controller();
        if (press !== null) c.key(key(press));
        const lines = (await frame(width, height, c)).text.split("\n");
        const at = lines.findIndex((l) => /^ {7}-(5h|24h|7d) /.test(l));
        const bottom = (lines[at - 1] as string).slice(0, edge + 1);
        ends[window] = {
          bars: bottom.trimEnd().length,
          now: (lines[at] as string).indexOf("now") + 3,
        };
      }
      const end = { bars: edge, now: edge };
      expect({ width, ends }).toEqual({ width, ends: { "5h": end, "24h": end, "7d": end } });
    }
  });
});

// T24 AC: each window at the user's sizes. The 24 h frames are the sizes' own, above.
describe.each(["5h", "7d"] as const)("the %s chart", (window) => {
  const turned = (config = fixtureConfig()) => {
    const c = controller(config);
    c.key(key(window === "5h" ? "a" : "d"));
    expect((c.getState().viewState.overview as OverviewState).window).toBe(window);
    return c;
  };

  test.each([
    [105, 50],
    [120, 45],
    [160, 50],
    [80, 24],
  ] as const)("%i×%i: snapshot, and every number on screen whole", async (width, height) => {
    const vm = views.overview as OverviewVM;
    const { text } = await frame(width, height, turned());
    expectOverviewWhole(text, vm, width, fixtureConfig(), window);
    expect(text).toMatchSnapshot();
    const tokensOnly = fixtureConfig({ show_cost: false });
    const hidden = (await frame(width, height, turned(tokensOnly))).text;
    expect(hidden).not.toContain("$");
    expectOverviewWhole(hidden, vm, width, tokensOnly, window);
  });
});

// ── keys ───────────────────────────────────────────────────────────────────────────

describe("keys", () => {
  const state = (c: Controller) => c.getState().viewState.overview as OverviewState;

  test("a/d cycle the chart through 5 h, 24 h and 7 d, its tab strip following; t switches cost and tokens", async () => {
    const c = controller();
    const { setup } = await frame(105, 50, c);
    const title = () =>
      chars(setup)
        .split("\n")
        .find((l) => l.includes("ACTIVITY")) ?? "";
    /** The strip's active tab: the cells drawn on the `tab` background. */
    const active = () =>
      (
        roles(setup.captureSpans(), theme("dark"))
          .split("\n")
          .find((l) => l.includes("ACTIVITY")) ?? ""
      ).match(/\[head\/tab\/b\](\[[^\]]*\])/)?.[1];
    expect(title()).toContain("cost per 15 min");
    expect(title()).toContain("◀ a  5h  [24h]  7d  d ▶");
    expect(active()).toBe("[24h]");
    await settle(setup, () => c.key(key("d")));
    expect(title()).toContain("cost per 2 h");
    expect(active()).toBe("[7d]");
    expect(chars(setup)).toContain("-7d");
    await settle(setup, () => c.key(key("right")));
    expect(title()).toContain("cost per 4 min");
    expect(active()).toBe("[5h]");
    await settle(setup, () => c.key(key("a")));
    expect(state(c).window).toBe("7d");
    await settle(setup, () => c.key(key("t")));
    expect(title()).toContain("tokens per 2 h");
    expect(chars(setup)).toContain(" TOP MODELS");
    // ↑/↓ select a card now; they no longer switch cost and tokens.
    await settle(setup, () => c.key(key("down")));
    expect(title()).toContain("tokens per 2 h");
    expect(state(c)).toMatchObject({ tokens: true, card: 0 });
  });

  // Accounts selects by account id (T13); critique §8: an index here opened the wrong one.
  test("w/s select a card; Enter opens Accounts on that card's account, every card", async () => {
    const cards = (views.overview as OverviewVM).cards ?? [];
    expect(cards.filter((c) => c.account !== null)).toHaveLength(5);
    for (const [i, card] of cards.entries()) {
      const c = controller();
      const { setup } = await frame(120, 45, c);
      await settle(setup, () => {
        for (let k = 0; k <= i; k++) c.key(key(k === 0 ? "s" : "down"));
      });
      expect(chars(setup)).toContain(`▸ ${card.label} · ${card.provider}`);
      await settle(setup, () => c.key(key("return")));
      const s = c.getState();
      expect(s.view).toBe("accounts");
      expect((s.viewState.accounts as AccountsState).selected).toBe(card.account as number);
      // On screen: the detail is that account's, and its row in the list is the selected one.
      const text = chars(setup);
      expect(text.split("\n")[3]).toContain(`${card.label} · ${card.provider}`);
      const selected = roles(setup.captureSpans(), theme("dark"))
        .split("\n")
        .filter((l) => l.includes("/sel]"));
      expect(selected.length).toBeGreaterThan(0);
      expect({ card: card.label, row: selected.join("\n") }).toMatchObject({
        card: card.label,
        row: expect.stringContaining(`/sel]${card.label} `),
      });
    }
  });

  test("Enter with no card selected opens the first; esc clears the selection", async () => {
    const c = controller();
    c.key(key("w"));
    expect(state(c).card).toBe(0);
    c.key(key("up"));
    expect(state(c).card).toBe(0);
    c.key(key("escape"));
    expect(state(c).card).toBeNull();
    c.key(key("return"));
    const s = c.getState();
    expect(s.view).toBe("accounts");
    const first = ((views.overview as OverviewVM).cards ?? [])[0];
    expect((s.viewState.accounts as AccountsState).selected).toBe(first?.account as number);
  });

  test("the compact form marks the selected card", async () => {
    const c = controller();
    c.key(key("s"));
    const { setup } = await frame(80, 24, c);
    const out = roles(setup.captureSpans(), theme("dark")).split("\n");
    const personal = out.find((l) => l.includes("personal")) ?? "";
    expect(personal).toContain("/sel");
  });

  // T27: the top models are the chart's window's, beside the chart (120) and below it (105).
  test("a/d switch the top models with the chart: the title, and the list by cost or by tokens", async () => {
    const vm = views.overview as OverviewVM;
    for (const [width, height] of [
      [120, 45],
      [105, 50],
    ] as const) {
      for (const showCost of [true, false]) {
        const c = controller(fixtureConfig({ show_cost: showCost }));
        const { setup } = await frame(width, height, c);
        /** The section's lines, from its title's column. */
        const block = () => {
          const lines = chars(setup).split("\n");
          const from = lines.findIndex((l) => l.includes("TOP MODELS"));
          const column = (lines[from] as string).indexOf("TOP MODELS") - 1;
          return lines.slice(from, from + 7).map((l) => l.slice(column).trimEnd());
        };
        for (const [press, window] of [
          [null, "24h"],
          ["d", "7d"],
          ["d", "5h"],
          ["a", "7d"],
          ["a", "24h"],
          ["a", "5h"],
        ] as const) {
          if (press !== null) await settle(setup, () => c.key(key(press)));
          expect(state(c).window).toBe(window);
          const ranked = vm.topModels[window];
          const models = showCost ? ranked.byCost : ranked.byTokens;
          const lines = block();
          const at = { width, showCost, window };
          expect({ ...at, title: lines[0] }).toEqual({ ...at, title: ` TOP MODELS · ${window}` });
          models.forEach((m, i) => {
            const amount = showCost ? costText(m).text : tokens(m.tokens);
            expect({ ...at, row: lines[i + 1] }).toEqual({
              ...at,
              row: expect.stringMatching(
                new RegExp(`^ ${m.name} +${amount.replace("$", "\\$")} +${percent(m.share, 0)} `),
              ),
            });
          });
          // The list ends there: what follows is the hint, a blank or the next section.
          expect(lines[models.length + 1] ?? "").not.toContain("%");
        }
      }
    }
  });
});

// Critique M1: at 120–140 columns real model names were cut until different models read the
// same, and "(fast)" went first. Names are short display names now, and the bar and share
// go before a name is cut.
describe("top models' names", () => {
  const model = (id: string, name: string, cost: number, share: number, fast = false) => ({
    model: id,
    name,
    tier: fast ? ("fast" as const) : ("standard" as const),
    cost,
    tokens: Math.round(cost * 100_000),
    pricedShare: 1,
    estimatedCost: 0,
    share,
    status: "priced" as const,
  });
  const top = [
    model("claude-opus-4-8", "Opus 4.8", 120.5, 0.6, true),
    model("claude-sonnet-4-6", "Sonnet 4.6", 40.25, 0.2),
    model("claude-sonnet-4-5", "Sonnet 4.5", 20.1, 0.1),
    model("gpt-5.1-codex-max", "gpt-5.1-codex-max", 15, 0.075),
    model("claude-haiku-4-5", "Haiku 4.5", 5, 0.025),
  ];
  const labels = ["Opus 4.8 (fast)", "Sonnet 4.6", "Sonnet 4.5", "gpt-5.1-codex-max", "Haiku 4.5"];

  test.each([
    [120, 45],
    [125, 45],
    [130, 45],
    [135, 45],
    [140, 45],
    [105, 50],
    [160, 50],
  ] as const)("%i×%i: every name whole, (fast) kept", async (width, height) => {
    const ranked = { byCost: top, byTokens: top };
    const vm: OverviewVM = {
      ...(views.overview as OverviewVM),
      topModels: { "5h": ranked, "24h": ranked, "7d": ranked },
    };
    for (const showCost of [true, false]) {
      const c = controller(fixtureConfig({ show_cost: showCost }), { overview: vm });
      const { text } = await frame(width, height, c);
      const lines = text.split("\n");
      const from = lines.findIndex((l) => l.includes("TOP MODELS"));
      const block = lines.slice(from, from + top.length + 1).join("\n");
      for (const label of labels) expect(block).toContain(label);
      expect(block).not.toContain("…");
    }
  });

  test("names come from the model ids as the Models view writes them", () => {
    const vm = views.overview as OverviewVM;
    expect(vm.topModels["24h"].byCost.find((m) => m.model === "claude-opus-4-8")?.name).toBe(
      "Opus 4.8",
    );
  });

  test("squeezed, a name is cut but never its (fast), and no two read the same", () => {
    expect(fitLabels(top, 99)).toEqual(labels);
    for (const width of [16, 12, 10, 8]) {
      const fitted = fitLabels(top, width);
      for (const l of fitted) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
      expect(new Set(fitted).size).toBe(fitted.length);
      expect(fitted[0]?.endsWith(" (fast)")).toBe(true);
    }
    expect(fitLabels(top, 8).slice(1, 3)).toEqual(["Sonnet…6", "Sonnet…5"]);
  });
});

// T18: each card's pace line names its pace, a weekly window's time is a part of a day,
// and an idle card names a window at 80 % or more. The cards are made by hand here (the view
// model's rules are tested in overview-vm.test.ts) to show every form at the user's sizes.
describe("which pace, and how precise (T18)", () => {
  const HOUR = 3_600_000;
  const vm = (): OverviewVM => {
    const base = views.overview as OverviewVM;
    const [personal, work, old, codex, win] = base.cards ?? [];
    const avg = (cost: number) => ({ cost, tokens: cost * 40_000, basis: "window_avg" as const });
    const cards: LimitCard[] = [
      // As the fixture has it: the 5-hour window first, to the minute.
      personal as LimitCard,
      // NOW is Tue 11:40 in Toronto: 56 h on is Thu 19:40.
      {
        ...(work as LimitCard),
        pace: avg(16.3),
        verdict: { kind: "hits", at: NOW + 56 * HOUR, rough: "~Thu evening" },
      },
      old as LimitCard,
      {
        ...(codex as LimitCard),
        pace: { cost: 0, tokens: 0, basis: "30m" },
        verdict: { kind: "idle", high: { window: "week", utilization: 0.83 } },
      },
      // 20 h on is Wed 07:40.
      {
        ...(win as LimitCard),
        pace: avg(6.2),
        verdict: { kind: "hits", at: NOW + 20 * HOUR, rough: "~tomorrow morning" },
      },
    ];
    return { ...base, cards };
  };
  const draw = (width: number, height: number, show = true) =>
    frame(width, height, controller(fixtureConfig({ show_cost: show }), { overview: vm() }));

  test.each([
    [105, 50],
    [120, 45],
    [160, 50],
    [80, 24],
  ] as const)("%i×%i: snapshot, and every number whole", async (width, height) => {
    for (const show of [true, false]) {
      const { text } = await draw(width, height, show);
      expectOverviewWhole(text, vm(), width, fixtureConfig({ show_cost: show }));
      if (show) expect(text).toMatchSnapshot();
    }
  });

  test("105×50: a weekly time in place of this week, never in minutes", async () => {
    const { text } = await draw(105, 50);
    expect(text).toContain("pace $1.3/h (30m) → 100% in <1.5h (12:59)");
    // `this week` gives way to the weekly time.
    expect(text).toContain("avg $16/h → 100% in ~3d (~Thu evening)");
    expect(text).toContain("pace $0/h (30m) → idle · week 83%");
    expect(text).toContain("avg $6.2/h → 100% in <24h (~tomorrow morning)");
    expect(text).not.toMatch(/~\S* ?\d\d:\d\d/);
  });

  test("120×45, three cards to a row: the time goes, then the in, before the basis", async () => {
    const { text } = await draw(120, 45);
    expect(text).toContain("pace $1.3/h (30m) → 100% in <1.5h ");
    expect(text).toContain("avg $16/h this week → 100% in ~3d ");
    expect(text).toContain("pace $0/h (30m) → idle · week 83%");
    expect(text).toContain("avg $6.2/h this week → 100% <24h ");
  });

  test("160×50: as at 105", async () => {
    const { text } = await draw(160, 50);
    expect(text).toContain("pace $1.3/h (30m) → 100% in <1.5h (12:59)");
    expect(text).toContain("avg $16/h → 100% in ~3d (~Thu evening)");
    expect(text).toContain("avg $6.2/h → 100% in <24h (~tomorrow morning)");
  });

  test("80×24, compact: every countdown with its time", async () => {
    const { text } = await draw(80, 24);
    expect(text).toContain("pace $1.3/h (30m) → 100% in <1.5h (12:59)");
    expect(text).toContain("avg $16/h this week → 100% in ~3d (~Thu evening)");
    expect(text).toContain("avg $6.2/h this week → 100% in <24h (~tomorrow morning)");
  });

  test("an idle card's full window is in the alarm colour", async () => {
    const { setup } = await draw(120, 45);
    expect(roles(setup.captureSpans(), theme("dark"))).toContain("[high/bg]idle · week 83%");
  });
});

// T26: a projected 100 % counts down first and gives the time second. Narrower, the time
// goes first, then the `in`, then (T18) the pace's basis, then its word; no number is cut.
describe("the countdown to 100 % (T26)", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const ctx = (width: number): ViewContext => ({
    width,
    bp: "medium",
    theme: theme("dark"),
    showCost: true,
    tz: TZ,
    scope: null,
  });
  const text = (line: Line) =>
    line.left
      .map((s) => s.text)
      .join("")
      .trimEnd();
  const card = (verdict: LimitCard["verdict"], pace: LimitCard["pace"]): LimitCard => ({
    ...((views.overview as OverviewVM).cards?.[0] as LimitCard),
    pace,
    verdict,
  });
  const recent = { cost: 1.3, tokens: 52_000, basis: "30m" as const };
  /**
   * Each form the pace line takes as its room shrinks from 60 cells to 10, widest first;
   * at every width, the first of them that fits (the last when none does).
   */
  function forms(c: LimitCard, asOf = NOW): string[] {
    const chosen = new Map<number, string>();
    for (let width = 60; width >= 10; width--) {
      chosen.set(width, text(paceLine(c, width, ctx(width), asOf)));
    }
    const out = [...new Set(chosen.values())];
    const widths = out.map((f) => Bun.stringWidth(f));
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    for (const [width, form] of chosen) {
      expect(form).toBe(out.find((f) => Bun.stringWidth(f) <= width) ?? (out.at(-1) as string));
    }
    return out;
  }

  test("the 5-hour window: the time goes, then the in, then the basis, then the word", () => {
    // NOW is 11:40 in Toronto; 79 minutes on is 12:59.
    const c = card({ kind: "hits", at: NOW + 79 * MIN, rough: null }, recent);
    expect(forms(c)).toEqual([
      "pace $1.3/h (30m) → 100% in <1.5h (12:59)",
      "pace $1.3/h (30m) → 100% in <1.5h",
      "pace $1.3/h (30m) → 100% <1.5h",
      "pace $1.3/h → 100% <1.5h",
      "$1.3/h → 100% <1.5h",
    ]);
  });

  test("a weekly window: `~` days, its time a part of a day; `this week` goes before it", () => {
    // NOW is Tue 11:40; 56 h on is Thu 19:40: over two days, so ~3d.
    const avg = { cost: 16.3, tokens: 652_000, basis: "window_avg" as const };
    const c = card({ kind: "hits", at: NOW + 56 * HOUR, rough: "~Thu evening" }, avg);
    expect(forms(c)).toEqual([
      "avg $16/h this week → 100% in ~3d (~Thu evening)",
      // The LIMITS note says what avg is; the part of the day is worth more.
      "avg $16/h → 100% in ~3d (~Thu evening)",
      "avg $16/h this week → 100% in ~3d",
      "avg $16/h this week → 100% ~3d",
      "avg $16/h → 100% ~3d",
      "$16/h → 100% ~3d",
    ]);
  });

  test("under a minute: 100% now, in every form", () => {
    const c = card({ kind: "hits", at: NOW + 59_000, rough: null }, recent);
    expect(forms(c)).toEqual([
      "pace $1.3/h (30m) → 100% now",
      "pace $1.3/h → 100% now",
      "$1.3/h → 100% now",
    ]);
  });

  test("live: each frame counts down from the instant to its own now", () => {
    const c = card({ kind: "hits", at: NOW + 2 * HOUR + MIN, rough: null }, recent);
    // 13:41: 2 h 01 m is within 3 h; a minute on, within 2 h; then 45, 5 minutes; then now.
    const at = (asOf: number) => text(paceLine(c, 60, ctx(60), asOf));
    expect(at(NOW)).toBe("pace $1.3/h (30m) → 100% in <3h (13:41)");
    expect(at(NOW + MIN)).toBe("pace $1.3/h (30m) → 100% in <2h (13:41)");
    expect(at(NOW + 76 * MIN)).toBe("pace $1.3/h (30m) → 100% in <45m (13:41)");
    expect(at(NOW + 120 * MIN)).toBe("pace $1.3/h (30m) → 100% in <5m (13:41)");
    expect(at(NOW + 120 * MIN + 1)).toBe("pace $1.3/h (30m) → 100% now");
  });

  test("past midnight the time has its day", () => {
    const c = card({ kind: "hits", at: Date.parse("2026-09-30T04:10:00Z"), rough: null }, recent);
    // 23:50 Tue in Toronto, 20 minutes before Wed 00:10.
    const asOf = Date.parse("2026-09-30T03:50:00Z");
    expect(text(paceLine(c, 60, ctx(60), asOf))).toBe(
      "pace $1.3/h (30m) → 100% in <20m (Wed 00:10)",
    );
  });
});

describe("colours", () => {
  test("cards at 120×45 in the dark theme, by role", async () => {
    const { setup } = await frame(120, 45);
    const out = roles(setup.captureSpans(), theme("dark")).split("\n");
    // The projection is the alarm colour; the stale age and history-only line are dim. Three
    // cards to a row keep the pace's basis and shorten the verdict.
    expect(out.join("\n")).toContain("[dim/bg] (30m) → [high/bg/b]100% in <1.5h");
    expect(out.join("\n")).toContain("[dim/bg] (47m old)");
    expect(out.join("\n")).toContain("[dim/bg]not signed in here");
    expect(out.slice(3, 15).join("\n")).toMatchSnapshot();
  });
});

describe("states", () => {
  test("before the roots are known: the cards wait, nothing else does", async () => {
    const vm = { ...(views.overview as OverviewVM), cards: null, agents: null };
    const { text } = await frame(105, 50, controller(fixtureConfig(), { overview: vm }));
    expect(text).toContain("reading limits…");
    expect(text).toContain(" SPEND");
  });

  test("no MCP server: no agents card", async () => {
    const vm = { ...(views.overview as OverviewVM), agents: null };
    const { text } = await frame(120, 45, controller(fixtureConfig(), { overview: vm }));
    expect(text).not.toContain("agents · MCP");
    expect(text.split("╭─").length - 1).toBe(5);
  });

  test("each agent line names its session's project, else claude session; accounts line up", async () => {
    const lines = (await frame(160, 50)).text.split("\n");
    const project = lines.find((l) => l.includes("● demo-app")) as string;
    const none = lines.find((l) => l.includes("● claude session")) as string;
    expect(project).toContain("● demo-app        work  limits");
    expect(none).toContain("● claude session  personal  should_wait");
    expect(project.indexOf("work")).toBe(none.indexOf("personal"));
    // The compact form, too.
    const compact = (await frame(80, 24)).text;
    expect(compact).toContain("◆ MCP  demo-app        work  limits");
    expect(compact).toContain("◆ MCP  claude session  personal  should_wait");
  });

  test("a long project name is cut, never the time", async () => {
    const call = { tool: "limits", account: "work", project: "a-very-long-project-name", at: NOW };
    const vm = { ...(views.overview as OverviewVM), agents: { servers: 1, calls: [call] } };
    const { text } = await frame(160, 50, controller(fixtureConfig(), { overview: vm }));
    expect(text).toMatch(/● a-very-long-pro… {2}work {2}limits +<1m │/);
  });

  test("no limit events: a line says so", async () => {
    const vm = { ...(views.overview as OverviewVM), events: [] };
    const { text } = await frame(105, 50, controller(fixtureConfig(), { overview: vm }));
    expect(text).toContain("no limit events in the last 7 days");
  });

  test("the frame is computed for NOW", () => {
    expect((views.overview as OverviewVM).asOf).toBe(NOW);
  });
});

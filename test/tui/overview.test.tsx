// The Overview (T11 AC 1): the user's half-screen sizes (105×50, 120×45), 80×24 and 160×50,
// plus 60×20 and 50×20, on a fixture with five accounts (one history-only, one near its
// 5-hour limit with a projection, one with stale limits), limit events and MCP agents. At
// every size no number is cut, clipped or overlapped: each number the view model holds,
// for every section on screen, appears whole.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../../src/config.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { theme } from "../../src/tui/theme.ts";
import type { AccountsState } from "../../src/tui/views/accounts.tsx";
import { fitLabels, listedEvents, type OverviewState } from "../../src/tui/views/overview.tsx";
import type { AccountInfo, OverviewVM, ViewModels } from "../../src/tui/vm/types.ts";
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
    expect(text).toContain("hits 100% at 12:59");
    expect(text).toContain("week ends ~89%");
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
    const vm = { ...(views.overview as OverviewVM), topModels: top, topModelsByTokens: top };
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
    expect(vm.topModels.find((m) => m.model === "claude-opus-4-8")?.name).toBe("Opus 4.8");
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

describe("colours", () => {
  test("cards at 120×45 in the dark theme, by role", async () => {
    const { setup } = await frame(120, 45);
    const out = roles(setup.captureSpans(), theme("dark")).split("\n");
    // The projection is the alarm colour; the stale age and history-only line are dim.
    expect(out.join("\n")).toContain("[high/bg/b]hits 100% at 12:59");
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

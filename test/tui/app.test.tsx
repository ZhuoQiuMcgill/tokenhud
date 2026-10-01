// The frame and every placeholder view at the four sizes the user runs (T10 §4): 105×50
// and 120×45 (half screens), 80×24, 160×50. Deterministic: a fixture store, a fixed clock,
// and view models computed exactly as the view-model Worker computes them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../../src/config.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { money, tokens } from "../../src/tui/format.ts";
import { theme } from "../../src/tui/theme.ts";
import type { AccountInfo, OverviewVM, ViewModels } from "../../src/tui/vm/types.ts";
import { type Fixture, fixtureConfig, fixtureViews, makeFixtureStore } from "./fixture.ts";
import { chars, cleanupRenderers, render, roles, settle } from "./render.ts";

cleanupRenderers();

const SIZES = [
  [105, 50],
  [120, 45],
  [80, 24],
  [160, 50],
] as const;
const VIEWS = [
  ["1", "overview"],
  ["2", "history"],
  ["3", "models"],
  ["4", "accounts"],
] as const;

let fixture: Fixture;
let views: ViewModels;
let accounts: AccountInfo[];
beforeAll(() => {
  fixture = makeFixtureStore();
  ({ views, accounts } = fixtureViews(fixture.storePath));
});
afterAll(() => fixture.remove());

const ports: Ports = {
  saveConfig: () => {},
  vmSettings: () => {},
  vmConfig: () => {},
  vmRoots: () => {},
  accountsEdited: () => {},
  quit: () => {},
};

function controller(config: Config = fixtureConfig(), mode: "owner" | "reader" = "owner") {
  const c = new Controller(initialState(config, mode), ports, "America/Toronto");
  c.vmMessage({ type: "views", views, accounts, scope: null, ms: 1 });
  c.vmMessage({ type: "mcp", activity: { servers: 1, agents: 2, recent: [] } });
  if (mode === "owner") c.setIngest("live");
  return c;
}

const key = (name: string) => ({ name, sequence: name, ctrl: false });

describe.each(SIZES)("%i×%i", (width, height) => {
  test.each(VIEWS)("view %s (%s)", async (k, _name) => {
    const c = controller();
    const setup = await render(
      <Frame controller={c} width={width} height={height} />,
      width,
      height,
    );
    await settle(setup, () => c.key(key(k)));
    const frame = chars(setup);
    const lines = frame.split("\n").slice(0, height);
    expect(lines).toHaveLength(height);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    expect(frame).toMatchSnapshot();
  });

  test("the Overview's numbers appear whole, never cut", async () => {
    const c = controller();
    const setup = await render(
      <Frame controller={c} width={width} height={height} />,
      width,
      height,
    );
    const frame = chars(setup);
    const vm = views.overview as OverviewVM;
    for (const p of ["today", "this_week", "this_month", "all"] as const) {
      expect(frame).toContain(money(vm.spend[p].cost));
      expect(frame).toContain(tokens(vm.spend[p].tokens));
    }
  });
});

describe("colours", () => {
  test("the Overview at 120×45 in the dark theme, by role", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={120} height={45} />, 120, 45);
    expect(roles(setup.captureSpans(), theme("dark"))).toMatchSnapshot();
  });

  test("the light theme paints the same frame in its own roles", async () => {
    const c = controller(fixtureConfig({ theme: "light" }));
    const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
    const out = roles(setup.captureSpans(), theme("light"));
    expect(out).not.toContain("#"); // every cell is one of the theme's roles
    expect(out).toMatchSnapshot();
  });
});

describe("states", () => {
  test("another instance holds the lock: read-only, stale, and the notice", async () => {
    const c = controller(fixtureConfig(), "reader");
    const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
    const frame = chars(setup);
    expect(frame).toContain("● stale");
    expect(frame).toContain("another tokenhud is ingesting");
    expect(frame.split("\n")[49]).toMatchSnapshot();
  });

  test("before the first view models: the frame, and a line saying the store is being read", async () => {
    const c = new Controller(initialState(fixtureConfig(), "owner"), ports, "America/Toronto");
    const setup = await render(<Frame controller={c} width={80} height={24} />, 80, 24);
    expect(chars(setup)).toMatchSnapshot();
  });

  test("an error shows above the view", async () => {
    const c = controller();
    c.vmMessage({ type: "error", message: "cannot read the store: database is locked" });
    const setup = await render(<Frame controller={c} width={80} height={24} />, 80, 24);
    expect(chars(setup).split("\n")[2]).toBe(
      ` cannot read the store: database is locked${" ".repeat(38)}`,
    );
  });

  test("help overlay", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
    await settle(setup, () => {
      c.key(key("2"));
      c.key(key("?"));
    });
    expect(chars(setup)).toMatchSnapshot();
  });

  test("settings: the list, then a picker", async () => {
    const c = controller();
    c.vmMessage({
      type: "roots",
      roots: [
        {
          provider: "claude",
          label: "personal",
          path: "/home/someone/.claude",
          source: "auto",
          enabled: true,
          historyOnly: false,
          identity: "fixture-identity-personal",
          disabledBy: [],
          configIndex: null,
        },
      ],
    });
    const setup = await render(<Frame controller={c} width={105} height={30} />, 105, 30);
    await settle(setup, () => c.key(key("s")));
    const list = chars(setup);
    await settle(setup, () => {
      c.key({ name: "down", sequence: "", ctrl: false });
      c.key({ name: "down", sequence: "", ctrl: false });
      c.key({ name: "down", sequence: "", ctrl: false });
      c.key({ name: "return", sequence: "\r", ctrl: false });
    });
    expect(`${list}\n${chars(setup)}`).toMatchSnapshot();
  });

  test("a scope shows in the header and filters the Overview", async () => {
    const work = accounts.find((a) => a.label === "work") as AccountInfo;
    const c = controller();
    c.vmMessage({
      type: "views",
      views: fixtureViews(fixture.storePath, fixtureConfig(), work.id).views,
      accounts,
      scope: work.id,
      ms: 1,
    });
    const setup = await render(<Frame controller={c} width={120} height={45} />, 120, 45);
    const frame = chars(setup);
    expect(frame.split("\n")[0]).toContain("scope work ▾");
    expect(frame).toContain("work · claude");
    expect(frame).not.toContain("personal · claude");
  });

  test("show cost off: tokens only", async () => {
    const c = controller(fixtureConfig({ show_cost: false }));
    const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
    const frame = chars(setup);
    expect(frame).not.toContain("$");
    expect(frame).toContain("tokens per 20 min");
  });

  test("a terminal too small says so instead of drawing a broken frame", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={38} height={8} />, 38, 8);
    expect(chars(setup).split("\n")[0]?.trimEnd()).toBe("tokenhud needs 40×10 or more");
  });
});

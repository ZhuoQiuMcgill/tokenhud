// The frame and every view at the four sizes the user runs (T10 §4): 105×50 and 120×45
// (half screens), 80×24, 160×50. Deterministic: a fixture store (the Overview's, with
// limits, events and MCP agents), a fixed clock, and view models computed exactly as the
// view-model Worker computes them.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.ts";
import { Heartbeat, readMcpActivity } from "../../src/mcp/heartbeat.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { money, tokens } from "../../src/tui/format.ts";
import { theme } from "../../src/tui/theme.ts";
import { costText } from "../../src/tui/views/cells.ts";
import type {
  AccountInfo,
  AccountsVM,
  ModelsVM,
  OverviewVM,
  Priced,
  ViewModels,
} from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";
import { fixtureConfig } from "./fixture.ts";
import { makeOverviewFixture, type OverviewFixture } from "./overview-fixture.ts";
import { chars, cleanupRenderers, render, roles, settle } from "./render.ts";

guard();

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

let fixture: OverviewFixture;
let views: ViewModels;
let accounts: AccountInfo[];
beforeAll(() => {
  fixture = makeOverviewFixture();
  ({ views, accounts } = fixture.views());
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
  c.vmMessage({ type: "mcp", activity: { servers: 1, agents: 2, recent: [], latest: [] } });
  if (mode === "owner") c.setIngest("live");
  return c;
}

const key = (name: string) => ({ name, sequence: name, ctrl: false });

/** The tab strip each view draws, and its active tab at first: marked in text too. */
const STRIPS: Readonly<Record<string, string | null>> = {
  overview: "[24h]",
  history: "[this week]",
  models: "[all]",
  accounts: null,
};

describe.each(SIZES)("%i×%i", (width, height) => {
  test.each(VIEWS)("view %s (%s)", async (k, name) => {
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
    // T17: a view with tabs shows them, its active tab marked, with the keys that switch them.
    // The Overview's strip heads its activity chart, which this fixture's five limit cards
    // leave no room for at 80×24: the chart goes, as before, and so do a/d and t (the PM's
    // ruling on critique M1).
    const strip = roles(setup.captureSpans(), theme("dark"))
      .split("\n")
      .find((l) => l.includes("◀ a"));
    const chartless = name === "overview" && height === 24;
    expect(frame.includes("ACTIVITY")).toBe(name === "overview" && !chartless);
    if (STRIPS[name] === null || chartless) expect(strip).toBeUndefined();
    else {
      expect(strip).toContain(" d ▶");
      expect(strip).toContain(`[head/tab/b]${STRIPS[name]}`);
    }
    // Two footer lines from 30 rows (the view's keys, then the global ones), else one.
    const rule = lines.findLastIndex((l) => l.startsWith("─"));
    expect(height - 1 - rule).toBe(height >= 30 ? 2 : 1);
    expect(lines[height - 1]).toContain("? help");
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

// Critique m2: below the narrow breakpoint, columns and sections go and numbers turn
// compact, but no number is ever cut.
describe.each([
  [50, 20],
  [60, 20],
] as const)("narrow %i×%i", (width, height) => {
  test.each(VIEWS)("view %s (%s): every number whole", async (k, name) => {
    const c = controller();
    const setup = await render(
      <Frame controller={c} width={width} height={height} />,
      width,
      height,
    );
    await settle(setup, () => c.key(key(k)));
    const frame = chars(setup);
    for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    expect(frame).not.toMatch(/[\d$%*]…|…\d/);
    // The Overview's numbers have their own checker (overview.test.tsx).
    const priced: Priced[] =
      name === "models"
        ? [...(views.models as ModelsVM).rows]
        : name === "accounts"
          ? // The detail of the selected (first) account: its 30-day spend.
            [((views.accounts as AccountsVM).rows[0] as AccountsVM["rows"][number]).last30]
          : [];
    for (const p of priced) {
      const forms = [costText(p).text, costText(p, true).text];
      expect(forms.some((f) => frame.includes(f))).toBe(true);
    }
    expect(frame).toMatchSnapshot();
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

// PM addendum (b): the footer's MCP status and agent count come from T9's heartbeat files.
describe("footer MCP status, from the heartbeat files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tokenhud-mcp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function footer(now: number): Promise<string> {
    const c = controller();
    c.vmMessage({ type: "mcp", activity: readMcpActivity(dir, now) });
    const setup = await render(<Frame controller={c} width={105} height={30} />, 105, 30);
    return roles(setup.captureSpans(), theme("dark")).split("\n")[29] as string;
  }

  test("two servers that called tools in the last 10 min: MCP ● 2 agents", async () => {
    const now = Date.now();
    for (const pid of [process.pid, process.ppid]) {
      new Heartbeat(dir, { pid, now: () => now - 60_000 }).record("usage", null);
    }
    const line = await footer(now);
    expect(line).toContain("[live/bg]●");
    expect(line).toMatchSnapshot();
  });

  test("no heartbeat in the last 10 min: a dim MCP ○", async () => {
    const now = Date.now();
    new Heartbeat(dir, { pid: process.pid, now: () => now - 11 * 60_000 }).record("usage", null);
    const line = await footer(now);
    expect(line).toContain("[dim/bg]MCP ○");
    expect(line).not.toContain("agent");
    expect(line).toMatchSnapshot();
  });
});

describe("footer update note, from the once-a-day check", () => {
  async function footer(c: Controller, width: number): Promise<string> {
    const setup = await render(<Frame controller={c} width={width} height={24} />, width, 24);
    return roles(setup.captureSpans(), theme("dark")).split("\n")[23] as string;
  }

  test("a newer release shows dimly beside the hints", async () => {
    const c = controller();
    c.setUpdate("0.2.0");
    const line = await footer(c, 105);
    expect(line).toContain("[dim/bg]update 0.2.0 available");
    expect(line).toContain("[head/bg/b]?[dim/bg] help");
  });

  test("a newer prerelease says it takes --prerelease", async () => {
    const c = controller();
    c.setUpdate("0.2.0-rc.1");
    expect(await footer(c, 105)).toContain("[dim/bg]update 0.2.0-rc.1 available (--prerelease)");
  });

  test("not with the check switched off, nor where it would crowd out the hints", async () => {
    const off = controller(fixtureConfig({ update_check: false }));
    off.setUpdate("0.2.0");
    expect(await footer(off, 105)).not.toContain("update");
    const narrow = controller();
    narrow.setUpdate("0.2.0");
    expect(await footer(narrow, 40)).not.toContain("update");
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

  test("help overlay: how to move, this view's keys with its tab names, the global keys", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
    await settle(setup, () => {
      c.key(key("2"));
      c.key(key("?"));
    });
    const frame = chars(setup);
    const at = (text: string) => frame.indexOf(text);
    expect(at("MOVE")).toBeGreaterThan(0);
    expect(at("MOVE")).toBeLessThan(at("HISTORY"));
    expect(at("HISTORY")).toBeLessThan(at("GLOBAL"));
    expect(frame).toContain("WASD works like the arrow keys");
    expect(frame).toContain("this week · this month · days · weeks · months");
    expect(frame).toMatchSnapshot();
    for (const k of ["escape", "return", "?", "q"]) {
      await settle(setup, () => {
        c.key(key("?"));
        c.key(key(k));
      });
      expect(c.getState().overlay).toBe("none");
    }
  });

  test("help at 80×24: the moves whole, WASD said, every global key; this view's cut first", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={80} height={24} />, 80, 24);
    await settle(setup, () => {
      c.key(key("2"));
      c.key(key("?"));
    });
    const frame = chars(setup);
    expect(frame).toContain("a/d  ←/→             Switch the tab: what the view shows");
    expect(frame).toContain("w/s  ↑/↓             Move the selection: which row or card");
    expect(frame).toContain("WASD works like the arrow keys");
    expect(frame).toContain("1-4 views · tab next view · c account · x settings · ? help · q quit");
    expect(frame).toContain("f  /                 Filter every number by model");
    for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  });

  test("help on a screen too short for every key of the view: a line counts the rest", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={80} height={20} />, 80, 20);
    await settle(setup, () => {
      c.key(key("2"));
      c.key(key("?"));
    });
    const frame = chars(setup);
    expect(frame).toContain("WASD works like the arrow keys");
    expect(frame).toMatch(/\+\d more: a taller terminal shows them/);
    expect(frame).toContain("? help · q quit");
  });

  test("the action menu over settings sits inside the settings card: its borders whole", async () => {
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
          identity: (accounts.find((a) => a.label === "personal") as AccountInfo).identity,
          disabledBy: [],
          configIndex: null,
        },
      ],
    });
    const setup = await render(<Frame controller={c} width={105} height={30} />, 105, 30);
    await settle(setup, () => {
      for (const k of ["x", "end", "return", "return"]) c.key(key(k));
    });
    const lines = chars(setup).split("\n");
    expect(lines.find((l) => l.includes("╭─ Settings › Accounts"))).toMatch(
      /^ +╭─ Settings › Accounts ─+╮ +$/,
    );
    const bottom = lines.findLastIndex((l) => l.includes("╰"));
    expect(lines[bottom]).toMatch(/^ +╰─+╯ +$/);
    expect(lines.slice(0, bottom).join("\n")).toContain("╭─ personal · claude");
    expect(chars(setup)).toContain("› Show only this account");
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
          group: null,
        },
      ],
    });
    const setup = await render(<Frame controller={c} width={105} height={30} />, 105, 30);
    await settle(setup, () => c.key(key("x")));
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
      views: fixture.views(work.id).views,
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

  test("80×24 scoped to one account: the Overview has room for its chart, and its strip", async () => {
    const work = accounts.find((a) => a.label === "work") as AccountInfo;
    const c = controller();
    c.vmMessage({
      type: "views",
      views: fixture.views(work.id).views,
      accounts,
      scope: work.id,
      ms: 1,
    });
    const setup = await render(<Frame controller={c} width={80} height={24} />, 80, 24);
    const strip = roles(setup.captureSpans(), theme("dark"))
      .split("\n")
      .find((l) => l.includes("ACTIVITY"));
    expect(strip).toContain("[head/tab/b][24h]");
    expect(strip).toContain("[dim/bg]◀ a ");
  });

  test("show cost off: tokens only", async () => {
    const c = controller(fixtureConfig({ show_cost: false }));
    const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
    const frame = chars(setup);
    expect(frame).not.toContain("$");
    expect(frame).toContain("tokens per 15 min");
  });

  test("a terminal too small says so instead of drawing a broken frame", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={38} height={8} />, 38, 8);
    expect(chars(setup).split("\n")[0]?.trimEnd()).toBe("tokenhud needs 40×10 or more");
  });
});

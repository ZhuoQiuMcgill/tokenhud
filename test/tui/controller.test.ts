// The UI thread's state machine: global keys, view keys, the account scope, overlays, and
// what it asks of the runtime (ports). No I/O, no Workers: ports are recorded.
import { describe, expect, test } from "bun:test";
import { type Config, defaultConfig } from "../../src/config.ts";
import { Controller, initialState, type Key, type Ports } from "../../src/tui/controller.ts";
import type {
  AccountInfo,
  HistoryDay,
  HistoryVM,
  RootInfo,
  VmSettings,
} from "../../src/tui/vm/types.ts";

const key = (name: string, sequence = name.length === 1 ? name : ""): Key => ({
  name,
  sequence,
  ctrl: false,
});

function setup(config: Config = defaultConfig()) {
  const calls: string[] = [];
  const saved: Config[] = [];
  const settings: VmSettings[] = [];
  const ports: Ports = {
    saveConfig: (c) => {
      saved.push(c);
      calls.push("save");
    },
    vmSettings: (s) => {
      settings.push(s);
      calls.push("vmSettings");
    },
    vmConfig: () => calls.push("vmConfig"),
    vmRoots: () => calls.push("vmRoots"),
    accountsEdited: () => calls.push("accountsEdited"),
    quit: () => calls.push("quit"),
  };
  const c = new Controller(initialState(config, "owner"), ports, "America/Toronto");
  return { c, calls, saved, settings, s: () => c.getState() };
}

const accounts: AccountInfo[] = [
  { id: 1, label: "personal", provider: "claude", historyOnly: false },
  { id: 2, label: "work", provider: "claude", historyOnly: false },
  { id: 4, label: "codex", provider: "codex", historyOnly: false },
];

describe("global keys", () => {
  test("1–4 switch views; the same key again is no switch", () => {
    const { c, s } = setup();
    let notified = 0;
    c.subscribe(() => notified++);
    c.key(key("2"));
    expect(s().view).toBe("history");
    expect(c.switchStartedAt).not.toBeNull();
    c.key(key("4"));
    c.key(key("3"));
    expect(s().view).toBe("models");
    c.switchStartedAt = null;
    c.key(key("3"));
    expect(c.switchStartedAt).toBeNull();
    c.key(key("1"));
    expect(s().view).toBe("overview");
    expect(notified).toBe(4);
  });

  test("q and Ctrl-C quit; Ctrl-C even from settings", () => {
    const { c, calls } = setup();
    c.key(key("q"));
    c.key(key("s"));
    c.key({ name: "c", sequence: "\x03", ctrl: true });
    expect(calls.filter((x) => x === "quit")).toHaveLength(2);
  });

  test("? opens help; Esc, ? or q close it, and other keys do nothing meanwhile", () => {
    const { c, s, calls } = setup();
    c.key(key("?"));
    expect(s().overlay).toBe("help");
    c.key(key("2"));
    expect(s().view).toBe("overview");
    c.key(key("q"));
    expect(s().overlay).toBe("none");
    expect(calls).not.toContain("quit");
    c.key(key("?"));
    c.key(key("escape"));
    expect(s().overlay).toBe("none");
  });

  test("a cycles the scope all → each account → all, saving it and telling the Worker", () => {
    const { c, s, saved, settings } = setup();
    c.vmMessage({ type: "views", views: {}, accounts, scope: null, ms: 1 });
    const seen: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      c.key(key("a"));
      seen.push(s().scope);
    }
    expect(seen).toEqual([1, 2, 4, null]);
    expect(saved.map((cfg) => cfg.account_scope)).toEqual(["personal", "work", "codex", "all"]);
    expect(settings.map((x) => x.scope)).toEqual([1, 2, 4, null]);
  });

  test("a with no accounts yet does nothing", () => {
    const { c, calls } = setup();
    c.key(key("a"));
    expect(calls).toEqual([]);
  });

  test("other keys go to the active view, whose state the shell keeps", () => {
    const { c, s } = setup();
    c.vmMessage({ type: "views", views: { history: historyVM() }, accounts, scope: null, ms: 1 });
    c.key(key("2"));
    c.key(key("up"));
    c.key(key("left"));
    expect(s().viewState.history).toMatchObject({ day: "2026-09-21" });
    c.key(key("1"));
    c.key(key("2"));
    expect(s().viewState.history).toMatchObject({ day: "2026-09-21" }); // kept across switches
    c.key(key("x"));
    expect(s().viewState.history).toMatchObject({ day: "2026-09-21" });
  });

  test("a printable key reaches the view as typed, so W is not w", () => {
    const { c, s } = setup();
    c.vmMessage({ type: "views", views: { history: historyVM() }, accounts, scope: null, ms: 1 });
    c.key(key("2"));
    c.key({ name: "w", sequence: "W", ctrl: false });
    expect(s().viewState.history).toMatchObject({ group: "day", open: "week" });
    c.key({ name: "w", sequence: "w", ctrl: false });
    expect(s().viewState.history).toMatchObject({ group: "week", open: null });
  });

  test("while a view types into a field, the shell's keys go to it; Ctrl-C still quits", () => {
    const { c, s, calls } = setup();
    c.vmMessage({ type: "views", views: { history: historyVM() }, accounts, scope: null, ms: 1 });
    c.key(key("2"));
    for (const k of ["/", "q", "1", "a", "s", "?"]) c.key(key(k));
    expect(s()).toMatchObject({ view: "history", overlay: "none", scope: null });
    expect(s().viewState.history).toMatchObject({ typing: true, filter: "q1as?" });
    expect(calls).toEqual([]);
    c.key(key("return"));
    c.key(key("1"));
    expect(s().view).toBe("overview");
    c.key(key("2"));
    c.key(key("/"));
    c.key({ name: "c", sequence: "\u0003", ctrl: true });
    expect(calls).toEqual(["quit"]);
  });
});

/** History's view model: 59 empty days, Aug 2 to Tue Sep 29, all on the heat map. */
function historyVM(): HistoryVM {
  const first = Date.UTC(2026, 7, 2);
  const zero = {
    cost: 0,
    tokens: 0,
    pricedShare: 1,
    estimatedCost: 0,
    input: 0,
    output: 0,
    cache: 0,
  };
  const day = (i: number): HistoryDay => ({
    ...zero,
    key: new Date(first + i * 86_400_000).toISOString().slice(0, 10),
    days: 1,
    models: [],
    accounts: [],
    events: [],
  });
  return {
    days: Array.from({ length: 59 }, (_, i) => day(i)),
    gridStart: 0,
    weeks: [],
    months: [],
    weeksTotal: zero,
    monthsTotal: zero,
    average: { cost: 0, tokens: 0 },
  };
}

describe("Worker messages", () => {
  test("views merge into what's there; an error shows until the next views", () => {
    const { c, s } = setup();
    c.vmMessage({ type: "error", message: "cannot read the store: busy" });
    expect(s().error).toBe("cannot read the store: busy");
    c.vmMessage({ type: "views", views: {}, accounts, scope: 2, ms: 1 });
    expect(s().error).toBeNull();
    expect(s().scope).toBe(2);
    expect(s().accounts).toEqual(accounts);
  });

  test("mode and ingest status", () => {
    const { c, s } = setup();
    expect(s().ingest).toBe("starting");
    c.setIngest("live");
    expect(s().ingest).toBe("live");
    c.setMode("reader");
    expect(s()).toMatchObject({ mode: "reader", ingest: "starting" });
  });
});

describe("settings", () => {
  const root: RootInfo = {
    provider: "claude",
    label: "work",
    path: "/home/someone/.claude-work",
    source: "home",
    enabled: true,
    historyOnly: false,
    identity: "fixture-identity-work",
    disabledBy: [],
    configIndex: null,
  };

  test("s opens it (asking for fresh roots); a value change is saved and applied", () => {
    const { c, s, calls, saved, settings } = setup();
    c.key(key("s"));
    expect(s().overlay).toBe("settings");
    expect(calls).toEqual(["vmRoots"]);
    // Theme: down ×3, enter, then pick "light".
    for (const k of ["down", "down", "down", "return", "down", "return"]) c.key(key(k));
    expect(s().config.theme).toBe("light");
    expect(saved[saved.length - 1]?.theme).toBe("light");
    // The theme is display-only: the Worker hears nothing.
    expect(settings).toEqual([]);
    // Default window changes the Models view model.
    for (const k of ["up", "up", "return", "home", "return"]) c.key(key(k));
    expect(s().config.default_window).toBe("today");
    expect(settings[settings.length - 1]).toEqual({ tz: null, window: "today", scope: null });
    c.key(key("escape"));
    expect(s().overlay).toBe("none");
    expect(calls).not.toContain("accountsEdited");
  });

  test("account edits go to the Worker at once and restart ingest when settings close", () => {
    const { c, s, calls } = setup();
    c.vmMessage({ type: "roots", roots: [root] });
    c.key(key("s"));
    c.key(key("end"));
    c.key(key("return"));
    expect(s().settings.screen).toBe("accounts");
    c.key(key("e"));
    expect(s().config.disabled_roots).toEqual(["/home/someone/.claude-work"]);
    expect(calls).toContain("vmConfig");
    expect(calls).not.toContain("accountsEdited");
    c.key(key("escape"));
    c.key(key("escape"));
    expect(calls[calls.length - 1]).toBe("accountsEdited");
  });

  test("a config that can't be saved shows why, and the change still applies for this run", () => {
    const failing = new Controller(initialState(defaultConfig(), "owner"), {
      saveConfig: () => {
        throw new Error("EACCES");
      },
      vmSettings: () => {},
      vmConfig: () => {},
      vmRoots: () => {},
      accountsEdited: () => {},
      quit: () => {},
    });
    failing.key(key("s"));
    for (const k of ["down", "down", "return", "down", "return"]) failing.key(key(k));
    expect(failing.getState().config.show_cost).toBe(false);
    expect(failing.getState().error).toBe("settings not saved: EACCES");
  });
});

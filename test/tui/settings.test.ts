// The settings screen's state machine (a port of cc-usage's keyboard-driven settings) and
// the config edits behind its account editor.
import { describe, expect, test } from "bun:test";
import { type Config, defaultConfig } from "../../src/config.ts";
import {
  filterZones,
  initialSettings,
  labelProblem,
  renameRoot,
  rowValue,
  type SettingsInput,
  type SettingsState,
  settingsKey,
  toggleEnabled,
  toggleHistoryOnly,
} from "../../src/tui/settings.ts";
import type { RootInfo } from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";

guard();

const root = (over: Partial<RootInfo>): RootInfo => ({
  provider: "claude",
  label: "personal",
  path: "/home/someone/.claude",
  source: "auto",
  enabled: true,
  historyOnly: false,
  identity: "id-personal",
  disabledBy: [],
  configIndex: null,
  ...over,
});

const ROOTS: RootInfo[] = [
  root({}),
  root({
    label: "work",
    path: "/home/someone/.claude-work",
    source: "home",
    identity: "id-work",
  }),
  root({
    label: "company",
    path: "/elsewhere/.claude-company",
    source: "env",
    identity: "id-env",
  }),
  root({
    provider: "codex",
    label: "codex-win",
    path: "/mnt/c/Users/someone/.codex",
    source: "config",
    identity: "id-codex-win",
    enabled: false,
    disabledBy: ["/mnt/c/Users/someone/.codex"],
    configIndex: 0,
  }),
];

function input(config: Config = defaultConfig()): SettingsInput {
  return {
    config,
    roots: ROOTS,
    zones: ["system", "America/Toronto", "Asia/Kolkata", "Europe/Paris"],
    systemZone: "America/Toronto",
  };
}

/** Feeds keys (OpenTUI names; single characters type themselves) and follows the config. */
function drive(keys: string[], config = defaultConfig(), start: SettingsState = initialSettings()) {
  let state: SettingsState | null = start;
  let cfg = config;
  let accountsChanged = false;
  for (const name of keys) {
    if (state === null) break;
    const r = settingsKey(state, { name, sequence: name.length === 1 ? name : "" }, input(cfg));
    state = r.state;
    if (r.config) cfg = r.config;
    if (r.accountsChanged) accountsChanged = true;
  }
  return { state, config: cfg, accountsChanged };
}

describe("the main list", () => {
  test("rows show the current values", () => {
    const config: Config = { ...defaultConfig(), time_zone: "Asia/Kolkata", show_cost: false };
    const values = (["refresh", "window", "cost", "theme", "tz", "accounts"] as const).map((r) =>
      rowValue(r, input(config)),
    );
    expect(values).toEqual(["5 s", "all-time", "off", "dark", "Asia/Kolkata", "3 of 4 enabled"]);
    expect(rowValue("tz", input())).toBe("system (America/Toronto)");
  });

  test("↑/↓ move within the list; Esc, q or s close", () => {
    expect(drive(["down", "down", "up"]).state).toEqual({
      screen: "main",
      cursor: 1,
      message: null,
    });
    expect(drive(["up"]).state).toMatchObject({ cursor: 0 });
    expect(drive(["end", "down"]).state).toMatchObject({ cursor: 5 });
    for (const k of ["escape", "q", "s"]) expect(drive([k]).state).toBeNull();
  });
});

describe("picking a value from a list", () => {
  test.each([
    [["return", "down", "return"], "refresh_interval", 10],
    [["down", "return", "home", "return"], "default_window", "today"],
    [["down", "down", "return", "down", "return"], "show_cost", false],
    [["down", "down", "down", "return", "end", "return"], "theme", "high-contrast"],
  ] as const)("%j sets %s to %p", (keys, field, value) => {
    const { state, config } = drive([...keys]);
    expect(config[field]).toBe(value as never);
    expect(state).toMatchObject({ screen: "main" });
  });

  test("the picker starts on the current value; Esc keeps it", () => {
    const config = { ...defaultConfig(), refresh_interval: 30 };
    const { state } = drive(["return"], config);
    expect(state).toMatchObject({ screen: "choice", row: "refresh", pick: 3 });
    expect(drive(["return", "up", "escape"], config).config.refresh_interval).toBe(30);
  });
});

describe("time zone", () => {
  test("type to filter, pick with Enter", () => {
    expect(filterZones(input().zones, "par")).toEqual(["Europe/Paris"]);
    expect(filterZones(input().zones, "")).toHaveLength(4);
    const tz = ["down", "down", "down", "down", "return"];
    expect(drive([...tz, "k", "o", "l", "return"]).config.time_zone).toBe("Asia/Kolkata");
    expect(drive([...tz, "return"]).config.time_zone).toBe("system");
  });

  test("Backspace edits the filter; no match says so; Esc keeps the zone", () => {
    const tz = ["down", "down", "down", "down", "return"];
    const { state } = drive([...tz, "x", "y", "backspace"]);
    expect(state).toMatchObject({ screen: "tz", filter: "x" });
    expect(drive([...tz, "z", "z", "return"]).state).toMatchObject({ message: "no zone matches" });
    expect(drive([...tz, "p", "escape"]).config.time_zone).toBe("system");
  });
});

describe("accounts", () => {
  const open = ["end", "return"];

  test("e disables an enabled root by its path, and re-enables a disabled one", () => {
    const off = drive([...open, "down", "e"]);
    expect(off.config.disabled_roots).toEqual(["/home/someone/.claude-work"]);
    expect(off.accountsChanged).toBe(true);
    const config: Config = {
      ...defaultConfig(),
      disabled_roots: ["/mnt/c/Users/someone/.codex", "/elsewhere"],
      codex_roots: [{ path: "/mnt/c/Users/someone/.codex", label: "codex-win", enabled: false }],
    };
    const on = drive([...open, "end", "e"], config);
    expect(on.config.disabled_roots).toEqual(["/elsewhere"]);
    expect(on.config.codex_roots).toEqual([
      { path: "/mnt/c/Users/someone/.codex", label: "codex-win" },
    ]);
  });

  test("h marks a root history-only by its identity, and unmarks it", () => {
    expect(drive([...open, "h"]).config.history_only_roots).toEqual(["id-personal"]);
    const config = { ...defaultConfig(), history_only_roots: ["id-personal", "other"] };
    expect(toggleHistoryOnly(config, ROOTS[0] as RootInfo).history_only_roots).toEqual(["other"]);
  });

  test("l renames: a new config entry for a found root, the entry's label for a configured one", () => {
    const renamed = drive([
      ...open,
      "down",
      "l",
      ...Array(4).fill("backspace"),
      "j",
      "o",
      "b",
      "return",
    ]);
    expect(renamed.config.claude_roots).toEqual([
      { path: "/home/someone/.claude-work", label: "job" },
    ]);
    expect(renamed.accountsChanged).toBe(true);
    expect(renamed.state).toMatchObject({ screen: "accounts", pick: 1 });
    const config: Config = {
      ...defaultConfig(),
      codex_roots: [{ path: "/mnt/c/Users/someone/.codex", label: "codex-win" }],
    };
    expect(renameRoot(config, ROOTS[3] as RootInfo, "laptop").codex_roots).toEqual([
      { path: "/mnt/c/Users/someone/.codex", label: "laptop" },
    ]);
  });

  test("the default root is renamed through a config entry for its path", () => {
    const renamed = drive([
      ...open,
      "l",
      ...Array(8).fill("backspace"),
      "m",
      "a",
      "i",
      "n",
      "return",
    ]);
    expect(renamed.config.claude_roots).toEqual([{ path: "/home/someone/.claude", label: "main" }]);
    expect(renamed.accountsChanged).toBe(true);
    expect(renamed.state).toMatchObject({ screen: "accounts", pick: 0, message: null });
  });

  test("the env root is renamed the same way", () => {
    const keys = [...open, "down", "down", "l", ...Array(7).fill("backspace"), "x", "return"];
    expect(drive(keys).config.claude_roots).toEqual([
      { path: "/elsewhere/.claude-company", label: "x" },
    ]);
  });

  test("bad labels are refused with a reason, and Esc leaves the label as it was", () => {
    const work = ROOTS[1] as RootInfo;
    expect(labelProblem("", work, ROOTS)).toBe("a label can't be empty");
    expect(labelProblem("all", work, ROOTS)).toBe("'all' is reserved for the all-accounts scope");
    expect(labelProblem("personal", work, ROOTS)).toBe("'personal' is taken");
    expect(labelProblem("x".repeat(25), work, ROOTS)).toBe("a label is at most 24 characters");
    expect(labelProblem("work", work, ROOTS)).toBeNull();
    // A store-only account (imported, or an old machine's) keeps its label (critique m9).
    const store = [{ label: "personal" }, { label: "work" }, { label: "old-laptop" }];
    expect(labelProblem("old-laptop", work, ROOTS, store)).toBe("'old-laptop' is taken");
    expect(labelProblem("work", work, ROOTS, store)).toBeNull();
    expect(labelProblem("new-name", work, ROOTS, store)).toBeNull();
    const clash = drive([
      ...open,
      "down",
      "l",
      ...Array(4).fill("backspace"),
      "a",
      "l",
      "l",
      "return",
    ]);
    expect(clash.state).toMatchObject({
      screen: "rename",
      message: "'all' is reserved for the all-accounts scope",
    });
    expect(clash.config.claude_roots).toEqual([]);
    expect(drive([...open, "down", "l", "x", "escape"]).config.claude_roots).toEqual([]);
  });

  test("toggleEnabled leaves other config alone", () => {
    const config: Config = { ...defaultConfig(), disabled_roots: ["/a"] };
    expect(toggleEnabled(config, ROOTS[0] as RootInfo)).toEqual({
      ...config,
      disabled_roots: ["/a", "/home/someone/.claude"],
    });
  });
});

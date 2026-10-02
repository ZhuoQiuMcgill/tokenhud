// The settings screen's state machine (a port of cc-usage's keyboard-driven settings) and
// the config edits behind its account editor. Keys are named as the shell names them
// (keys.ts): WASD already the arrows outside a text field.
import { describe, expect, test } from "bun:test";
import { type Config, defaultConfig } from "../../src/config.ts";
import { menuItems } from "../../src/tui/menu.ts";
import {
  filterZones,
  initialSettings,
  labelProblem,
  linkCandidates,
  linkRoots,
  renameRoot,
  rowValue,
  SETTINGS_ROWS,
  type SettingsInput,
  type SettingsState,
  settingsKey,
  toggleEnabled,
  toggleHistoryOnly,
  unlinkRoot,
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
  group: null,
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

/** Feeds keys (single characters type themselves) and follows the config. */
function drive(keys: string[], config = defaultConfig(), start: SettingsState = initialSettings()) {
  let state: SettingsState | null = start;
  let cfg = config;
  let accountsChanged = false;
  let menu: number | undefined;
  for (const name of keys) {
    if (state === null) break;
    const r = settingsKey(state, name, input(cfg));
    state = r.state;
    if (r.config) cfg = r.config;
    if (r.accountsChanged) accountsChanged = true;
    if (r.menu !== undefined) menu = r.menu;
  }
  return { state, config: cfg, accountsChanged, menu };
}

/** The label prompt for root `pick`, as the action menu's Rename opens it. */
const renaming = (pick: number): SettingsState => ({
  screen: "rename",
  cursor: SETTINGS_ROWS.indexOf("accounts"),
  pick,
  text: (ROOTS[pick] as RootInfo).label,
  message: null,
});

describe("the main list", () => {
  test("rows show the current values", () => {
    const config: Config = { ...defaultConfig(), time_zone: "Asia/Kolkata", show_cost: false };
    const values = SETTINGS_ROWS.map((r) => rowValue(r, input(config)));
    expect(values).toEqual([
      "5 s",
      "all-time",
      "off",
      "dark",
      "Asia/Kolkata",
      "on",
      "3 of 4 enabled",
    ]);
    expect(rowValue("tz", input())).toBe("system (America/Toronto)");
  });

  test("↑/↓ move within the list; Esc, x or q close", () => {
    expect(drive(["down", "down", "up"]).state).toEqual({
      screen: "main",
      cursor: 1,
      message: null,
    });
    expect(drive(["up"]).state).toMatchObject({ cursor: 0 });
    expect(drive(["end", "down"]).state).toMatchObject({ cursor: 6 });
    for (const k of ["escape", "x", "q"]) expect(drive([k]).state).toBeNull();
  });

  test("←/→ step a row's value in place, round the ends; not the time zone's or the accounts'", () => {
    expect(drive(["right"]).config.refresh_interval).toBe(10);
    expect(drive(["left", "left"]).config.refresh_interval).toBe(30);
    expect(drive(["down", "left"]).config.default_window).toBe("this_month");
    expect(drive(["down", "down", "right"]).config.show_cost).toBe(false);
    expect(drive(["down", "down", "down", "left"]).config.theme).toBe("high-contrast");
    expect(drive(["end", "up", "right"]).config.update_check).toBe(false);
    expect(drive(["end", "up", "up", "right"]).config).toEqual(defaultConfig());
    expect(drive(["end", "left"]).config).toEqual(defaultConfig());
    expect(drive(["right"]).state).toEqual({ screen: "main", cursor: 0, message: null });
  });

  test("keys a screen doesn't list do nothing", () => {
    for (const k of ["e", "t", "1", "space", "backspace"]) {
      expect(drive([k])).toEqual({
        state: initialSettings(),
        config: defaultConfig(),
        accountsChanged: false,
        menu: undefined,
      });
    }
    expect(drive(["end", "return", "e", "h", "l"]).state).toMatchObject({
      screen: "accounts",
      pick: 0,
    });
  });
});

describe("picking a value from a list", () => {
  test.each([
    [["return", "down", "return"], "refresh_interval", 10],
    [["down", "return", "home", "return"], "default_window", "today"],
    [["down", "down", "return", "down", "return"], "show_cost", false],
    [["down", "down", "down", "return", "end", "return"], "theme", "high-contrast"],
    [["end", "up", "return", "down", "return"], "update_check", false],
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

  test("Enter asks for the selected root's action menu; Esc or q go back to the list", () => {
    expect(drive([...open, "down", "return"])).toMatchObject({
      state: { screen: "accounts", pick: 1 },
      menu: 1,
    });
    for (const k of ["escape", "q"]) {
      expect(drive([...open, k]).state).toEqual({ screen: "main", cursor: 6, message: null });
    }
  });

  test("toggleEnabled disables an enabled root by its path, and re-enables a disabled one", () => {
    const off = toggleEnabled(defaultConfig(), ROOTS[1] as RootInfo);
    expect(off.disabled_roots).toEqual(["/home/someone/.claude-work"]);
    const config: Config = {
      ...defaultConfig(),
      disabled_roots: ["/mnt/c/Users/someone/.codex", "/elsewhere"],
      codex_roots: [{ path: "/mnt/c/Users/someone/.codex", label: "codex-win", enabled: false }],
    };
    const on = toggleEnabled(config, ROOTS[3] as RootInfo);
    expect(on.disabled_roots).toEqual(["/elsewhere"]);
    expect(on.codex_roots).toEqual([{ path: "/mnt/c/Users/someone/.codex", label: "codex-win" }]);
  });

  test("toggleHistoryOnly marks a root history-only by its identity, and unmarks it", () => {
    expect(toggleHistoryOnly(defaultConfig(), ROOTS[0] as RootInfo).history_only_roots).toEqual([
      "id-personal",
    ]);
    const config = { ...defaultConfig(), history_only_roots: ["id-personal", "other"] };
    expect(toggleHistoryOnly(config, ROOTS[0] as RootInfo).history_only_roots).toEqual(["other"]);
  });

  test("renaming: a new config entry for a found root, the entry's label for a configured one", () => {
    const renamed = drive(
      [...Array(4).fill("backspace"), "j", "o", "b", "return"],
      undefined,
      renaming(1),
    );
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

  test("the label is a text field: w, a, s, d, x, q and space are typed", () => {
    const typed = drive(
      [...Array(8).fill("backspace"), "w", "a", "s", "d", "space", "x", "q"],
      undefined,
      renaming(0),
    );
    expect(typed.state).toMatchObject({ screen: "rename", text: "wasd xq" });
  });

  test("the default root is renamed through a config entry for its path", () => {
    const renamed = drive(
      [...Array(8).fill("backspace"), "m", "a", "i", "n", "return"],
      undefined,
      renaming(0),
    );
    expect(renamed.config.claude_roots).toEqual([{ path: "/home/someone/.claude", label: "main" }]);
    expect(renamed.accountsChanged).toBe(true);
    expect(renamed.state).toMatchObject({ screen: "accounts", pick: 0, message: null });
  });

  test("the env root is renamed the same way", () => {
    const keys = [...Array(7).fill("backspace"), "x", "return"];
    expect(drive(keys, undefined, renaming(2)).config.claude_roots).toEqual([
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
    const clash = drive(
      [...Array(4).fill("backspace"), "a", "l", "l", "return"],
      undefined,
      renaming(1),
    );
    expect(clash.state).toMatchObject({
      screen: "rename",
      message: "'all' is reserved for the all-accounts scope",
    });
    expect(clash.config.claude_roots).toEqual([]);
    expect(drive(["x", "escape"], undefined, renaming(1)).config.claude_roots).toEqual([]);
  });

  test("toggleEnabled leaves other config alone", () => {
    const config: Config = { ...defaultConfig(), disabled_roots: ["/a"] };
    expect(toggleEnabled(config, ROOTS[0] as RootInfo)).toEqual({
      ...config,
      disabled_roots: ["/a", "/home/someone/.claude"],
    });
  });
});

describe("shared accounts (T16): same account as…, unlink", () => {
  /** The roots, with personal and work on one account. */
  const linked = (source: "auto" | "manual"): RootInfo[] =>
    ROOTS.map((r) =>
      r.identity === "id-personal"
        ? { ...r, group: { others: ["id-work"], source } }
        : r.identity === "id-work"
          ? { ...r, group: { others: ["id-personal"], source } }
          : r,
    );

  /** The list to pick from for root `pick`, as the action menu's "Same account as…" opens it. */
  const linking = (pick: number): SettingsState => ({
    screen: "link",
    cursor: SETTINGS_ROWS.indexOf("accounts"),
    pick,
    choice: 0,
    message: null,
  });

  function driveRoots(
    roots: RootInfo[],
    keys: string[],
    start: SettingsState,
    config = defaultConfig(),
  ) {
    let state: SettingsState | null = start;
    let cfg = config;
    for (const name of keys) {
      if (state === null) break;
      const r = settingsKey(state, name, { ...input(cfg), roots });
      state = r.state;
      if (r.config) cfg = r.config;
    }
    return { state, config: cfg };
  }

  /** The action menu's items for `root`, as settings would list them. */
  const items = (root: RootInfo, roots: RootInfo[] = ROOTS) =>
    menuItems(
      { identity: root.identity, label: root.label, provider: root.provider, account: null },
      { config: defaultConfig(), roots, scope: null },
    ).map((i) => i.label);

  test("the menu's Same account as… picks another root of the provider; enter links them", () => {
    expect(items(ROOTS[0] as RootInfo)).toContain("Same account as…");
    expect(linkCandidates(ROOTS[0] as RootInfo, ROOTS).map((r) => r.label)).toEqual([
      "work",
      "company",
    ]);
    const done = drive(["down", "return"], undefined, linking(0));
    expect(done.config.same_account).toEqual([["id-personal", "id-env"]]);
    expect(done.accountsChanged).toBe(true);
    expect(done.state).toMatchObject({ screen: "accounts", pick: 0 });
    // w/s move there too; Esc or q leave the config as it was.
    expect(drive(["down", "up"], undefined, linking(0)).state).toMatchObject({ choice: 0 });
    for (const k of ["escape", "q"]) {
      expect(drive([k], undefined, linking(0))).toMatchObject({
        state: { screen: "accounts", pick: 0 },
        config: { same_account: [] },
      });
    }
  });

  test("roots already linked are not offered; with none to link to, the menu doesn't offer it", () => {
    expect(
      linkCandidates(linked("auto")[0] as RootInfo, linked("auto")).map((r) => r.label),
    ).toEqual(["company"]);
    expect(linkCandidates(ROOTS[3] as RootInfo, ROOTS)).toEqual([]);
    expect(items(ROOTS[3] as RootInfo)).not.toContain("Same account as…");
  });

  test("linking joins the entry either root is in, and drops a separate pair between them", () => {
    const config: Config = {
      ...defaultConfig(),
      same_account: [
        ["id-personal", "id-work"],
        ["x", "y"],
      ],
      separate_accounts: [
        ["id-env", "id-work"],
        ["id-env", "z"],
      ],
    };
    const after = linkRoots(config, ROOTS[2] as RootInfo, ROOTS[1] as RootInfo);
    expect(after.same_account).toEqual([
      ["x", "y"],
      ["id-personal", "id-work", "id-env"],
    ]);
    expect(after.separate_accounts).toEqual([["id-env", "z"]]);
  });

  test("disabled roots are not offered: a link to one would do nothing", () => {
    const roots = ROOTS.map((r) => (r.identity === "id-work" ? { ...r, enabled: false } : r));
    expect(linkCandidates(roots[0] as RootInfo, roots).map((r) => r.label)).toEqual(["company"]);
  });

  test("linking drops the separate pairs between the root and every root on the target's account", () => {
    // The critic's case: work unlinked from {personal, work, company} (kept apart from both),
    // then linked back to personal, whose account company is still on.
    const config: Config = {
      ...defaultConfig(),
      same_account: [["id-personal", "id-env"]],
      separate_accounts: [
        ["id-work", "id-personal"],
        ["id-work", "id-env"],
        ["id-env", "z"],
      ],
    };
    const personal = {
      ...(ROOTS[0] as RootInfo),
      group: { others: ["id-env"], source: "manual" as const },
    };
    const after = linkRoots(config, ROOTS[1] as RootInfo, personal);
    expect(after.same_account).toEqual([["id-personal", "id-env", "id-work"]]);
    expect(after.separate_accounts).toEqual([["id-env", "z"]]);
  });

  test("linking two accounts works both ways, and says which separate pairs it undid", () => {
    // The critic's case: work unlinked from {personal, work, company}; then personal (still
    // on company's account) picks work. Before, only work picking personal worked.
    const config: Config = {
      ...defaultConfig(),
      same_account: [["id-personal", "id-env"]],
      separate_accounts: [
        ["id-work", "id-personal"],
        ["id-work", "id-env"],
      ],
    };
    const onAccount = (r: RootInfo, others: string[]): RootInfo => ({
      ...r,
      group: { others, source: "manual" },
    });
    const roots = ROOTS.map((r) =>
      r.identity === "id-personal"
        ? onAccount(r, ["id-env"])
        : r.identity === "id-env"
          ? onAccount(r, ["id-personal"])
          : r,
    );
    const [personal, work] = roots as [RootInfo, RootInfo];
    for (const [a, b] of [
      [personal, work],
      [work, personal],
    ] as const) {
      const after = linkRoots(config, a, b);
      expect(after.separate_accounts).toEqual([]);
      expect(after.same_account).toHaveLength(1);
      expect([...(after.same_account[0] as string[])].sort()).toEqual([
        "id-env",
        "id-personal",
        "id-work",
      ]);
    }
    // Through the keys: personal (first) picks work (its only candidate), with a message.
    const done = driveRoots(roots, ["return"], linking(0), config);
    expect(done.config.separate_accounts).toEqual([]);
    expect(done.state).toMatchObject({
      screen: "accounts",
      message: "no longer kept apart: work | personal, work | company",
    });
  });

  test("unlinking: out of same_account, and kept apart from every root it shared with", () => {
    const config: Config = {
      ...defaultConfig(),
      same_account: [["id-personal", "id-work", "x"]],
    };
    const manual = unlinkRoot(config, linked("manual")[0] as RootInfo);
    expect(manual.same_account).toEqual([["id-work", "x"]]);
    expect(manual.separate_accounts).toEqual([["id-personal", "id-work"]]);
    // An auto-detected link is kept apart the same way, so it isn't found again.
    const auto = unlinkRoot(defaultConfig(), linked("auto")[1] as RootInfo);
    expect(auto.separate_accounts).toEqual([["id-work", "id-personal"]]);
    expect(unlinkRoot(auto, linked("auto")[1] as RootInfo)).toEqual(auto);
    // Only a linked root's menu offers Unlink.
    expect(items(linked("auto")[0] as RootInfo, linked("auto"))).toContain("Unlink");
    expect(items(ROOTS[0] as RootInfo)).not.toContain("Unlink");
  });
});

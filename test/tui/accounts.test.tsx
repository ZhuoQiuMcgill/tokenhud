// The Accounts view (T13): the view model's roots, limits, weekly history and agents on
// the T13 fixture; the weekly slots on their own; the keys (scope, enable, rename,
// history-only, add a root) through the controller; the session's limits.json and MCP
// refreshes; and snapshots at the four sizes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.ts";
import type { LimitEvent, LimitWindow } from "../../src/limits/index.ts";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Ports } from "../../src/tui/controller.ts";
import { money } from "../../src/tui/format.ts";
import { type AccountsState, ADD_ROOT, highest } from "../../src/tui/views/accounts.tsx";
import { costText } from "../../src/tui/views/cells.ts";
import {
  type AccountRow,
  type AccountsVM,
  homePath,
  WEEKS_SHOWN,
  weeklySlots,
} from "../../src/tui/vm/accounts.ts";
import { type Timers, VmSession } from "../../src/tui/vm/session.ts";
import type { AccountInfo, RootInfo, ViewModels, VmMessage } from "../../src/tui/vm/types.ts";
import { fixtureConfig, NOW, TZ } from "./fixture.ts";
import {
  HOME,
  limitsFile,
  MCP,
  makeT13Fixture,
  type T13Fixture,
  t13Views,
  WEEKLY_RESET,
} from "./fixture-t13.ts";
import { chars, cleanupRenderers, render, settle } from "./render.ts";

cleanupRenderers();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

let fx: T13Fixture;
let views: ViewModels;
let accounts: AccountInfo[];
let vm: AccountsVM;

beforeAll(() => {
  fx = makeT13Fixture();
  ({ views, accounts } = t13Views(fx));
  vm = views.accounts as AccountsVM;
});
afterAll(() => fx.remove());

const byLabel = (label: string) => vm.rows.find((r) => r.label === label) as AccountRow;

describe("the view model", () => {
  test("accounts active here first, then history-only and disabled; by cost in each", () => {
    expect(
      vm.rows
        .map((r) => r.label)
        .slice(3)
        .sort(),
    ).toEqual(["codex-win", "old-laptop"]);
    const active = vm.rows.slice(0, 3);
    expect(active.map((r) => r.label).sort()).toEqual(["codex", "personal", "work"]);
    expect(active.map((r) => r.cost)).toEqual([...active.map((r) => r.cost)].sort((a, b) => b - a));
    expect(vm.mcp).toBe(true);
  });

  test("roots: the directory with ~, watched or polled, enabled or not", () => {
    expect(byLabel("personal").root).toEqual({ path: "~/.claude", enabled: true, polled: false });
    expect(byLabel("work").root).toEqual({
      path: "/mnt/c/Users/someone/.claude",
      enabled: true,
      polled: true,
    });
    expect(byLabel("codex-win").root).toMatchObject({ enabled: false });
    expect(byLabel("old-laptop")).toMatchObject({ historyOnly: true, root: { enabled: true } });
    expect(homePath(`${HOME}/.claude`, HOME)).toBe("~/.claude");
    expect(homePath(`${HOME}x/.claude`, HOME)).toBe(`${HOME}x/.claude`);
    expect(homePath(HOME, HOME)).toBe("~");
  });

  test("limits: the captured windows, when, the failed fetch; none for disabled roots", () => {
    const personal = byLabel("personal").limits;
    expect(personal).toEqual({
      signedIn: true,
      asOf: NOW - 90_000,
      error: null,
      windows: [
        { kind: "session", label: "5-HOUR", utilization: 0.62, resetsAt: NOW + HOUR + 48 * MIN },
        { kind: "weekly_all", label: "WEEKLY", utilization: 0.27, resetsAt: WEEKLY_RESET },
        { kind: "weekly_scoped", label: "FABLE WEEKLY", utilization: 0, resetsAt: WEEKLY_RESET },
      ],
    });
    expect(highest(byLabel("personal"), NOW)).toBe(0.62);
    expect(highest(byLabel("work"), NOW)).toBe(0.92);
    expect(byLabel("work").limits?.error).toBe("HTTP 429");
    expect(byLabel("codex").limits?.windows.map((w) => w.utilization)).toEqual([0.08, 0.83]);
    // History-only: listed, not signed in, never fetched.
    expect(byLabel("old-laptop").limits).toMatchObject({ signedIn: false, windows: [] });
    expect(highest(byLabel("old-laptop"), NOW)).toBeNull();
    expect(byLabel("codex-win").limits).toBeNull();
  });

  test("weekly usage at its last 8 resets, from the capture and the limit events", () => {
    const slots = byLabel("personal").weekly ?? [];
    expect(slots.map((s) => s.resetsAt)).toEqual(
      Array.from({ length: WEEKS_SHOWN }, (_, i) => WEEKLY_RESET - (WEEKS_SHOWN - 1 - i) * WEEK),
    );
    expect(slots.map((s) => [s.value, s.source])).toEqual([
      [null, null],
      [1, "reached"],
      [null, null],
      [null, null],
      [1, "reached"],
      [null, null],
      [0.8, "passed_80"],
      [0.27, "now"],
    ]);
    const codex = byLabel("codex").weekly ?? [];
    expect(codex.map((s) => s.source)).toEqual([
      null,
      null,
      null,
      null,
      null,
      "reached",
      null,
      "now",
    ]);
    expect(byLabel("old-laptop").weekly).toBeNull();
  });

  test("30 days of spend, top models with both tiers together, the last MCP call", () => {
    const personal = byLabel("personal");
    expect(personal.spark).toHaveLength(30);
    expect(personal.sparkTokens).toHaveLength(30);
    expect(personal.spark.reduce((a, b) => a + b, 0)).toBeCloseTo(personal.last30.cost, 9);
    const opus = personal.topModels.filter((m) => m.name === "Opus 5.5");
    expect(opus).toHaveLength(1);
    expect(personal.topModels.map((m) => m.cost)).toEqual(
      [...personal.topModels.map((m) => m.cost)].sort((a, b) => b - a),
    );
    expect(personal.agent).toEqual({ at: NOW - 12_000, tool: "get_limits", calls: 2 });
    expect(byLabel("work").agent).toBeNull();
  });

  test("no MCP server: no agents line to give", () => {
    const quiet = t13Views(fx, fixtureConfig(), null, null).views.accounts as AccountsVM;
    expect(quiet.mcp).toBe(false);
    expect(quiet.rows.every((r) => r.agent === null)).toBe(true);
  });
});

describe("weekly slots", () => {
  const week = (over: Partial<LimitWindow> = {}): LimitWindow => ({
    kind: "weekly_all",
    label: "WEEKLY",
    utilization: 0.4,
    resets_at: NOW + 2 * DAY,
    window_s: WEEK / 1000,
    pace_cost_per_h: null,
    projected_exhaustion_at: null,
    stale_s: 0,
    ...over,
  });
  const event = (
    kind: LimitEvent["kind"],
    resetsAt: number,
    window = "weekly_all",
  ): LimitEvent => ({
    account: { id: "x", label: "x", provider: "claude" },
    kind,
    window,
    label: "WEEKLY",
    resets_at: resetsAt,
    at: resetsAt - DAY,
    resumed_at: null,
  });

  test("an event belongs to the week whose reset is nearest, jitter and all", () => {
    const r = NOW + 2 * DAY;
    const slots = weeklySlots(
      [week()],
      [event("reached", r - WEEK + 900), event("passed_80", r - 2 * WEEK - 600)],
      NOW,
    );
    expect(slots?.slice(-3).map((s) => s.value)).toEqual([0.8, 1, 0.4]);
  });

  test("other windows' events don't count; no weekly window, no chart", () => {
    const r = NOW + 2 * DAY;
    expect(
      weeklySlots([week()], [event("reached", r - WEEK, "session")], NOW)?.[6]?.value,
    ).toBeNull();
    expect(weeklySlots([week({ kind: "session", window_s: 18_000 })], [], NOW)).toBeNull();
  });

  test("a Codex 7-day window counts; a per-model weekly one doesn't", () => {
    const codex = week({ kind: "codex_secondary" });
    expect(weeklySlots([codex], [], NOW)?.[7]).toMatchObject({ value: 0.4, source: "now" });
    expect(weeklySlots([week({ kind: "weekly_scoped" })], [], NOW)).toBeNull();
  });

  test("a capture of a week that has since reset: this week is the one after it", () => {
    const old = week({ resets_at: NOW - DAY, utilization: 0 });
    const slots = weeklySlots([old], [], NOW) ?? [];
    expect(slots[7]).toEqual({ resetsAt: NOW - DAY + WEEK, value: null, source: "now" });
    expect(slots[6]?.resetsAt).toBe(NOW - DAY);
  });
});

// ── keys, through the controller ─────────────────────────────────────────────────

const roots: RootInfo[] = [
  {
    provider: "claude",
    label: "personal",
    path: `${HOME}/.claude`,
    source: "auto",
    enabled: true,
    historyOnly: false,
    identity: "fixture-identity-personal",
    disabledBy: [],
    configIndex: null,
  },
];

function setup(config: Config = fixtureConfig()) {
  const calls: string[] = [];
  const saved: Config[] = [];
  const ports: Ports = {
    saveConfig: (c) => {
      saved.push(c);
      calls.push("save");
    },
    vmSettings: (s) => calls.push(`vmSettings:${s.scope}`),
    vmConfig: () => calls.push("vmConfig"),
    vmRoots: () => calls.push("vmRoots"),
    accountsEdited: () => calls.push("accountsEdited"),
    quit: () => calls.push("quit"),
  };
  const c = new Controller(initialState(config, "owner"), ports, TZ);
  c.vmMessage({ type: "views", views, accounts, scope: null, ms: 1 });
  c.vmMessage({ type: "roots", roots });
  c.key(key("4"));
  return { c, calls, saved, s: () => c.getState() };
}

const key = (name: string) => ({ name, sequence: name.length === 1 ? name : "", ctrl: false });

/** Moves the selection to `label`'s row of `list`. */
function select(c: Controller, label: string, list: AccountsVM = vm) {
  const at = list.rows.findIndex((r) => r.label === label);
  for (let i = 0; i < at; i++) c.key(key("down"));
}

describe("keys", () => {
  test("↑/↓ select by account; the last entry is + add a root…", () => {
    const { c, s } = setup();
    const state = () => s().viewState.accounts as AccountsState;
    expect(state().selected).toBeNull();
    c.key(key("down"));
    expect(state().selected).toBe((vm.rows[1] as AccountRow).id);
    for (let i = 0; i < 10; i++) c.key(key("down"));
    expect(state().selected).toBe(ADD_ROOT);
    c.key(key("up"));
    expect(state().selected).toBe((vm.rows[vm.rows.length - 1] as AccountRow).id);
  });

  test("Enter scopes everything to the account, saved by label; Enter again: all", () => {
    const { c, s, calls, saved } = setup();
    select(c, "personal");
    c.key(key("return"));
    const personal = accounts.find((a) => a.label === "personal") as AccountInfo;
    expect(s().scope).toBe(personal.id);
    expect(saved.at(-1)?.account_scope).toBe("personal");
    expect(calls).toEqual(["save", `vmSettings:${personal.id}`]);
    c.key(key("return"));
    expect(s().scope).toBeNull();
    expect(saved.at(-1)?.account_scope).toBe("all");
  });

  test("e disables the account's root, as the settings editor does, and restarts ingest", () => {
    const { c, s, calls } = setup();
    select(c, "personal");
    c.key(key("e"));
    expect(s().config.disabled_roots).toEqual([`${HOME}/.claude`]);
    expect(calls).toEqual(["save", "vmConfig", "accountsEdited"]);
  });

  test("e twice, before the roots are discovered again, restores the config: no duplicates", () => {
    const { c, s, calls } = setup();
    select(c, "personal");
    c.key(key("e"));
    c.key(key("e"));
    expect(s().config.disabled_roots).toEqual([]);
    c.key(key("e"));
    expect(s().config.disabled_roots).toEqual([`${HOME}/.claude`]);
    expect(calls.filter((x) => x === "save")).toHaveLength(3);
  });

  test("h toggles history-only for the account's root", () => {
    const { c, s } = setup();
    select(c, "personal");
    c.key(key("h"));
    expect(s().config.history_only_roots).toContain("fixture-identity-personal");
    c.key(key("h"));
    expect(s().config.history_only_roots).not.toContain("fixture-identity-personal");
  });

  test("l renames in the settings prompt, then comes back to the view", () => {
    const { c, s, calls } = setup();
    select(c, "personal");
    c.key(key("l"));
    expect(s().overlay).toBe("settings");
    expect(s().settings).toMatchObject({ screen: "rename", text: "personal" });
    for (let i = 0; i < "personal".length; i++) c.key(key("backspace"));
    for (const ch of "main") c.key(key(ch));
    c.key(key("return"));
    expect(s().overlay).toBe("none");
    expect(s().view).toBe("accounts");
    expect(s().config.claude_roots).toEqual([{ path: `${HOME}/.claude`, label: "main" }]);
    expect(calls).toEqual(["save", "vmConfig", "accountsEdited"]);
    // Esc in the prompt changes nothing and also comes back.
    c.key(key("l"));
    c.key(key("escape"));
    expect(s().overlay).toBe("none");
  });

  test("an account with no root here says so instead of editing anything", () => {
    const { c, s, calls } = setup();
    select(c, "work");
    c.key(key("e"));
    expect(s().error).toBe("work has no root on this machine: nothing to change");
    expect(calls).toEqual([]);
  });

  test("Enter on + add a root… opens the settings account editor", () => {
    const { c, s, calls } = setup();
    for (let i = 0; i < 10; i++) c.key(key("down"));
    c.key(key("return"));
    expect(s().overlay).toBe("settings");
    expect(s().settings).toMatchObject({ screen: "accounts", pick: 0 });
    expect(calls).toEqual(["vmRoots"]);
    // Keys go to the editor now: e there toggles its first root.
    c.key(key("e"));
    expect(calls).toEqual(["vmRoots", "save", "vmConfig"]);
  });
});

// ── frames ───────────────────────────────────────────────────────────────────────

function controller(
  config: Config = fixtureConfig(),
  v: ViewModels = views,
  list: AccountInfo[] = accounts,
) {
  const c = new Controller(
    initialState(config, "owner"),
    {
      saveConfig() {},
      vmSettings() {},
      vmConfig() {},
      vmRoots() {},
      accountsEdited() {},
      quit() {},
    },
    TZ,
  );
  c.vmMessage({ type: "views", views: v, accounts: list, scope: null, ms: 1 });
  c.vmMessage({ type: "mcp", activity: MCP });
  c.setIngest("live");
  c.key(key("4"));
  return c;
}

async function frameAt(
  width: number,
  height: number,
  label: string | null = "personal",
  v: ViewModels = views,
  list: AccountInfo[] = accounts,
) {
  const c = controller(fixtureConfig(), v, list);
  const setup = await render(<Frame controller={c} width={width} height={height} />, width, height);
  await settle(setup, () => {
    if (label !== null) select(c, label, v.accounts as AccountsVM);
  });
  return chars(setup);
}

function noCutNumbers(frame: string) {
  expect(frame).not.toMatch(/[\d$%*]…|…[\d$]/);
}

describe("frames", () => {
  test.each([
    [105, 50],
    [120, 45],
    [80, 24],
    [160, 50],
  ] as const)("%i×%i, personal selected", async (width, height) => {
    const frame = await frameAt(width, height);
    for (const line of frame.split("\n").slice(0, height)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    }
    noCutNumbers(frame);
    const personal = byLabel("personal");
    expect(frame).toContain("limits fetched 11:38:30");
    expect(frame).toContain("62%");
    expect(frame).toContain(costText(personal.last30).text);
    for (const r of vm.rows) {
      const u = highest(r, NOW);
      if (u !== null) expect(frame).toContain(`${Math.round(u * 100)}%`);
    }
    expect(frame).toMatchSnapshot();
  });

  test.each([
    ["old-laptop", "not signed in here"],
    ["codex-win", "this root is disabled"],
    ["work", "last fetch failed: HTTP 429"],
  ])("105×50, %s: %s", async (label, text) => {
    const frame = await frameAt(105, 50, label);
    expect(frame).toContain(text);
    expect(frame).toMatchSnapshot();
  });

  test("60×20: the detail under the list, numbers whole", async () => {
    const frame = await frameAt(60, 20);
    noCutNumbers(frame);
    expect(frame).toContain(money(byLabel("personal").last30.cost));
    expect(frame).toMatchSnapshot();
  });

  test("+ add a root… selected: what Enter does", async () => {
    const c = controller();
    const setup = await render(<Frame controller={c} width={105} height={30} />, 105, 30);
    await settle(setup, () => {
      for (let i = 0; i < 10; i++) c.key(key("down"));
    });
    expect(chars(setup)).toContain("enter opens the settings account editor");
  });
});

// Critique m1: between 72 and 91 columns (side by side, narrow detail) and at 80×24, no
// line is cut: the meters shrink their bar, then drop "resets", then the bar; notes and
// annotations have shorter forms.
describe("no line cut at the side-by-side widths", () => {
  const widths = [...Array.from({ length: 20 }, (_, i) => 72 + i), 60, 66, 71, 100, 120, 160];
  test.each([24, 50])("height %i, every account, widths 60–160", async (height) => {
    for (const width of widths) {
      for (const label of vm.rows.map((r) => r.label)) {
        const frame = await frameAt(width, height, label);
        const cut = frame
          .split("\n")
          .filter((l) => l.replace("add a root…", "add a root").includes("…"));
        expect({ width, label, cut }).toEqual({ width, label, cut: [] });
      }
    }
  });

  test("80×24, the disabled account: its note whole", async () => {
    const frame = await frameAt(80, 24, "codex-win");
    expect(frame).toContain("root disabled (e enables it)");
    expect(frame.replace("add a root…", "")).not.toContain("…");
  });
});

// Critique m2: a capture from before the windows running now is stale: never a current 0%.
describe("a stale capture", () => {
  let stale: T13Fixture;
  let sv: ViewModels;
  let sa: AccountInfo[];
  const CAPTURED = NOW - 10 * DAY;
  beforeAll(() => {
    const file = limitsFile();
    const personal = "fixture-identity-personal";
    const s = (ms: number) => ms / 1000;
    (file.providers as Record<string, unknown>)[personal] = {
      captured_at: s(CAPTURED),
      source: "claude",
      via: "api",
      rate_limits: {
        session: { label: "5-HOUR", used_percentage: 64, resets_at: s(CAPTURED + 3 * HOUR) },
        weekly_all: { label: "WEEKLY", used_percentage: 64, resets_at: s(NOW - 6 * DAY) },
      },
    };
    stale = makeT13Fixture(file);
    ({ views: sv, accounts: sa } = t13Views(stale));
  });
  afterAll(() => stale.remove());

  test("the list shows the capture's age, the meters a dash and when they reset", async () => {
    const list = sv.accounts as AccountsVM;
    const personal = list.rows.find((r) => r.label === "personal") as AccountRow;
    expect(highest(personal, NOW)).toBeNull();
    const frame = await frameAt(105, 50, "personal", sv, sa);
    const row = frame.split("\n").find((l) => /[●○] personal /.test(l));
    expect(row).toContain("10d");
    expect(row).not.toContain("0%");
    expect(frame).toContain("reset 6d ago");
    expect(frame).not.toMatch(/WEEKLY.*\b0%/);
  });

  test("the chart's this-week bar is unknown, and the note says why", async () => {
    const personal = (sv.accounts as AccountsVM).rows.find((r) => r.label === "personal");
    expect(personal?.weekly?.[7]).toMatchObject({ value: null, source: "now" });
    const frame = await frameAt(105, 50, "personal", sv, sa);
    expect(frame).toContain("this week isn't captured yet");
  });
});

// Critique m3: an account T8 detected as not signed in is inactive, like a configured one.
test("an account detected as not signed in: ○, listed with the inactive ones", async () => {
  const file = limitsFile();
  (file.status as Record<string, unknown>)["fixture-identity-personal"] = {
    signed_in: false,
    history_only: "detected",
    checked_at: NOW - HOUR,
    cred_mtime: null,
    errors: 0,
    last_error: null,
    last_attempt_at: NOW - HOUR,
    next_at: NOW + DAY,
  };
  const out = makeT13Fixture(file);
  try {
    const { views: v, accounts: list } = t13Views(out);
    const rows = (v.accounts as AccountsVM).rows.map((r) => r.label);
    expect(rows.slice(2).sort()).toEqual(["codex-win", "old-laptop", "personal"]);
    const frame = await frameAt(105, 50, "personal", v, list);
    expect(frame).toContain("○ personal");
    expect(frame).toContain("(watched, not signed in)");
    expect(frame).toContain("not signed in here");
  } finally {
    out.remove();
  }
});

test("a list cut short says how many accounts are off screen", async () => {
  const frame = await frameAt(60, 20, null);
  expect(frame).toMatch(/\d more ↓/);
});

// ── the session: limits.json and MCP activity refresh the view ──────────────────

class FakeTimers implements Timers {
  now = 0;
  readonly #queue = new Map<number, { at: number; fn: () => void }>();
  #next = 1;
  monotonic(): number {
    return this.now;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#queue.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#queue.delete(handle as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#queue]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#queue.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = end;
  }
}

describe("the session", () => {
  test("a rewritten limits.json or a new MCP call recomputes the Accounts view and the Overview, only", () => {
    const own = makeT13Fixture();
    const mcp = mkdtempSync(join(tmpdir(), "tokenhud-t13-mcp-"));
    const timers = new FakeTimers();
    const posted: VmMessage[] = [];
    const session = new VmSession(
      {
        type: "start",
        storePath: own.storePath,
        overridesPath: join(own.dir, "none.json"),
        mcpDir: mcp,
        limitsPath: own.limitsPath,
        cachePath: join(own.dir, "cache.db"),
        mode: "owner",
        settings: { tz: TZ, window: "all", scope: null },
        scopeLabel: null,
        config: fixtureConfig(),
        discover: { home: join(own.dir, "home"), env: { TOKENHUD_WSL_USERS: "" } },
        now: NOW,
      },
      (m) => posted.push(m),
      timers,
    );
    try {
      session.begin();
      const views = () =>
        posted.filter((m) => m.type === "views") as Extract<VmMessage, { type: "views" }>[];
      // The roots are read before the first frame (T11): no second round for them.
      timers.advance(1000);
      expect(views().map((v) => Object.keys(v.views).length)).toEqual([4]);
      session.handle({ type: "tick" });
      timers.advance(1000);
      expect(views()).toHaveLength(1); // nothing changed

      // The fetcher rewrites limits.json: the next tick notices.
      const later = new Date(Date.now() + 5000);
      writeFileSync(own.limitsPath, `${JSON.stringify({ providers: {}, status: {} })}\n`);
      utimesSync(own.limitsPath, later, later);
      session.handle({ type: "tick" });
      timers.advance(1000);
      expect(views()).toHaveLength(2);
      expect(Object.keys(views()[1]?.views ?? {})).toEqual(["overview", "accounts"]);

      // An MCP server records a call.
      writeFileSync(
        join(mcp, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          started_at: Date.now(),
          updated_at: Date.now(),
          calls: [{ at: Date.now(), tool: "usage", account: "personal" }],
        }),
      );
      session.handle({ type: "tick" });
      timers.advance(1000);
      expect(views()).toHaveLength(3);
      expect(Object.keys(views()[2]?.views ?? {})).toEqual(["overview", "accounts"]);
    } finally {
      session.close();
      rmSync(mcp, { recursive: true, force: true });
      own.remove();
    }
  });
});

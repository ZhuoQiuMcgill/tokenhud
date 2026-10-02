// The key contract, version 2 (T17): WASD and the arrows are one movement scheme in every
// view, overlay and the action menu; a view acts only on keys its keymap lists, and never on
// the reserved ones; the footer always shows how to move.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Frame } from "../../src/tui/app.tsx";
import { Controller, initialState, type Key, type Ports } from "../../src/tui/controller.ts";
import { isText, keyName, RESERVED, TEXT } from "../../src/tui/keys.ts";
import { VIEWS } from "../../src/tui/views/index.ts";
import { activeKeymap, viewKey } from "../../src/tui/views/types.ts";
import type { AccountInfo, RootInfo, ViewId, ViewModels } from "../../src/tui/vm/types.ts";
import { guard } from "../guard.ts";
import { fixtureConfig } from "./fixture.ts";
import { makeOverviewFixture, type OverviewFixture } from "./overview-fixture.ts";
import { chars, cleanupRenderers, render } from "./render.ts";

guard();

cleanupRenderers();

let fixture: OverviewFixture;
let views: ViewModels;
let accounts: AccountInfo[];
let roots: RootInfo[];
beforeAll(() => {
  fixture = makeOverviewFixture();
  ({ views, accounts } = fixture.views());
  // A root for two of the store's accounts, so the menu has every item for them.
  roots = accounts.slice(0, 2).map((a) => ({
    provider: a.provider === "codex" ? "codex" : "claude",
    label: a.label,
    path: `/home/someone/.${a.label}`,
    source: "auto",
    enabled: true,
    historyOnly: false,
    identity: a.identity,
    disabledBy: [],
    configIndex: null,
  }));
});
afterAll(() => fixture.remove());

/** A key as OpenTUI reports it: a typed character, or a named key. */
function typed(k: string): Key {
  if (k.length === 1) return { name: k.toLowerCase(), sequence: k, ctrl: false };
  return { name: k, sequence: "", ctrl: false };
}

/** A controller with every view model, the roots, and the ports' calls recorded. */
function controller(keys: readonly string[]) {
  const calls: string[] = [];
  const ports: Ports = {
    saveConfig: (c) => calls.push(`save ${JSON.stringify(c)}`),
    vmSettings: (s) => calls.push(`vmSettings ${JSON.stringify(s)}`),
    vmConfig: () => calls.push("vmConfig"),
    vmRoots: () => calls.push("vmRoots"),
    accountsEdited: () => calls.push("accountsEdited"),
    quit: () => calls.push("quit"),
  };
  const c = new Controller(initialState(fixtureConfig(), "owner"), ports, "America/Toronto");
  c.vmMessage({ type: "views", views, accounts, scope: null, ms: 1 });
  c.vmMessage({ type: "roots", roots });
  for (const k of keys) c.key(typed(k));
  return { c, calls };
}

/** Where the equivalence is checked: the keys that lead there from the start. */
const PLACES: Readonly<Record<string, readonly string[]>> = {
  "Overview, at first": [],
  "Overview, a card selected": ["down", "down"],
  "History, this week": ["2"],
  "History, every day, a row down": ["2", "right", "right", "down", "down"],
  "History, the weeks, one open": ["2", "left", "left", "down", "return"],
  "History, filtered": ["2", "/", "o", "p", "u", "s", "return", "right", "right"],
  Models: ["3"],
  "Models, a row selected, sorted by tokens": ["3", "down", "r"],
  Accounts: ["4"],
  "Accounts, a row down": ["4", "down"],
  "the action menu, from the view": ["4", "return"],
  "the action menu, an item down": ["4", "return", "down"],
  "settings, the main list": ["x"],
  "settings, a row down": ["x", "down"],
  "settings, a list of values": ["x", "down", "return"],
  "settings, the account editor": ["x", "end", "return"],
  "the action menu, from settings": ["x", "end", "return", "return"],
  "help, from History": ["2", "?"],
};

const PAIRS = [
  ["w", "up"],
  ["a", "left"],
  ["s", "down"],
  ["d", "right"],
] as const;

describe("WASD are the arrows (AC 1)", () => {
  test.each(Object.entries(PLACES))(
    "%s: w a s d, either case, give what ↑ ← ↓ → give",
    (_, keys) => {
      for (const [letter, arrow] of PAIRS) {
        const want = controller([...keys, arrow]);
        for (const k of [letter, letter.toUpperCase()]) {
          const got = controller([...keys, k]);
          expect({ key: k, state: got.c.getState(), calls: got.calls }).toEqual({
            key: k,
            state: want.c.getState(),
            calls: want.calls,
          });
        }
      }
    },
  );

  test.each([
    ["History's filter", ["2", "f"], (c: Controller) => c.getState().viewState.history],
    [
      "the time zone filter",
      ["x", "down", "down", "down", "down", "return"],
      (c: Controller) => c.getState().settings,
    ],
    [
      "a new label",
      ["x", "end", "return", "down", "return", "down", "down", "return"],
      (c: Controller) => c.getState().settings,
    ],
  ] as const)("in %s, they are text", (_, keys, field) => {
    const { c } = controller([...keys, "w", "A", "s", "D"]);
    const text = field(c) as { filter?: string; text?: string };
    expect(text.filter ?? text.text).toEndWith("wAsD");
  });

  test("keyName: lower case letters, WASD as arrows, shift-tab by name", () => {
    expect(["w", "W", "a", "S", "d", "x", "X", "?", "1"].map((k) => keyName(typed(k)))).toEqual([
      "up",
      "up",
      "left",
      "down",
      "right",
      "x",
      "x",
      "?",
      "1",
    ]);
    expect(keyName({ name: "tab", sequence: "\u001b[Z", ctrl: false, shift: true })).toBe(
      "shift-tab",
    );
    expect(keyName({ name: "return", sequence: "\r", ctrl: false })).toBe("return");
    expect(keyName({ name: "a", sequence: "\u0001", ctrl: true })).toBe("ctrl-a");
  });
});

/** Every printable ASCII character, and the named keys a terminal sends. */
const EVERY_KEY = [
  ...Array.from({ length: 0x7f - 0x21 }, (_, i) => String.fromCharCode(0x21 + i)),
  ...["up", "down", "left", "right", "return", "enter", "escape", "tab", "shift-tab", "space"],
  ...["backspace", "delete", "insert", "pageup", "pagedown", "home", "end", "f1", "ctrl-a"],
];

/** The states each view is driven from: as the shell holds them after these keys. */
const STATES: Readonly<Record<ViewId, readonly (readonly string[])[]>> = {
  overview: [[], ["down"], ["down", "t", "right"]],
  history: [
    ["2"],
    ["2", "right", "right", "down"],
    ["2", "left", "left", "down", "return"],
    ["2", "return"],
    ["2", "f"],
    ["2", "f", "o", "p", "return"],
  ],
  models: [["3"], ["3", "down", "return"]],
  accounts: [["4"], ["4", "end"]],
};

describe("a view acts only on the keys its keymap lists (AC 2)", () => {
  test("no view's keymap binds a reserved key: w a s d c x q tab", () => {
    for (const view of Object.values(VIEWS)) {
      const bound = view.keymap.flatMap((e) => e.keys);
      expect({ view: view.id, reserved: bound.filter((k) => RESERVED.includes(k)) }).toEqual({
        view: view.id,
        reserved: [],
      });
    }
  });

  test.each(Object.entries(STATES))(
    "%s: every key that changes something is listed",
    (id, places) => {
      const view = VIEWS[id as ViewId];
      for (const keys of places) {
        const state = controller(keys).c.getState().viewState[id as ViewId];
        const map = activeKeymap(view, state);
        const listed = new Set(map.flatMap((e) => e.keys));
        const text = listed.has(TEXT);
        const acted = EVERY_KEY.filter(
          (k) => viewKey(view, k, state, views[id as ViewId]) !== undefined,
        );
        const unlisted = acted.filter((k) => !listed.has(k) && !(text && isText(k)));
        expect({ id, keys, unlisted }).toEqual({ id, keys, unlisted: [] });
      }
    },
  );
});

describe("the footer says how to move (AC 6)", () => {
  /** Each view's own keys the footer must show; a/d only where the view has tabs. */
  const MUST: Readonly<Record<ViewId, readonly string[]>> = {
    overview: ["a/d window", "w/s card", "enter open", "? help"],
    history: ["a/d period", "w/s row", "enter open", "? help"],
    models: ["a/d window", "w/s model", "enter rates", "? help"],
    accounts: ["w/s account", "enter actions", "? help"],
  };

  test.each([
    [80, 24],
    [105, 50],
    [120, 45],
  ] as const)("%i×%i: every view's footer", async (width, height) => {
    for (const [i, id] of ["overview", "history", "models", "accounts"].entries()) {
      const { c } = controller([String(i + 1)]);
      c.vmMessage({ type: "mcp", activity: { servers: 1, agents: 2, recent: [], latest: [] } });
      const setup = await render(
        <Frame controller={c} width={width} height={height} />,
        width,
        height,
      );
      const lines = chars(setup).split("\n").slice(0, height);
      const footer = height >= 30 ? lines.slice(-2) : lines.slice(-1);
      const missing = MUST[id as ViewId].filter((h) => !footer.join("\n").includes(h));
      expect({ width, id, missing }).toEqual({ width, id, missing: [] });
      if (height >= 30) {
        // Two lines: the view's keys, then the global ones.
        expect(footer[0]).not.toContain("? help");
        expect(footer[1]).toStartWith(" 1-4/tab views   c account   x settings   ? help   q quit");
      }
      setup.renderer.destroy();
    }
  });

  test("esc shows while there is something to go back from", async () => {
    const { c } = controller(["down"]);
    const setup = await render(<Frame controller={c} width={105} height={50} />, 105, 50);
    expect(chars(setup).split("\n")[48]).toContain("esc back");
    const plain = controller([]);
    const other = await render(<Frame controller={plain.c} width={105} height={50} />, 105, 50);
    expect(chars(other).split("\n")[48]).not.toContain("esc");
  });
});

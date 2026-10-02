// The key contract, version 2 (T17): one way to move in every view, within reach of the
// left hand. `a`/`d` (or ←/→) switch the tab, `w`/`s` (or ↑/↓) move the selection, `enter`
// opens it and `esc` goes back one step. The shell turns WASD into the arrow names and
// folds letters to lower case before any view, overlay or settings screen sees a key, so
// Caps Lock changes nothing; only a text field that has the keys (`capturing`) gets them as
// typed.
//
// Every view, overlay and settings screen declares its keys in a keymap: the key names each
// entry answers, how the footer, the help overlay and README show it, and (for a view) what
// it does. A key no entry lists does nothing, so the guidance is complete by construction.

/** A key as OpenTUI reports it: the fields the shell reads. */
export interface Key {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly shift?: boolean;
}

/** In an entry's keys: any printable character, for a text field. */
export const TEXT = "<text>";

/** How a key is shown and what it does, for the footer, the help overlay and README. */
export interface KeyHelp {
  /** The key names it answers, as `keyName` gives them ("up", "return", "t", "/"). */
  readonly keys: readonly string[];
  /** The key as shown: "a/d", "enter", "t". */
  readonly show: string;
  /** Another key for the same thing, in the help and README but not the footer: "←/→". */
  readonly alias?: string;
  /** The footer's word for it: "period". */
  readonly label: string;
  /** The help overlay's and README's sentence for it. */
  readonly does: string;
  /** Left out of the footer; the help and README still list it. */
  readonly quiet?: boolean;
}

/** A view's key: its help, and what it does to the view's state. */
export interface KeyEntry<S, C> extends KeyHelp {
  /** In the footer only while this holds: `esc` while there is something to go back from. */
  readonly when?: (state: S, ctx: C) => boolean;
  /** The new state, or undefined when the key changes nothing here. */
  readonly act: (state: S, ctx: C, key: string) => S | undefined;
}

export type Keymap<S, C> = readonly KeyEntry<S, C>[];

/** Whether `key` is typing: one character as typed, or the space bar. */
export function isText(key: string): boolean {
  return key === "space" || [...key].length === 1;
}

/** The entry of `map` that answers `key`: one naming it, else a text entry for typing. */
export function entryFor<H extends KeyHelp>(map: readonly H[], key: string): H | undefined {
  return (
    map.find((e) => e.keys.includes(key)) ??
    (isText(key) ? map.find((e) => e.keys.includes(TEXT)) : undefined)
  );
}

/** What `key` does to `state` through `map`; undefined for a key the map doesn't list. */
export function dispatch<S, C>(map: Keymap<S, C>, key: string, state: S, ctx: C): S | undefined {
  return entryFor(map, key)?.act(state, ctx, key);
}

/** Entries as the footer shows them, in their order. */
export function footerHints<H extends KeyHelp>(
  map: readonly H[],
  shown: (entry: H) => boolean = () => true,
): { key: string; label: string }[] {
  return map
    .filter((e) => e.quiet !== true && shown(e))
    .map((e) => ({ key: e.show, label: e.label }));
}

/** `w/s move · enter select · esc back`: a dim hint line from entries. */
export function hintText(map: readonly KeyHelp[]): string {
  return footerHints(map)
    .map((h) => `${h.key} ${h.label}`)
    .join(" · ");
}

/**
 * A key as typed: a printable one as its character ("W", "/"), any other by name
 * ("return", "up", "space"), and a Ctrl combination under a name nothing binds. What a text
 * field gets.
 */
export function typedName(key: Key): string {
  if (key.ctrl) return `ctrl-${key.name}`;
  const printable = key.sequence.length === 1 && key.sequence > " " && key.sequence !== "\u007f";
  return printable ? key.sequence : key.name;
}

const WASD: Readonly<Record<string, string>> = { w: "up", a: "left", s: "down", d: "right" };

/**
 * A key as views, overlays and the settings screen see it outside a text field: letters in
 * lower case, so no binding depends on case; WASD as the arrows; shift-tab by that name.
 */
export function keyName(key: Key): string {
  if (key.name === "tab" && (key.shift === true || key.sequence === "\u001b[Z")) {
    return "shift-tab";
  }
  const typed = typedName(key);
  if ([...typed].length !== 1) return typed;
  const lower = typed.toLowerCase();
  return WASD[lower] ?? lower;
}

/** Letters no view may bind: movement and the global keys (WASD never reach a view). */
export const RESERVED: readonly string[] = ["w", "a", "s", "d", "c", "x", "q", "tab", "shift-tab"];

/** The movement every view shares (the help's "Move" section and README's first table). */
export const MOVE_KEYS = {
  tabs: {
    keys: ["left", "right"],
    show: "a/d",
    alias: "←/→",
    label: "tab",
    does: "Switch the tab: what the view shows",
  },
  select: {
    keys: ["up", "down"],
    show: "w/s",
    alias: "↑/↓",
    label: "select",
    does: "Move the selection: which row or card",
  },
  open: { keys: ["return", "enter"], show: "enter", label: "open", does: "Open the selection" },
  back: {
    keys: ["escape"],
    show: "esc",
    label: "back",
    does: "Go back one step: close, un-drill, clear",
  },
} as const satisfies Record<string, KeyHelp>;

/** A view's entry for one of the shared movements, with its own words and action. */
export function moveKey<S, C>(
  kind: keyof typeof MOVE_KEYS,
  own: Omit<KeyEntry<S, C>, "keys" | "show" | "alias">,
): KeyEntry<S, C> {
  const { keys, show } = MOVE_KEYS[kind];
  return { keys, show, ...own };
}

/** The keys every view shares, handled by the shell before a view sees them. */
export const GLOBAL_KEYS = {
  views: {
    keys: ["1", "2", "3", "4"],
    show: "1-4",
    label: "views",
    does: "Switch view: Overview, History, Models, Accounts",
  },
  next: {
    keys: ["tab", "shift-tab"],
    show: "tab",
    alias: "shift-tab",
    label: "next view",
    does: "Next view; shift-tab goes to the previous one",
  },
  scope: {
    keys: ["c"],
    show: "c",
    label: "account",
    does: "Cycle the account scope: all accounts, then each account, then all again",
  },
  settings: { keys: ["x"], show: "x", label: "settings", does: "Open settings" },
  help: { keys: ["?"], show: "?", label: "help", does: "Show the keys, this view's included" },
  quit: { keys: ["q"], show: "q", alias: "Ctrl-C", label: "quit", does: "Quit" },
} as const satisfies Record<string, KeyHelp>;

// The action menu (T17): a small card of what can be done to one account, opened by Enter
// in the Accounts view and in the settings account editor. One component for both places:
// its items, its keys and its lines are here, the shell keeps its state and draws it over
// the screen, and its items run the shell's existing `scope` and `root` commands.
import type { Config } from "../config.ts";
import { type Line, seg } from "./components/base.ts";
import { entryFor, type KeyHelp, MOVE_KEYS } from "./keys.ts";
import { linkCandidates, rootDisabled } from "./settings.ts";
import type { RootInfo } from "./vm/types.ts";

/** What the menu acts on: a root (by identity) and its store account, when it has one. */
export interface MenuTarget {
  readonly identity: string;
  readonly label: string;
  readonly provider: string;
  /** The store account's id; null for a root with nothing stored yet. */
  readonly account: number | null;
}

export interface MenuState {
  readonly target: MenuTarget;
  readonly cursor: number;
  /** Where it opened: a root edit applies as that place's always did. */
  readonly from: "view" | "settings";
}

export type MenuAction = "scope" | "enable" | "rename" | "history" | "link" | "unlink";

export interface MenuItem {
  readonly action: MenuAction;
  readonly label: string;
}

export interface MenuInput {
  readonly config: Config;
  readonly roots: readonly RootInfo[];
  readonly scope: number | null;
}

/** The root `target` comes from on this machine, if it has one here. */
export function menuRoot(target: MenuTarget, roots: readonly RootInfo[]): RootInfo | undefined {
  return roots.find((r) => r.identity === target.identity);
}

/**
 * The items, in the task's order: the scope (for an account the store has), then the
 * root's edits (for a root found here), each saying what it will do now; then T16's: link
 * it to another root on its subscription account, when one could be, and unlink it, when it
 * is linked.
 */
export function menuItems(target: MenuTarget, input: MenuInput): MenuItem[] {
  const items: MenuItem[] = [];
  if (target.account !== null) {
    // Asking for the scope already set goes back to every account (the `scope` command).
    const scoped = input.scope === target.account;
    items.push({ action: "scope", label: scoped ? "Show all accounts" : "Show only this account" });
  }
  const root = menuRoot(target, input.roots);
  if (root !== undefined) {
    const historyOnly = input.config.history_only_roots.includes(root.identity);
    items.push(
      { action: "enable", label: rootDisabled(input.config, root) ? "Enable" : "Disable" },
      { action: "rename", label: "Rename…" },
      { action: "history", label: `History only: ${historyOnly ? "on" : "off"}` },
    );
    if (linkCandidates(root, input.roots).length > 0) {
      items.push({ action: "link", label: "Same account as…" });
    }
    if (root.group !== null) items.push({ action: "unlink", label: "Unlink" });
  }
  return items;
}

export const MENU_KEYS = {
  select: { ...MOVE_KEYS.select, label: "move", does: "Select an action" },
  run: { ...MOVE_KEYS.open, label: "run", does: "Run it" },
  close: { ...MOVE_KEYS.back, label: "close", does: "Close the menu" },
} as const satisfies Record<string, KeyHelp>;

/** The menu's keys, in the footer's order. */
export const MENU_KEYMAP: readonly KeyHelp[] = Object.values(MENU_KEYS);

/**
 * A key in the menu of `count` items: its next state (null closes it) and the item to run,
 * if any. Keys it doesn't list do nothing.
 */
export function menuKey(
  state: MenuState,
  key: string,
  count: number,
): { readonly state: MenuState | null; readonly run?: number } {
  const entry = entryFor(MENU_KEYMAP, key);
  if (entry === MENU_KEYS.select) {
    const cursor = Math.max(0, Math.min(count - 1, state.cursor + (key === "down" ? 1 : -1)));
    return { state: { ...state, cursor } };
  }
  if (entry === MENU_KEYS.run) {
    return count > 0 ? { state: null, run: Math.min(state.cursor, count - 1) } : { state };
  }
  if (entry === MENU_KEYS.close) return { state: null };
  return { state };
}

/** The card's lines: the items with the selected one marked, and why any are missing. */
export function menuLines(state: MenuState, items: readonly MenuItem[], hasRoot: boolean): Line[] {
  const lines: Line[] = items.map((item, i) =>
    i === state.cursor
      ? { left: [seg("› ", "head", true), seg(item.label, "fg")], bg: "sel" }
      : { left: [seg("  ", "fg"), seg(item.label, "fg")] },
  );
  if (!hasRoot) {
    lines.push(
      { left: [] },
      { left: [seg("no root on this machine:", "dim")] },
      { left: [seg("nothing else to change", "dim")] },
    );
  }
  return lines;
}

/** The card's title: `personal · claude`. */
export function menuTitle(target: MenuTarget): string {
  return `${target.label} · ${target.provider}`;
}

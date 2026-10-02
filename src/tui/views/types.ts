import type { ReactNode } from "react";
import { dispatch, type Keymap } from "../keys.ts";
import type { Breakpoint, SectionSpec } from "../layout.ts";
import type { Theme } from "../theme.ts";
import type { ViewId } from "../vm/types.ts";

/** What a view's sections are laid out for. */
export interface ViewContext {
  /** Body width in cells. */
  readonly width: number;
  /** Body rows the sections share; absent when unbounded (`--once` draws them whole). */
  readonly height?: number;
  readonly bp: Breakpoint;
  readonly theme: Theme;
  readonly showCost: boolean;
  /** IANA zone for dates and clock times. */
  readonly tz: string;
  /** The scoped account's id, or null. */
  readonly scope: number | null;
  /** A frame no key reaches (`--once`): no tab strips, whose keys couldn't switch them. */
  readonly still?: boolean;
}

/** A block of the view: its size (for the layout system) and how to draw it at a height. */
export interface Section extends SectionSpec {
  render(height: number): ReactNode;
}

/**
 * What a view's key asks of the shell beyond the view's own state, carried by that state
 * (`withCommand`):
 * - `window`: the Models window, one step along `WINDOW_CHOICES` (config's
 *   `default_window`);
 * - `scope`: the global account scope (null: every account); the scope already set
 *   toggles back to every account;
 * - `root`: an edit of the root an account comes from (by identity), as the settings
 *   account editor makes it: enable or disable it, rename it, toggle history-only, link it
 *   to another root on its subscription account or unlink it (T16);
 * - `settings`: the settings account editor;
 * - `open`: another view, showing one account (by store id): the shell switches to it and
 *   has it `select` the account (the Overview's Enter on a card opens Accounts);
 * - `menu`: the action menu for an account (by store id), whose items run the `scope` and
 *   `root` commands (the Accounts view's Enter).
 */
export type ViewCommand =
  | { readonly type: "window"; readonly step: 1 | -1 }
  | { readonly type: "scope"; readonly account: number | null }
  | {
      readonly type: "root";
      readonly identity: string;
      readonly label: string;
      readonly edit: "enable" | "rename" | "history" | "link" | "unlink";
    }
  | { readonly type: "settings" }
  | { readonly type: "open"; readonly view: ViewId; readonly account: number }
  | { readonly type: "menu"; readonly account: number };

const COMMAND: unique symbol = Symbol("view command");

/** `state`, carrying a command for the shell, which takes it off before keeping the state. */
export function withCommand<S extends object>(state: S, command: ViewCommand): S {
  return { ...state, [COMMAND]: command };
}

/** A view's answer to a key: its new state, and the command it carries, if any. */
export function viewAnswer<S>(answer: S): { state: S; command: ViewCommand | null } {
  if (typeof answer !== "object" || answer === null || !(COMMAND in answer)) {
    return { state: answer, command: null };
  }
  const { [COMMAND]: command, ...state } = answer as S & { [COMMAND]: ViewCommand };
  return { state: state as S, command };
}

/**
 * A view behind the small interface T11–T13 implement (T10 notes): its sections, the view
 * model it draws, and its keys. `S` is the view's own UI state (a selection, say), kept by
 * the shell so a view switch is a pure re-render.
 *
 * The key contract, version 2 (T17; keys.ts), the same for every view (Controller.key):
 * 1. Ctrl-C quits, and an open overlay (help, settings, the action menu) takes every other
 *    key.
 * 2. While the view is `capturing` (a text field has focus), every key goes to its `field`
 *    keymap as typed.
 * 3. Otherwise letters are folded to lower case and WASD become the arrows; then the global
 *    keys (keys.ts `GLOBAL_KEYS`): 1–4 and tab/shift-tab switch views, `c` the account
 *    scope, `x` settings, `?` help, `q` quit.
 * 4. Every other key goes to the view's `keymap`, and only there: a key it doesn't list
 *    does nothing, and a view may not list `RESERVED` keys. A view acts through the state
 *    its entry returns; for what the shell owns (the scope, config, the settings screen,
 *    another view, the action menu), that state carries a command (`withCommand`). Views
 *    have no other key hook: `select` only answers another view's `open`.
 */
export interface View<VM, S> {
  readonly id: ViewId;
  readonly title: string;
  /**
   * Its keys, in the order the footer shows them: `a/d` (when it has tabs), `w/s`, `enter`,
   * `esc`, then its own letters. The footer, the help overlay and README come from it.
   */
  readonly keymap: Keymap<S, VM | undefined>;
  /** The keys while `capturing`: a text field's. */
  readonly field?: Keymap<S, VM | undefined>;
  readonly initial: S;
  /** True while a text field of the view has the keys: the shell's own keys pause. */
  capturing?(state: S): boolean;
  /** This view's state showing a store account (by id), for another view's `open`. */
  select?(state: S, account: number): S;
  sections(vm: VM, state: S, ctx: ViewContext): Section[];
}

/** The keymap a view's keys go through in `state`: its field's while it captures them. */
export function activeKeymap<VM, S>(view: View<VM, S>, state: S): Keymap<S, VM | undefined> {
  return view.capturing?.(state) === true && view.field !== undefined ? view.field : view.keymap;
}

/**
 * A view's answer to a key the shell passed on: its new state (which may carry a command,
 * `withCommand`), or undefined when its keymap doesn't list the key or it changes nothing.
 */
export function viewKey<VM, S>(
  view: View<VM, S>,
  key: string,
  state: S,
  vm: VM | undefined,
): S | undefined {
  return dispatch(activeKeymap(view, state), key, state, vm);
}

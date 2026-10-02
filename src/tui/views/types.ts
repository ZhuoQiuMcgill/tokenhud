import type { ReactNode } from "react";
import type { Hint } from "../frame.ts";
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
 *   account editor makes it: enable or disable it, rename it, toggle history-only;
 * - `settings`: the settings account editor;
 * - `open`: another view, showing one account (by store id): the shell switches to it and
 *   has it `select` the account (the Overview's Enter on a card opens Accounts).
 */
export type ViewCommand =
  | { readonly type: "window"; readonly step: 1 | -1 }
  | { readonly type: "scope"; readonly account: number | null }
  | {
      readonly type: "root";
      readonly identity: string;
      readonly label: string;
      readonly edit: "enable" | "rename" | "history";
    }
  | { readonly type: "settings" }
  | { readonly type: "open"; readonly view: ViewId; readonly account: number };

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
 * The key contract, the same for every view (Controller.key). Keys are named as typed
 * when printable ("w", "W", "/"), else by name ("return", "escape", "tab", "space", "up",
 * "pageup", "backspace"): see `typedName`.
 * 1. Ctrl-C quits, and an open overlay (help, settings) takes every other key.
 * 2. Then the global keys: 1–4 switch views, `a` account scope, `s` settings, `?` help,
 *    `q` quit (shifted letters are not global). They are skipped while the view is
 *    `capturing` (a text field has focus).
 * 3. Every other key goes to the active view's `keys`, and only there. A view acts through
 *    the state it returns; for what the shell owns (the scope, config, the settings
 *    screen, another view), that state carries a command (`withCommand`). Views have no
 *    other key hook: `select` only answers another view's `open`.
 */
export interface View<VM, S> {
  readonly id: ViewId;
  readonly title: string;
  /** Footer and help entries for this view's own keys, most important first. */
  readonly hints: readonly Hint[];
  readonly initial: S;
  /**
   * The view's answer to a key the shell passed on (see the key contract above): its new
   * state, which may carry a command for the shell (`withCommand`), or undefined if it
   * isn't its key.
   */
  keys(key: string, state: S, vm: VM | undefined): S | undefined;
  /** True while a text field of the view has the keys: the shell's own keys pause. */
  capturing?(state: S): boolean;
  /** This view's state showing a store account (by id), for another view's `open`. */
  select?(state: S, account: number): S;
  sections(vm: VM, state: S, ctx: ViewContext): Section[];
}

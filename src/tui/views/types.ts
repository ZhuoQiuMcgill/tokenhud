import type { ReactNode } from "react";
import type { Hint } from "../frame.ts";
import type { Breakpoint, SectionSpec } from "../layout.ts";
import type { Theme } from "../theme.ts";
import type { ViewId } from "../vm/types.ts";

/** What a view's sections are laid out for. */
export interface ViewContext {
  /** Body width in cells. */
  readonly width: number;
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
 *    the state it returns; views have no other key hook.
 */
export interface View<VM, S> {
  readonly id: ViewId;
  readonly title: string;
  /** Footer and help entries for this view's own keys, most important first. */
  readonly hints: readonly Hint[];
  readonly initial: S;
  /**
   * The view's answer to a key the shell passed on (see the key contract above): its new
   * state, or undefined if it isn't its key.
   */
  keys(key: string, state: S, vm: VM | undefined): S | undefined;
  /** True while a text field of the view has the keys: the shell's own keys pause. */
  capturing?(state: S): boolean;
  sections(vm: VM, state: S, ctx: ViewContext): Section[];
}

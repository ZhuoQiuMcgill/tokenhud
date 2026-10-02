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
 */
export interface View<VM, S> {
  readonly id: ViewId;
  readonly title: string;
  /** Footer and help entries for this view's own keys, most important first. */
  readonly hints: readonly Hint[];
  readonly initial: S;
  /**
   * The view's answer to a key it owns: its new state, or undefined if it isn't its key. A
   * printable key comes as typed ("W", "/"), any other by name ("return", "space").
   */
  keys(key: string, state: S, vm: VM | undefined): S | undefined;
  /** True while a text field of the view has the keys: the shell's own keys pause. */
  capturing?(state: S): boolean;
  sections(vm: VM, state: S, ctx: ViewContext): Section[];
}

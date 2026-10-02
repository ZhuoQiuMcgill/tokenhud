import {
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  type RenderContext,
  type RGBA,
  TextAttributes,
} from "@opentui/core";
import { clip, textWidth } from "../format.ts";
import { onSel, type Role, type Theme, theme as themeNamed } from "../theme.ts";

/** A run of text in one colour role. */
export interface Seg {
  readonly text: string;
  readonly role: Role;
  readonly bold?: boolean;
  readonly bg?: Role;
}

/** One row: `left` flush left, `right` flush right, an optional background across it. */
export interface Line {
  readonly left: readonly Seg[];
  readonly right?: readonly Seg[];
  readonly bg?: Role;
}

export function seg(text: string, role: Role, bold = false, bg?: Role): Seg {
  return bg === undefined ? { text, role, bold } : { text, role, bold, bg };
}

export function segsWidth(segs: readonly Seg[]): number {
  let w = 0;
  for (const s of segs) w += textWidth(s.text);
  return w;
}

/**
 * Draws `segs` from (x, y), at most `width` cells; the segment that overflows is cut with
 * `…`. Returns the cells drawn.
 */
export function drawSegs(
  buffer: OptimizedBuffer,
  t: Theme,
  segs: readonly Seg[],
  x: number,
  y: number,
  width: number,
  lineBg?: Role,
): number {
  let used = 0;
  const total = segsWidth(segs);
  for (const s of segs) {
    if (used >= width) break;
    const room = width - used;
    const w = textWidth(s.text);
    // Cut here if this segment overflows, or if it fits exactly but more text follows.
    const cut = w > room || (w === room && used + w < total);
    const text = cut ? `${clip(s.text, room - 1)}…` : s.text;
    if (text === "") continue;
    const bg = s.bg ?? lineBg;
    buffer.drawText(
      text,
      x + used,
      y,
      t.rgba[bg === "sel" ? onSel(s.role) : s.role],
      bg === undefined ? undefined : t.rgba[bg],
      s.bold ? TextAttributes.BOLD : TextAttributes.NONE,
    );
    used += textWidth(text);
    if (cut) break;
  }
  return used;
}

/** Draws a `Line` across `width` cells: right part first, the left part cut to what's left. */
export function drawLine(
  buffer: OptimizedBuffer,
  t: Theme,
  line: Line,
  x: number,
  y: number,
  width: number,
): void {
  if (width <= 0) return;
  if (line.bg !== undefined) buffer.fillRect(x, y, width, 1, t.rgba[line.bg]);
  const right = line.right ?? [];
  const rightWidth = Math.min(segsWidth(right), width);
  if (rightWidth > 0) drawSegs(buffer, t, right, x + width - rightWidth, y, rightWidth, line.bg);
  const room = rightWidth > 0 ? width - rightWidth - 1 : width;
  drawSegs(buffer, t, line.left, x, y, room, line.bg);
}

export interface ThemedOptions<R extends Renderable> extends RenderableOptions<R> {
  theme?: Theme;
}

/** A renderable that draws itself with theme roles; every prop setter re-renders. */
export abstract class Themed extends Renderable {
  protected t: Theme = themeNamed("dark");

  // `never`: a subclass's options type its callbacks' `this` as the subclass.
  constructor(ctx: RenderContext, options: ThemedOptions<never>) {
    super(ctx, options as RenderableOptions);
    if (options.theme) this.t = options.theme;
  }

  set theme(value: Theme) {
    this.t = value;
    this.requestRender();
  }

  protected color(role: Role): RGBA {
    return this.t.rgba[role];
  }
}

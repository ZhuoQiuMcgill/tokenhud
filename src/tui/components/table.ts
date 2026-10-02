import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { fit, textWidth } from "../format.ts";
import { onSel, type Role } from "../theme.ts";
import { drawRun, Themed, type ThemedOptions } from "./base.ts";
import { shareCells } from "./hbar.ts";

export interface Column<R> {
  readonly title: string;
  /** Cells; "fill" takes what the fixed columns leave (one such column at most). */
  readonly width: number | "fill";
  readonly align?: "left" | "right";
  readonly role: Role | ((row: R) => Role);
  readonly bold?: boolean | ((row: R) => boolean);
  /** The cell's text; formatted only for rows on screen. */
  readonly text?: (row: R) => string;
  /** Draw a `━` share bar (0..1) on an `empty` track instead of text. */
  readonly bar?: (row: R) => number;
  /**
   * When the table is too narrow, columns go highest `drop` first; 0 (the default) never
   * goes.
   */
  readonly drop?: number;
  /**
   * The fill column's narrowest width before other columns go (default `MIN_FILL`), or its
   * widest text if that is less. Narrower than that, its text is cut with `…`.
   */
  readonly min?: number;
}

export interface TableOptions<R> extends ThemedOptions<TableRenderable<R>> {
  columns?: readonly Column<R>[];
  rows?: readonly R[];
  /** The selected row (drawn on `sel`), or -1 for none. The view scrolls to keep it shown. */
  selected?: number;
  /** A totals row under a rule, drawn bold. */
  totals?: R | null;
  /** Cells between columns. */
  gap?: number;
  header?: boolean;
  /**
   * Say when rows are off screen (`↑ 2 more · 5 more ↓`): in the rule above the totals, or
   * in the last line without totals. Off, the rows scroll without a cue.
   */
  more?: boolean;
}

/** The fill column's narrowest useful width, before other columns start to go. */
export const MIN_FILL = 8;

/**
 * Which columns show, and their integer widths, in `width` cells (critique m2). A text
 * column is as wide as its widest cell on screen (`texts(i)`, header and totals included)
 * and at least its `width`, so a number is never cut. When the columns don't fit, they go
 * highest `drop` first (rightmost on ties). The fill column (names, cut with … if need
 * be) takes what is left.
 */
export function layoutColumns<R>(
  columns: readonly Column<R>[],
  width: number,
  gap: number,
  texts: (index: number) => readonly string[],
): { index: number; width: number }[] {
  const natural = columns.map((c, i) => {
    if (c.width === "fill") {
      let widest = textWidth(c.title);
      for (const t of texts(i)) widest = Math.max(widest, textWidth(t));
      return Math.min(c.min ?? MIN_FILL, widest);
    }
    if (c.bar) return c.width;
    let w = c.width;
    for (const t of texts(i)) w = Math.max(w, textWidth(t));
    return w;
  });
  const kept = columns.map((_, i) => i);
  const used = () =>
    kept.reduce((sum, i) => sum + (natural[i] as number), 0) + gap * (kept.length - 1);
  while (used() > width) {
    let worst = -1;
    for (const i of kept) {
      const d = columns[i]?.drop ?? 0;
      if (d > 0 && (worst < 0 || d >= (columns[worst]?.drop ?? 0))) worst = i;
    }
    if (worst < 0) break; // nothing may go: the right edge cuts it, as a last resort
    kept.splice(kept.indexOf(worst), 1);
  }
  const spare = Math.max(0, width - used());
  return kept.map((i) => ({
    index: i,
    width: (natural[i] as number) + (columns[i]?.width === "fill" ? spare : 0),
  }));
}

/** What is off screen, above and below: `↑ 2 more · 5 more ↓`, or "" when nothing is. */
export function moreText(above: number, below: number): string {
  const parts: string[] = [];
  if (above > 0) parts.push(`↑ ${above} more`);
  if (below > 0) parts.push(`${below} more ↓`);
  return parts.join(" · ");
}

/** The first row to show so that `selected` is visible, moving as little as possible from `top`. */
export function scrollTop(top: number, selected: number, visible: number, rows: number): number {
  let out = top;
  if (selected >= 0) {
    if (selected < out) out = selected;
    if (selected >= out + visible) out = selected - visible + 1;
  }
  return Math.max(0, Math.min(out, Math.max(0, rows - visible)));
}

/**
 * A virtual table (the UI spike's `virtual-table.ts`): one renderable that draws a header,
 * the rows on screen and an optional totals row, whatever the number of rows. Cells are
 * formatted only when drawn.
 */
export class TableRenderable<R = unknown> extends Themed {
  #columns: readonly Column<R>[] = [];
  #rows: readonly R[] = [];
  #selected = -1;
  #totals: R | null = null;
  #gap = 1;
  #header = true;
  #more = false;
  #top = 0;

  constructor(ctx: RenderContext, options: TableOptions<R>) {
    super(ctx, options);
    if (options.columns) this.#columns = options.columns;
    if (options.rows) this.#rows = options.rows;
    if (options.selected !== undefined) this.#selected = options.selected;
    if (options.totals !== undefined) this.#totals = options.totals;
    if (options.gap !== undefined) this.#gap = options.gap;
    if (options.header !== undefined) this.#header = options.header;
    if (options.more !== undefined) this.#more = options.more;
  }

  set columns(v: readonly Column<R>[]) {
    this.#columns = v ?? [];
    this.requestRender();
  }

  set rows(v: readonly R[]) {
    this.#rows = v ?? [];
    this.requestRender();
  }

  set selected(v: number) {
    this.#selected = v ?? -1;
    this.requestRender();
  }

  set totals(v: R | null) {
    this.#totals = v ?? null;
    this.requestRender();
  }

  set gap(v: number) {
    this.#gap = v ?? 1;
    this.requestRender();
  }

  set header(v: boolean) {
    this.#header = v ?? true;
    this.requestRender();
  }

  set more(v: boolean) {
    this.#more = v ?? false;
    this.requestRender();
  }

  /** Rows of data that fit under the header and above the totals (or the "more" line). */
  get pageSize(): number {
    const room = Math.max(
      0,
      this.height - (this.#header ? 1 : 0) - (this.#totals !== null ? 2 : 0),
    );
    // Without totals, the cue takes the last line when some rows are off screen.
    return this.#more && this.#totals === null && this.#rows.length > room
      ? Math.max(0, room - 1)
      : room;
  }

  #drawRow(
    buffer: OptimizedBuffer,
    row: R,
    y: number,
    layout: readonly { index: number; width: number }[],
    texts: readonly string[],
    bg?: Role,
    totals = false,
  ): void {
    let x = this.x;
    const right = this.x + this.width;
    for (const { index, width } of layout) {
      const col = this.#columns[index] as Column<R>;
      const w = Math.min(width, right - x);
      if (w <= 0) break;
      const role = typeof col.role === "function" ? col.role(row) : col.role;
      if (col.bar && totals) {
        // A totals row has no share of itself.
      } else if (col.bar) {
        const n = shareCells(col.bar(row), w);
        drawRun(buffer, "━", x, y, n, this.color(role));
        drawRun(buffer, "━", x + n, y, w - n, this.color("empty"));
      } else {
        const bold = typeof col.bold === "function" ? col.bold(row) : col.bold === true;
        buffer.drawText(
          fit(texts[index] ?? "", w, col.align ?? "left"),
          x,
          y,
          this.color(bg === "sel" ? onSel(role) : role),
          bg === undefined ? undefined : this.color(bg),
          bold ? TextAttributes.BOLD : TextAttributes.NONE,
        );
      }
      x += w + this.#gap;
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.width <= 0 || this.height <= 0) return;
    const visible = this.pageSize;
    this.#top = scrollTop(this.#top, this.#selected, visible, this.#rows.length);
    const end = Math.min(this.#rows.length, this.#top + visible);
    // The cells on screen, formatted once: they size the columns and are drawn.
    const cells = (row: R) => this.#columns.map((c) => (c.bar ? "" : (c.text?.(row) ?? "")));
    const shown: string[][] = [];
    for (let i = this.#top; i < end; i++) shown.push(cells(this.#rows[i] as R));
    const totals = this.#totals === null ? null : cells(this.#totals);
    const layout = layoutColumns(this.#columns, this.width, this.#gap, (i) => [
      this.#header ? (this.#columns[i]?.title ?? "") : "",
      ...shown.map((r) => r[i] as string),
      ...(totals === null ? [] : [totals[i] as string]),
    ]);
    let y = this.y;
    if (this.#header) {
      let x = this.x;
      for (const { index, width } of layout) {
        const col = this.#columns[index] as Column<R>;
        const w = Math.min(width, this.x + this.width - x);
        if (w <= 0) break;
        buffer.drawText(fit(col.title, w, col.align ?? "left"), x, y, this.color("dim"));
        x += w + this.#gap;
      }
      y++;
    }
    for (let i = this.#top; i < end; i++, y++) {
      const selected = i === this.#selected;
      if (selected) buffer.fillRect(this.x, y, this.width, 1, this.color("sel"));
      const row = this.#rows[i] as R;
      this.#drawRow(
        buffer,
        row,
        y,
        layout,
        shown[i - this.#top] as string[],
        selected ? "sel" : undefined,
      );
    }
    const cue = this.#more ? moreText(this.#top, this.#rows.length - end) : "";
    if (totals !== null && y + 1 < this.y + this.height) {
      buffer.drawText("─".repeat(this.width), this.x, y, this.color("rule"));
      if (cue !== "") {
        const text = ` ${cue} `;
        const at = Math.max(this.x, this.x + this.width - textWidth(text) - 1);
        buffer.drawText(text, at, y, this.color("mute"));
      }
      this.#drawRow(buffer, this.#totals as R, y + 1, layout, totals, undefined, true);
    } else if (cue !== "" && y < this.y + this.height) {
      buffer.drawText(fit(cue, this.width), this.x, y, this.color("mute"));
    }
  }
}

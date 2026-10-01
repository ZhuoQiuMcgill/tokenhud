import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { fit } from "../format.ts";
import type { Role } from "../theme.ts";
import { Themed, type ThemedOptions } from "./base.ts";
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
}

/** Integer widths for `columns` in `width` cells: fixed ones as given, "fill" the rest. */
export function columnWidths<R>(
  columns: readonly Column<R>[],
  width: number,
  gap: number,
): number[] {
  const fixed = columns.reduce((sum, c) => sum + (c.width === "fill" ? 0 : c.width), 0);
  const fill = Math.max(0, width - fixed - gap * Math.max(0, columns.length - 1));
  return columns.map((c) => (c.width === "fill" ? fill : c.width));
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
  #top = 0;

  constructor(ctx: RenderContext, options: TableOptions<R>) {
    super(ctx, options);
    if (options.columns) this.#columns = options.columns;
    if (options.rows) this.#rows = options.rows;
    if (options.selected !== undefined) this.#selected = options.selected;
    if (options.totals !== undefined) this.#totals = options.totals;
    if (options.gap !== undefined) this.#gap = options.gap;
    if (options.header !== undefined) this.#header = options.header;
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

  /** Rows of data that fit under the header and above the totals. */
  get pageSize(): number {
    return Math.max(0, this.height - (this.#header ? 1 : 0) - (this.#totals !== null ? 2 : 0));
  }

  #drawRow(
    buffer: OptimizedBuffer,
    row: R,
    y: number,
    widths: readonly number[],
    bg?: Role,
    totals = false,
  ): void {
    let x = this.x;
    const right = this.x + this.width;
    for (const [i, col] of this.#columns.entries()) {
      const w = Math.min(widths[i] as number, right - x);
      if (w <= 0) break;
      const role = typeof col.role === "function" ? col.role(row) : col.role;
      if (col.bar && totals) {
        // A totals row has no share of itself.
      } else if (col.bar) {
        const n = shareCells(col.bar(row), w);
        if (n > 0) buffer.drawText("━".repeat(n), x, y, this.color(role));
        if (n < w) buffer.drawText("━".repeat(w - n), x + n, y, this.color("empty"));
      } else {
        const bold = typeof col.bold === "function" ? col.bold(row) : col.bold === true;
        buffer.drawText(
          fit(col.text?.(row) ?? "", w, col.align ?? "left"),
          x,
          y,
          this.color(role),
          bg === undefined ? undefined : this.color(bg),
          bold ? TextAttributes.BOLD : TextAttributes.NONE,
        );
      }
      x += w + this.#gap;
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.width <= 0 || this.height <= 0) return;
    const widths = columnWidths(this.#columns, this.width, this.#gap);
    let y = this.y;
    if (this.#header) {
      let x = this.x;
      for (const [i, col] of this.#columns.entries()) {
        const w = Math.min(widths[i] as number, this.x + this.width - x);
        if (w <= 0) break;
        buffer.drawText(fit(col.title, w, col.align ?? "left"), x, y, this.color("dim"));
        x += w + this.#gap;
      }
      y++;
    }
    const visible = this.pageSize;
    this.#top = scrollTop(this.#top, this.#selected, visible, this.#rows.length);
    const end = Math.min(this.#rows.length, this.#top + visible);
    for (let i = this.#top; i < end; i++, y++) {
      const selected = i === this.#selected;
      if (selected) buffer.fillRect(this.x, y, this.width, 1, this.color("sel"));
      this.#drawRow(buffer, this.#rows[i] as R, y, widths, selected ? "sel" : undefined);
    }
    if (this.#totals !== null && y + 1 < this.y + this.height) {
      buffer.drawText("─".repeat(this.width), this.x, y, this.color("rule"));
      this.#drawRow(buffer, this.#totals, y + 1, widths, undefined, true);
    }
  }
}

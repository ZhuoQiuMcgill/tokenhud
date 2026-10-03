import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { textWidth } from "../format.ts";
import type { Role } from "../theme.ts";
import { drawRun, Themed, type ThemedOptions } from "./base.ts";

const EIGHTHS = " ▁▂▃▄▅▆▇";

/**
 * A zero bucket's cell in a chart's bottom row: the baseline, drawn dim (`cellRole`), so a
 * quiet stretch reads as part of the chart rather than its end (T25). It is the one-eighth
 * block, flush with the bars' feet, and a non-zero value's bottom cell is never shorter
 * than `▂`, so zero and the smallest bar differ in their characters too: without colour
 * (`NO_COLOR`, `--once` piped), and in the high-contrast theme.
 */
export const BASELINE = "▁";

/** The role to draw value `v`'s cells in: the bar's, or the baseline's for zero. */
export function cellRole(v: number, bar: Role): Role {
  return v > 0 ? bar : "dim";
}

export interface XLabel {
  /**
   * Where along the chart's span the tick falls, 0 (its start) to 1 (its end). A tick
   * starts at the first cell of the column it falls in; the one at 1 ends at the last cell.
   */
  readonly at: number;
  readonly text: string;
}

export interface VChartOptions extends ThemedOptions<VChartRenderable> {
  values?: readonly number[];
  colorRole?: Role;
  /** Formats the y labels (the top value and the middle value); the bottom one is "0". */
  format?: (value: number) => string;
  xLabels?: readonly XLabel[];
  /** Cells for the y labels, right-aligned, before a one-cell gap. */
  labelWidth?: number;
}

/**
 * Where each of `n` columns starts in `width` cells, then where the last one ends: column
 * `i` takes cells `edges[i]` to `edges[i + 1] - 1`. Each gets `floor(width / n)` cells and
 * the leftover cells are spread evenly (Bresenham), so widths differ by at most one, the
 * columns fill the width exactly, and a run of columns takes its share of it to within a
 * cell: time stays proportional to width.
 */
export function columnEdges(n: number, width: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i <= n; i++) edges.push(Math.floor((i * width) / Math.max(1, n)));
  return edges;
}

/**
 * Columns to draw `values` across all of `width` cells: a value a column when they fit,
 * else `group` neighbouring values summed per column (a coarser bucket, e.g. 40 instead of
 * 20 minutes), so every value counts and the chart never scrolls. `edges` places them
 * (`columnEdges`).
 */
export function chartColumns(
  values: readonly number[],
  width: number,
): { columns: number[]; edges: number[] } {
  if (values.length === 0 || width <= 0) return { columns: [], edges: [0] };
  const group = Math.ceil(values.length / width);
  const columns: number[] = [];
  for (let i = 0; i < values.length; i += group) {
    let sum = 0;
    for (let k = i; k < Math.min(values.length, i + group); k++) sum += values[k] as number;
    columns.push(sum);
  }
  return { columns, edges: columnEdges(columns.length, width) };
}

/**
 * gen.py `vchart()`: the cell for `v` in row `r` (0 = top) of `rows`, eighth blocks on top.
 * The bottom row is the baseline where `v` is zero, and at least `▂` where it isn't.
 */
export function chartCell(v: number, hi: number, rows: number, r: number): string {
  const bottom = r === rows - 1;
  if (!(v > 0)) return bottom ? BASELINE : " ";
  // How many eighths of this row the bar fills.
  const eighths = (v / hi) * rows * 8 - (rows - 1 - r) * 8;
  if (eighths >= 8) return "█";
  if (bottom) return EIGHTHS[Math.max(2, Math.floor(eighths))] as string;
  return eighths > 0 ? (EIGHTHS[Math.max(1, Math.floor(eighths))] as string) : " ";
}

/**
 * A vertical block chart: y labels on the left (top value, middle value, 0), the bars
 * across the whole of the rest of the width on a dim baseline, and a row of x tick labels
 * under them.
 */
export class VChartRenderable extends Themed {
  #values: readonly number[] = [];
  #role: Role = "cost";
  #format: (value: number) => string = (v) => String(Math.round(v));
  #xLabels: readonly XLabel[] = [];
  #labelWidth = 6;

  constructor(ctx: RenderContext, options: VChartOptions) {
    super(ctx, options);
    if (options.values) this.#values = options.values;
    if (options.colorRole !== undefined) this.#role = options.colorRole;
    if (options.format) this.#format = options.format;
    if (options.xLabels) this.#xLabels = options.xLabels;
    if (options.labelWidth !== undefined) this.#labelWidth = options.labelWidth;
  }

  set values(v: readonly number[]) {
    this.#values = v ?? [];
    this.requestRender();
  }

  set colorRole(v: Role) {
    this.#role = v ?? "cost";
    this.requestRender();
  }

  set format(v: (value: number) => string) {
    if (v) this.#format = v;
    this.requestRender();
  }

  set xLabels(v: readonly XLabel[]) {
    this.#xLabels = v ?? [];
    this.requestRender();
  }

  set labelWidth(v: number) {
    this.#labelWidth = v ?? 6;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const { x, y, width, height } = this;
    const rows = this.#xLabels.length > 0 ? height - 1 : height;
    const x0 = x + this.#labelWidth + 1;
    const plotWidth = x + width - x0;
    if (rows < 1 || plotWidth < 1) return;
    const { columns, edges } = chartColumns(this.#values, plotWidth);
    let hi = 0;
    for (const v of columns) if (v > hi) hi = v;
    const dim = this.color("dim");
    const mid = Math.floor((rows - 1) / 2);
    const labels = new Map<number, string>([[rows - 1, "0"]]);
    if (rows > 1 && hi > 0) labels.set(0, this.#format(hi));
    if (rows > 2 && mid > 0 && hi > 0) {
      labels.set(mid, this.#format((hi * (rows - 1 - mid)) / (rows - 1)));
    }
    for (const [r, text] of labels) {
      const t = text.slice(-this.#labelWidth);
      buffer.drawText(t, x + this.#labelWidth - textWidth(t), y + r, dim);
    }
    const bar = this.color(this.#role);
    const scale = hi > 0 ? hi : 1;
    const bottom = rows - 1;
    // With no buckets at all, the baseline alone still shows where the plot is.
    if (columns.length === 0) drawRun(buffer, BASELINE, x0, y + bottom, plotWidth, dim);
    for (let i = 0; i < columns.length; i++) {
      const v = columns[i] as number;
      const at = x0 + (edges[i] as number);
      const cells = (edges[i + 1] as number) - (edges[i] as number);
      for (let r = 0; r < bottom; r++) {
        drawRun(buffer, chartCell(v, scale, rows, r), at, y + r, cells, bar);
      }
      // Only the foot is dim for zero: the blank cells above stay one run with the bars.
      const foot = this.color(cellRole(v, this.#role));
      drawRun(buffer, chartCell(v, scale, rows, bottom), at, y + bottom, cells, foot);
    }
    if (this.#xLabels.length === 0) return;
    let free = x0; // the first cell a label may start at
    for (const label of this.#xLabels) {
      const w = textWidth(label.text);
      const at = Math.min(1, Math.max(0, label.at));
      let start =
        at >= 1 ? x0 + plotWidth - w : x0 + (edges[Math.round(at * columns.length)] as number);
      start = Math.min(start, x + width - w);
      if (start < free) continue;
      buffer.drawText(label.text, start, y + rows, dim);
      free = start + w + 1;
    }
  }
}

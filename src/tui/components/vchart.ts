import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { textWidth } from "../format.ts";
import type { Role } from "../theme.ts";
import { Themed, type ThemedOptions } from "./base.ts";

const EIGHTHS = " ▁▂▃▄▅▆▇";

export interface XLabel {
  /** Position along the chart, 0 (first column) to 1 (last). */
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
 * Columns to draw `values` in `width` cells: one value per `colw` cells when they fit,
 * else `group` neighbouring values summed per cell (a coarser bucket, e.g. 40 instead of
 * 20 minutes), so every value counts and the chart never scrolls.
 */
export function chartColumns(
  values: readonly number[],
  width: number,
): { columns: number[]; colw: number } {
  if (values.length === 0 || width <= 0) return { columns: [], colw: 1 };
  if (values.length <= width) {
    return { columns: [...values], colw: Math.max(1, Math.floor(width / values.length)) };
  }
  const group = Math.ceil(values.length / width);
  const columns: number[] = [];
  for (let i = 0; i < values.length; i += group) {
    let sum = 0;
    for (let k = i; k < Math.min(values.length, i + group); k++) sum += values[k] as number;
    columns.push(sum);
  }
  return { columns, colw: 1 };
}

/** gen.py `vchart()`: the cell for `v` in row `r` (0 = top) of `rows`, eighth blocks on top. */
export function chartCell(v: number, hi: number, rows: number, r: number): string {
  const units = (v / hi) * rows * 8;
  const base = (rows - 1 - r) * 8;
  if (units >= base + 8) return "█";
  if (units > base) return EIGHTHS[Math.max(1, Math.floor(units - base))] as string;
  return " ";
}

/**
 * A vertical block chart: y labels on the left (top value, middle value, 0), the bars, and
 * a row of x tick labels under them.
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
    const { columns, colw } = chartColumns(this.#values, plotWidth);
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
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (const v of columns) line += chartCell(v, scale, rows, r).repeat(colw);
      buffer.drawText(line, x0, y + r, bar);
    }
    if (this.#xLabels.length === 0) return;
    const span = columns.length * colw;
    let free = x0; // the first cell a label may start at
    for (const label of this.#xLabels) {
      const w = textWidth(label.text);
      const at = Math.round(Math.min(1, Math.max(0, label.at)) * (span - 1));
      let start = label.at >= 1 ? x0 + at - w + 1 : x0 + at;
      start = Math.min(start, x + width - w);
      if (start < free) continue;
      buffer.drawText(label.text, start, y + rows, dim);
      free = start + w + 1;
    }
  }
}

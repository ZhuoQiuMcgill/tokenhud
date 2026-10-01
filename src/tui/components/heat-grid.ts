import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { HEAT_ROLES, type Role } from "../theme.ts";
import { Themed, type ThemedOptions } from "./base.ts";

export interface MonthLabel {
  /** The week column the label starts at. */
  readonly week: number;
  readonly text: string;
}

export interface HeatGridOptions extends ThemedOptions<HeatGridRenderable> {
  /** Week-major: index `week * 7 + day` (day 0 = Monday). null leaves the cell blank. */
  values?: readonly (number | null)[];
  weeks?: number;
  /** The highlighted cell's index, or -1. */
  selected?: number;
  /** A month row above the grid; none when empty. */
  months?: readonly MonthLabel[];
  /** Mon / Wed / Fri labels in a 5-cell gutter on the left. */
  dayLabels?: boolean;
}

const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const GUTTER = 5;

/** The 5-level scale: 0 for no usage, else 1–4 by quarter of the largest value. */
export function heatLevel(v: number, hi: number): number {
  if (!(v > 0) || !(hi > 0)) return 0;
  return 1 + Math.min(3, Math.floor((v / hi) * 4));
}

/**
 * A weeks × days grid of `■`, one cell per day, two columns per week (gen.py
 * `history_a()`), coloured on a 5-level scale (`heat0`…`heat4`), with the selected day drawn
 * in `head`. When fewer weeks fit than given, the most recent ones show.
 */
export class HeatGridRenderable extends Themed {
  #values: readonly (number | null)[] = [];
  #weeks = 0;
  #selected = -1;
  #months: readonly MonthLabel[] = [];
  #dayLabels = true;

  constructor(ctx: RenderContext, options: HeatGridOptions) {
    super(ctx, options);
    if (options.values) this.#values = options.values;
    if (options.weeks !== undefined) this.#weeks = options.weeks;
    if (options.selected !== undefined) this.#selected = options.selected;
    if (options.months) this.#months = options.months;
    if (options.dayLabels !== undefined) this.#dayLabels = options.dayLabels;
  }

  set values(v: readonly (number | null)[]) {
    this.#values = v ?? [];
    this.requestRender();
  }

  set weeks(v: number) {
    this.#weeks = v ?? 0;
    this.requestRender();
  }

  set selected(v: number) {
    this.#selected = v ?? -1;
    this.requestRender();
  }

  set months(v: readonly MonthLabel[]) {
    this.#months = v ?? [];
    this.requestRender();
  }

  set dayLabels(v: boolean) {
    this.#dayLabels = v ?? true;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const gutter = this.#dayLabels ? GUTTER : 0;
    const fits = Math.floor((this.width - gutter) / 2);
    const shown = Math.max(0, Math.min(this.#weeks, fits));
    const first = this.#weeks - shown;
    const top = this.#months.length > 0 ? 1 : 0;
    const dim = this.color("dim");
    let hi = 0;
    for (const v of this.#values) if (v !== null && v > hi) hi = v;
    if (top === 1) {
      let free = 0;
      for (const m of this.#months) {
        const col = (m.week - first) * 2;
        if (col < free || col < 0 || gutter + col + m.text.length > this.width) continue;
        buffer.drawText(m.text, this.x + gutter + col, this.y, dim);
        free = col + m.text.length + 1;
      }
    }
    const rows = Math.min(7, this.height - top);
    for (let d = 0; d < rows; d++) {
      const y = this.y + top + d;
      if (this.#dayLabels) buffer.drawText(` ${DAY_LABELS[d]}`, this.x, y, dim);
      for (let w = 0; w < shown; w++) {
        const index = (first + w) * 7 + d;
        const v = this.#values[index];
        if (v === null || v === undefined) continue;
        const selected = index === this.#selected;
        const role: Role = selected ? "head" : (HEAT_ROLES[heatLevel(v, hi)] as Role);
        buffer.drawText(
          "■",
          this.x + gutter + w * 2,
          y,
          this.color(role),
          undefined,
          selected ? TextAttributes.BOLD : TextAttributes.NONE,
        );
      }
    }
  }
}

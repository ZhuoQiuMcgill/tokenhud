import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import type { Role } from "../theme.ts";
import { drawRun, Themed, type ThemedOptions } from "./base.ts";
import { BASELINE, cellRole } from "./vchart.ts";

const TICKS = "▁▂▃▄▅▆▇█";

export interface SparkOptions extends ThemedOptions<SparkRenderable> {
  /** One value per cell; null draws a gap. */
  values?: readonly (number | null)[];
  colorRole?: Role;
  /** The value of a full block; default the largest value. */
  max?: number;
}

/**
 * gen.py `spark()`: the tick for `v`, scaled so `hi` is a full block. Zero is the baseline
 * (VChart's `BASELINE`, drawn dim), so any other value is at least `▂`.
 */
export function sparkChar(v: number | null, hi: number): string {
  if (v === null) return " ";
  if (!(v > 0)) return BASELINE;
  return TICKS[Math.max(1, Math.min(7, Math.floor((v / hi) * 7.999)))] as string;
}

/**
 * A one-row sparkline of `▂…█` on a dim `▁` baseline. With more values than cells, the
 * latest values show.
 */
export class SparkRenderable extends Themed {
  #values: readonly (number | null)[] = [];
  #role: Role = "cost";
  #max: number | undefined;

  constructor(ctx: RenderContext, options: SparkOptions) {
    super(ctx, options);
    if (options.values) this.#values = options.values;
    if (options.colorRole !== undefined) this.#role = options.colorRole;
    this.#max = options.max;
  }

  set values(v: readonly (number | null)[]) {
    this.#values = v ?? [];
    this.requestRender();
  }

  set colorRole(v: Role) {
    this.#role = v ?? "cost";
    this.requestRender();
  }

  set max(v: number | undefined) {
    this.#max = v;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.width <= 0 || this.height <= 0) return;
    const shown = this.#values.slice(-this.width);
    let hi = this.#max ?? 0;
    if (this.#max === undefined) for (const v of shown) if (v !== null && v > hi) hi = v;
    if (!(hi > 0)) hi = 1;
    shown.forEach((v, i) => {
      const fg = this.color(v === null ? this.#role : cellRole(v, this.#role));
      drawRun(buffer, sparkChar(v, hi), this.x + i, this.y, 1, fg);
    });
  }
}

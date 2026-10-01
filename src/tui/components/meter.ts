import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { level, type Role } from "../theme.ts";
import { Themed, type ThemedOptions } from "./base.ts";

export interface MeterOptions extends ThemedOptions<MeterRenderable> {
  /** Utilisation, 0..1 (above 1 draws full). */
  value?: number;
  /** Draw the fill in this role instead of the level colour. */
  colorRole?: Role;
}

/** Fill cells of a `width`-cell meter at `value`, as gen.py `bar()`: round(pct · w / 100). */
export function filledCells(value: number, width: number): number {
  if (!(value > 0)) return 0;
  return Math.min(width, Math.round(value * width));
}

/**
 * A `━` bar meter, gen.py `bar()`: the filled part in the level colour (low below 50 %,
 * mid below 80 %, high from 80 %), the rest in `empty`. One row, as wide as laid out.
 */
export class MeterRenderable extends Themed {
  #value = 0;
  #role: Role | undefined;

  constructor(ctx: RenderContext, options: MeterOptions) {
    super(ctx, options);
    if (options.value !== undefined) this.#value = options.value;
    this.#role = options.colorRole;
  }

  set value(v: number) {
    this.#value = v ?? 0;
    this.requestRender();
  }

  set colorRole(v: Role | undefined) {
    this.#role = v;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const w = this.width;
    if (w <= 0 || this.height <= 0) return;
    const n = filledCells(this.#value, w);
    if (n > 0)
      buffer.drawText("━".repeat(n), this.x, this.y, this.color(this.#role ?? level(this.#value)));
    if (n < w) buffer.drawText("━".repeat(w - n), this.x + n, this.y, this.color("empty"));
  }
}

import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import type { Role } from "../theme.ts";
import { Themed, type ThemedOptions } from "./base.ts";

export interface HBarOptions extends ThemedOptions<HBarRenderable> {
  /** The share, 0..1. */
  value?: number;
  colorRole?: Role;
  /** Draw the unfilled part in `empty` (a rate-board share column), or leave it blank. */
  track?: boolean;
}

/** Cells for a share: round(share · width), but at least one for any nonzero share. */
export function shareCells(value: number, width: number): number {
  if (!(value > 0) || width <= 0) return 0;
  return Math.max(1, Math.min(width, Math.round(value * width)));
}

/**
 * An inline share bar of `━`, in one role (cost by default): the Overview's top models and
 * the Models view's share column.
 */
export class HBarRenderable extends Themed {
  #value = 0;
  #role: Role = "cost";
  #track = false;

  constructor(ctx: RenderContext, options: HBarOptions) {
    super(ctx, options);
    if (options.value !== undefined) this.#value = options.value;
    if (options.colorRole !== undefined) this.#role = options.colorRole;
    if (options.track !== undefined) this.#track = options.track;
  }

  set value(v: number) {
    this.#value = v ?? 0;
    this.requestRender();
  }

  set colorRole(v: Role) {
    this.#role = v ?? "cost";
    this.requestRender();
  }

  set track(v: boolean) {
    this.#track = v ?? false;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const w = this.width;
    if (w <= 0 || this.height <= 0) return;
    const n = shareCells(this.#value, w);
    if (n > 0) buffer.drawText("━".repeat(n), this.x, this.y, this.color(this.#role));
    if (this.#track && n < w) {
      buffer.drawText("━".repeat(w - n), this.x + n, this.y, this.color("empty"));
    }
  }
}

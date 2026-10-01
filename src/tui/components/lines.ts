import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { drawLine, type Line, Themed, type ThemedOptions } from "./base.ts";

export interface LinesOptions extends ThemedOptions<LinesRenderable> {
  lines?: readonly Line[];
}

/**
 * Styled text rows: each row's left part flush left and right part flush right, cut with
 * `…` to the width it is laid out at. The building block for chrome (header, footer,
 * section titles) and card bodies.
 */
export class LinesRenderable extends Themed {
  #lines: readonly Line[] = [];

  constructor(ctx: RenderContext, options: LinesOptions) {
    super(ctx, options);
    if (options.lines) this.#lines = options.lines;
  }

  set lines(value: readonly Line[]) {
    this.#lines = value ?? [];
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const rows = Math.min(this.#lines.length, this.height);
    for (let i = 0; i < rows; i++) {
      drawLine(buffer, this.t, this.#lines[i] as Line, this.x, this.y + i, this.width);
    }
  }
}

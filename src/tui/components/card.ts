import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { truncate } from "../format.ts";
import type { Role } from "../theme.ts";
import { Themed, type ThemedOptions } from "./base.ts";

export interface CardOptions extends ThemedOptions<CardRenderable> {
  title?: string;
  titleRole?: Role;
}

/**
 * A rounded box with a title in its top border, as gen.py `card()`:
 * `╭─ title ───╮`. Children are laid out inside one row from the top and bottom borders and
 * two cells from the sides (`│ ` and ` │`). Width and height come from layout props, so a
 * card is fixed (`width`) or flexible (`flexGrow`/`flexBasis`).
 */
export class CardRenderable extends Themed {
  #title = "";
  #titleRole: Role = "head";

  constructor(ctx: RenderContext, options: CardOptions) {
    super(ctx, { ...options, paddingTop: 1, paddingBottom: 1, paddingLeft: 2, paddingRight: 2 });
    if (options.title !== undefined) this.#title = options.title;
    if (options.titleRole !== undefined) this.#titleRole = options.titleRole;
  }

  set title(value: string) {
    this.#title = value ?? "";
    this.requestRender();
  }

  set titleRole(value: Role) {
    this.#titleRole = value ?? "head";
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const { x, y, width: w, height: h } = this;
    if (w < 2 || h < 2) return;
    const border = this.color("border");
    // ╭─ title ─…─╮: 3 cells before the title, a space after it, at least one ─, then ╮.
    const title = truncate(this.#title, Math.max(0, w - 6));
    if (title === "") {
      buffer.drawText(`╭${"─".repeat(w - 2)}╮`, x, y, border);
    } else {
      buffer.drawText("╭─ ", x, y, border);
      buffer.drawText(title, x + 3, y, this.color(this.#titleRole), undefined, TextAttributes.BOLD);
      const after = x + 3 + Bun.stringWidth(title);
      buffer.drawText(` ${"─".repeat(Math.max(0, x + w - 1 - after - 1))}╮`, after, y, border);
    }
    for (let r = 1; r < h - 1; r++) {
      buffer.drawText("│", x, y + r, border);
      buffer.drawText("│", x + w - 1, y + r, border);
    }
    buffer.drawText(`╰${"─".repeat(w - 2)}╯`, x, y + h - 1, border);
  }
}

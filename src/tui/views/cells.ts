// How a cost is written in every view, so the views agree (critique m4): a cost with no
// priced token at all is "unpriced", never $0.00; one that leaves some tokens out ends in
// "*"; one partly priced from an estimated card starts with "≈".
import { money, moneyShort, textWidth } from "../format.ts";
import type { Role } from "../theme.ts";
import type { Priced } from "../vm/types.ts";

/** None of the tokens has a price: there is no cost to show. */
export function unpriced(p: Priced): boolean {
  return p.tokens > 0 && p.pricedShare === 0;
}

/** The cost as written, `short` for compact money ($1.2K). */
export function costText(p: Priced, short = false): { text: string; role: Role } {
  if (unpriced(p)) return { text: "unpriced", role: "dim" };
  const value = short ? moneyShort(p.cost) : money(p.cost);
  const estimated = p.estimatedCost > 0 ? "≈" : "";
  const partial = p.pricedShare < 1 ? "*" : "";
  return { text: `${estimated}${value}${partial}`, role: "cost" };
}

/** What the markers mean, for a section showing these costs; null when none is marked. */
export function costNote(items: readonly Priced[]): string | null {
  const notes: string[] = [];
  if (items.some((p) => p.tokens > 0 && p.pricedShare < 1)) notes.push("* not all tokens priced");
  if (items.some((p) => p.estimatedCost > 0)) notes.push("≈ partly estimated");
  return notes.length === 0 ? null : notes.join(" · ");
}

/**
 * A section's right-hand note with the cost legend before it, when costs show, some are
 * marked, and the whole title line still fits `width`.
 */
export function noteWithLegend(
  title: string,
  note: string,
  items: readonly Priced[],
  showCost: boolean,
  width: number,
): string {
  const legend = showCost ? costNote(items) : null;
  if (legend === null) return note;
  const both = `${legend} · ${note}`;
  return textWidth(` ${title}`) + 2 + textWidth(`${both} `) <= width ? both : note;
}

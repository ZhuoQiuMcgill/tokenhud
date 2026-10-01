// The layout system: width breakpoints, rows → sections, and integer column widths.
//
// The UI spike's rules (ARCHITECTURE §9.1) apply throughout: fixed rows get
// `flexShrink={0}`, ratios use `flexBasis={0}`, aligned columns get integer widths (Yoga's
// are fractional), and text is truncated by us. Section heights are decided here, in JS,
// from the terminal size, so a frame never depends on how Yoga rounds.

/** wide ≥ 120 columns, medium 100–119, narrow < 100. */
export type Breakpoint = "wide" | "medium" | "narrow";

export function breakpoint(width: number): Breakpoint {
  return width >= 120 ? "wide" : width >= 100 ? "medium" : "narrow";
}

/**
 * One block of a view, stacked vertically in the body. `priority` 1 is the most important;
 * when rows are short the highest numbers drop first. A section may shrink from `height`
 * down to `minHeight` before anything is dropped.
 */
export interface SectionSpec {
  readonly id: string;
  readonly priority: number;
  readonly height: number;
  readonly minHeight?: number;
}

export interface Fitted {
  readonly id: string;
  readonly height: number;
}

/**
 * Which sections fit in `rows`, and how tall each is, in display order (the order given).
 *
 * The sections are taken in priority order while their minimum heights (plus a `gap` row
 * between neighbours) fit; the first one that doesn't fit is dropped with everything of
 * lower priority, so a lower-priority section never shows while a higher one is hidden.
 * Rows left over then grow the shrunk sections back toward their full height, most
 * important first. The top section is always shown, cut to `rows` if it must be.
 */
export function fitSections(sections: readonly SectionSpec[], rows: number, gap = 1): Fitted[] {
  if (sections.length === 0 || rows <= 0) return [];
  const byPriority = [...sections].sort((a, b) => a.priority - b.priority);
  const kept: SectionSpec[] = [];
  let used = 0;
  for (const s of byPriority) {
    const need = (kept.length > 0 ? gap : 0) + (s.minHeight ?? s.height);
    if (used + need > rows) break;
    kept.push(s);
    used += need;
  }
  if (kept.length === 0) {
    const top = byPriority[0] as SectionSpec;
    return [{ id: top.id, height: rows }];
  }
  let spare = rows - used;
  const heights = new Map(kept.map((s) => [s.id, s.minHeight ?? s.height]));
  for (const s of kept) {
    const grow = Math.min(spare, s.height - (heights.get(s.id) as number));
    if (grow > 0) {
      heights.set(s.id, (heights.get(s.id) as number) + grow);
      spare -= grow;
    }
  }
  return sections
    .filter((s) => heights.has(s.id))
    .map((s) => ({ id: s.id, height: heights.get(s.id) as number }));
}

/**
 * Splits `total` cells into `parts` integer widths separated by `gap` cells; the remainder
 * goes to the first columns, one cell each, so widths differ by at most one.
 */
export function splitWidth(total: number, parts: number, gap = 0): number[] {
  if (parts <= 0) return [];
  const free = Math.max(0, total - gap * (parts - 1));
  const base = Math.floor(free / parts);
  const extra = free - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Cards per row of the Overview's limits section, by breakpoint (ARCHITECTURE §9). */
export function cardsPerRow(bp: Breakpoint): number {
  return bp === "wide" ? 3 : bp === "medium" ? 2 : 1;
}

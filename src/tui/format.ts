// Number, money, time and text formatting for the TUI. Pure functions of their inputs (a
// zone is passed in where one matters), so frames are deterministic under test.

/** `$1,234.56`; negative amounts keep the sign before the dollar. */
export function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  const [whole, cents] = Math.abs(value).toFixed(2).split(".") as [string, string];
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/** Compact money for chart labels: `$9.20`, `$18.4`, `$340`, `$1.2K`, `$16K`. */
export function moneyShort(value: number): string {
  const v = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (v >= 1e6) return `${sign}$${trim3(v / 1e6)}M`;
  if (v >= 1e3) return `${sign}$${trim3(v / 1e3)}K`;
  if (v >= 100) return `${sign}$${Math.round(v)}`;
  if (v >= 10) return `${sign}$${v.toFixed(1)}`;
  return `${sign}$${v.toFixed(2)}`;
}

function trim3(v: number): string {
  // Three significant digits without trailing zeros: 1.2, 12.3, 123.
  const s = v >= 99.5 ? String(Math.round(v)) : v >= 9.995 ? v.toFixed(1) : v.toFixed(2);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * Token counts as the prototype writes them: `374`, `92K`, `880K`, `41.2M`, `188.0M`,
 * `1.92B`, `24.6B`.
 */
export function tokens(n: number): string {
  const v = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (v >= 999.5e6) {
    const b = v / 1e9;
    return `${sign}${b >= 99.95 ? Math.round(b) : b >= 9.995 ? b.toFixed(1) : b.toFixed(2)}B`;
  }
  if (v >= 999.5e3) return `${sign}${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${sign}${Math.round(v / 1e3)}K`;
  return `${sign}${Math.round(v)}`;
}

/** A share as `69.2%`; `0.0%` for none. */
export function percent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** A countdown: `45s`, `12m`, `1h48m`, `4d06h`. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-29` → `Tue Sep 29`. The key is already local, so no zone is involved. */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

/** `2026-09` → `Sep 2026`; `2026-09-28` (a week's Monday) → `wk of Sep 28`. */
export function periodLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number | undefined];
  if (d === undefined) return `${MONTHS[m - 1]} ${y}`;
  return `wk of ${MONTHS[m - 1]} ${d}`;
}

export function monthName(month1: number): string {
  return MONTHS[month1 - 1] ?? "";
}

/** `HH:MM` wall-clock time at `t` in zone `tz`. */
export function clock(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(t);
}

/** Display width in terminal cells (CJK and emoji count 2). */
export function textWidth(text: string): number {
  return Bun.stringWidth(text);
}

/**
 * `text` cut to `width` cells, ending in `…` when cut. OpenTUI has no ellipsis of its own
 * (ARCHITECTURE §9.1), so everything that can overflow goes through here.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  return `${clip(text, width - 1)}…`;
}

/** The longest prefix of `text` that fits in `width` cells (no ellipsis). */
export function clip(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = textWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/** Pads or truncates to exactly `width` cells. */
export function fit(text: string, width: number, align: "left" | "right" = "left"): string {
  const cut = truncate(text, width);
  const pad = " ".repeat(Math.max(0, width - textWidth(cut)));
  return align === "left" ? cut + pad : pad + cut;
}

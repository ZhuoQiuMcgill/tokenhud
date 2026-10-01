// Named periods and calendar groupings, resolved to epoch-ms half-open ranges [from, to).
//
// Calendar periods follow the viewer's zone: "today" is a calendar day (23 or 25 hours
// across DST), weeks start on Monday 00:00 and months on the 1st. Rolling periods are
// fixed lengths of time ending now.

import type { Range } from "./types.ts";
import {
  addDays,
  compareDates,
  firstOfMonth,
  formatDate,
  type LocalDate,
  mondayOf,
  type Zone,
} from "./tz.ts";

export const PERIOD_NAMES = ["today", "this_week", "this_month", "all", "1h", "5h", "24h"] as const;
export type PeriodName = (typeof PERIOD_NAMES)[number];

/** A custom period: epoch ms, `since` inclusive and `until` exclusive. */
export interface CustomPeriod {
  readonly since: number;
  readonly until: number;
}

export type Period = PeriodName | CustomPeriod;

const ROLLING_MS: Readonly<Record<string, number>> = {
  "1h": 3_600_000,
  "5h": 5 * 3_600_000,
  "24h": 24 * 3_600_000,
};

export function isPeriodName(value: string): value is PeriodName {
  return (PERIOD_NAMES as readonly string[]).includes(value);
}

/** What resolving "all" needs: the store's first and last usage timestamps, or null if empty. */
export type Extent = { readonly first: number; readonly last: number } | null;

/**
 * The range a period covers at `now` in `zone`.
 * - Calendar periods run from their local start to the start of the next one, so usage
 *   stamped later today (a skewed clock) still counts as today.
 * - Rolling periods end at `now` inclusive: [now - length, now + 1). cc-usage counted a
 *   record when its age was at most the window, the same instants.
 * - "all" is the store's extent, [first, last + 1); empty for an empty store.
 */
export function resolvePeriod(period: Period, now: number, zone: Zone, extent: Extent): Range {
  if (typeof period !== "string") return { from: period.since, to: period.until };
  const rolling = ROLLING_MS[period];
  if (rolling !== undefined) return { from: now - rolling, to: now + 1 };
  const today = zone.dateAt(now);
  switch (period) {
    case "today":
      return { from: zone.startOf(today), to: zone.startOf(addDays(today, 1)) };
    case "this_week": {
      const monday = mondayOf(today);
      return { from: zone.startOf(monday), to: zone.startOf(addDays(monday, 7)) };
    }
    case "this_month":
      return { from: zone.startOf(firstOfMonth(today)), to: zone.startOf(firstOfMonth(today, 1)) };
    default:
      return extent === null ? { from: 0, to: 0 } : { from: extent.first, to: extent.last + 1 };
  }
}

export type Calendar = "day" | "week" | "month";

/** One calendar group within a range: its label and its part of the range. */
export interface CalendarSlice {
  /** YYYY-MM-DD for a day or a week (its Monday), YYYY-MM for a month. */
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

function unitStart(date: LocalDate, unit: Calendar): LocalDate {
  if (unit === "day") return date;
  if (unit === "week") return mondayOf(date);
  return firstOfMonth(date);
}

function nextUnit(start: LocalDate, unit: Calendar): LocalDate {
  if (unit === "day") return addDays(start, 1);
  if (unit === "week") return addDays(start, 7);
  return firstOfMonth(start, 1);
}

/**
 * The local days, Monday-start weeks or calendar months that `range` touches, in order,
 * each clipped to the range: a rolling 24 h range by day gives two partial days.
 */
export function calendarSlices(range: Range, unit: Calendar, zone: Zone): CalendarSlice[] {
  if (range.to <= range.from) return [];
  const slices: CalendarSlice[] = [];
  let start = unitStart(zone.dateAt(range.from), unit);
  let from = range.from;
  const lastDay = zone.dateAt(range.to - 1);
  while (compareDates(start, lastDay) <= 0) {
    const next = nextUnit(start, unit);
    const to = Math.min(zone.startOf(next), range.to);
    const key = unit === "month" ? formatDate(start).slice(0, 7) : formatDate(start);
    if (to > from) slices.push({ key, from, to });
    from = to;
    start = next;
  }
  return slices;
}

/** `count` equal buckets over `range` (the last absorbs any remainder of a millisecond). */
export function equalBuckets(range: Range, count: number): number[] {
  const bounds: number[] = [];
  const width = (range.to - range.from) / count;
  for (let i = 0; i < count; i++) bounds.push(range.from + Math.round(i * width));
  bounds.push(range.to);
  return bounds;
}

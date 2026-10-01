// Time zones for calendar periods: local midnights, Monday-start weeks and the 1st of the
// month, in any IANA zone, across DST. Built on Intl only (no tz database of our own).
//
// Intl answers "what is the wall-clock time at instant t". Each answer costs about a
// microsecond, and a 26-week heat map needs a few hundred, so a Zone memoises offsets per
// UTC day: one lookup per day, plus a binary search on the rare day whose offset changes.

const DAY_MS = 86_400_000;

/** A local calendar date. `month` is 1–12. */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

// UTC day -> its offset, or [offset before, transition instant, offset after] for a day
// whose offset changes. Two changes within one UTC day never happen in practice.
type DayOffsets = number | readonly [before: number, at: number, after: number];

const zones = new Map<string, Zone>();

export class Zone {
  readonly name: string;
  readonly #format: Intl.DateTimeFormat;
  readonly #days = new Map<number, DayOffsets>();

  private constructor(name: string, format: Intl.DateTimeFormat) {
    this.name = name;
    this.#format = format;
  }

  /** The zone named `name` (an IANA id such as "America/Toronto"). Throws RangeError if unknown. */
  static of(name: string): Zone {
    let zone = zones.get(name);
    if (zone === undefined) {
      const format = new Intl.DateTimeFormat("en-US", {
        timeZone: name,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
      // Intl canonicalises aliases and case ("asia/calcutta" -> "Asia/Kolkata").
      zone = new Zone(format.resolvedOptions().timeZone, format);
      zones.set(name, zone);
    }
    return zone;
  }

  /** The system's zone (honours the TZ environment variable). */
  static system(): Zone {
    return Zone.of(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /** Milliseconds to add to UTC to get the local wall-clock time at instant `t`. */
  offset(t: number): number {
    const day = Math.floor(t / DAY_MS);
    let entry = this.#days.get(day);
    if (entry === undefined) {
      entry = this.#resolveDay(day);
      this.#days.set(day, entry);
    }
    if (typeof entry === "number") return entry;
    return t < entry[1] ? entry[0] : entry[2];
  }

  /** The local calendar date at instant `t`. */
  dateAt(t: number): LocalDate {
    const wall = new Date(t + this.offset(t));
    return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
  }

  /**
   * The first instant of local date `date`: its midnight, or the transition when a DST gap
   * skips midnight.
   */
  startOf(date: LocalDate): number {
    return this.#firstInstantAtOrAfter(Date.UTC(date.year, date.month - 1, date.day));
  }

  /** ISO-8601 with this zone's offset at `t`, e.g. 2026-03-08T00:00:00.000-05:00. */
  iso(t: number): string {
    const offset = this.offset(t);
    const local = new Date(t + offset).toISOString().slice(0, -1);
    if (offset === 0) return `${local}Z`;
    const abs = Math.abs(offset) / 60_000;
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(Math.floor(abs % 60)).padStart(2, "0");
    return `${local}${offset < 0 ? "-" : "+"}${hh}:${mm}`;
  }

  // The offset Intl reports at `t`, to the second (it formats no milliseconds).
  #intlOffset(t: number): number {
    const at = Math.floor(t / 1000) * 1000;
    const parts: Record<string, number> = {};
    for (const part of this.#format.formatToParts(at)) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    const wall = Date.UTC(
      parts.year ?? 1970,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    );
    return wall - at;
  }

  #resolveDay(day: number): DayOffsets {
    let lo = day * DAY_MS;
    let hi = lo + DAY_MS;
    const before = this.#intlOffset(lo);
    const after = this.#intlOffset(hi);
    if (before === after) return before;
    // The offset changes in (lo, hi]: find the first millisecond with the new offset.
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.#intlOffset(mid) === before) lo = mid;
      else hi = mid;
    }
    return [before, hi, after];
  }

  /**
   * The earliest instant whose wall-clock time is `wall` (local fields encoded as if UTC),
   * or the first instant after it when a DST gap skips that wall time. In a fall-back
   * overlap this is the first of the two instants.
   */
  #firstInstantAtOrAfter(wall: number): number {
    const candidates = [wall - this.offset(wall - DAY_MS), wall - this.offset(wall + DAY_MS)];
    const valid = candidates.filter((t) => t + this.offset(t) === wall);
    if (valid.length > 0) return Math.min(...valid);
    // A gap: local time jumps over `wall`. Local time is increasing across a gap, so search
    // for the first instant whose wall-clock time is at or after `wall`.
    let lo = Math.min(...candidates);
    let hi = Math.max(...candidates);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid + this.offset(mid) >= wall) hi = mid;
      else lo = mid;
    }
    return hi;
  }
}

/** Whether `name` is a time zone Intl knows. */
export function isTimeZone(name: string): boolean {
  try {
    Zone.of(name);
    return true;
  } catch {
    return false;
  }
}

/** `date` moved by `days` calendar days (proleptic Gregorian, zone-free). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The Monday on or before `date`. */
export function mondayOf(date: LocalDate): LocalDate {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** The 1st of the month `months` after `date`'s month. */
export function firstOfMonth(date: LocalDate, months = 0): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 };
}

/** YYYY-MM-DD */
export function formatDate(date: LocalDate): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Compares two local dates. */
export function compareDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

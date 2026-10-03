import type { UsageQueries } from "../query/engine.ts";

/**
 * Numbers derived from limits and local usage: the spend pace and the projected time a
 * window runs out. Spend comes from the store through T6's query layer, priced exactly by
 * T2's cost engine; `pace` reads raw rows over the `usage_ts` index.
 */

const HOUR_MS = 3_600_000;

/** USD and tokens per hour. */
export interface Rate {
  costPerHour: number;
  tokensPerHour: number;
}

/**
 * Spend of store accounts (`accounts.id`) together: one root's, or every root's on one
 * subscription account (T16), whose limits they share. An empty list spends nothing.
 */
export interface SpendSource {
  /** USD and tokens per hour over the last `minutes`. */
  pace(accts: readonly number[], minutes: number): Rate;
  /** USD and tokens per hour from `from` to `to` (epoch ms), `to` itself included as in `pace`. */
  rate(accts: readonly number[], from: number, to: number): Rate;
  /** USD spent in `[from, to)` (epoch ms). */
  cost(accts: readonly number[], from: number, to: number): number;
}

/** A `SpendSource` over T6's query engine. */
export function spendFromQueries(queries: UsageQueries): SpendSource {
  return {
    pace(accts, minutes) {
      if (accts.length === 0) return { costPerHour: 0, tokensPerHour: 0 };
      // The accounts' spend summed, then made hourly: the pace of all of them together.
      let cost = 0;
      let tokens = 0;
      for (const pace of queries.pace({ accounts: accts, minutes }).accounts) {
        cost += pace.cost;
        tokens += pace.tokens;
      }
      return { costPerHour: cost * (60 / minutes), tokensPerHour: tokens * (60 / minutes) };
    },
    rate(accts, from, to) {
      if (to <= from || accts.length === 0) return { costPerHour: 0, tokensPerHour: 0 };
      const usage = queries.totals({ range: { from, to: to + 1 }, accounts: accts }).usage;
      const hours = (to - from) / HOUR_MS;
      return { costPerHour: usage.cost / hours, tokensPerHour: usage.tokens.total / hours };
    },
    cost(accts, from, to) {
      if (to <= from || accts.length === 0) return 0;
      return queries.totals({ range: { from, to }, accounts: accts }).usage.cost;
    },
  };
}

/** The pace window: spend per hour over the last 30 minutes. */
export const PACE_MINUTES = 30;
/** Below this much spend in a window, its utilisation per dollar is too noisy to project. */
export const MIN_WINDOW_SPEND_USD = 0.5;
/** A weekly window, 7 days: it projects from its average pace, and its times show coarsely. */
export const WEEK_MS = 7 * 24 * HOUR_MS;
/** A weekly window younger than this projects from the 30-minute pace: too little to average. */
export const MIN_AVERAGE_MS = 6 * HOUR_MS;

/** Which pace a window projects from: the last 30 minutes, or its average since it began. */
export type PaceBasis = "30m" | "window_avg";

/** A window's pace, and which one it is. */
export interface WindowPace extends Rate {
  basis: PaceBasis;
}

/** Whether a window of this length (ms) is a weekly one, whatever its kind or provider. */
export function isWeekly(windowMs: number | null): boolean {
  return windowMs !== null && windowMs >= WEEK_MS;
}

/**
 * The pace a window's projection runs on (T18). The one place it is chosen: the Overview's
 * cards, Accounts and the MCP tools all read it through `Limits.getLimits`.
 *
 * - **5-hour** (any window shorter than a week): the last 30 minutes, `recent`, a tenth of
 *   the window.
 * - **Weekly** (Claude's `weekly_all` and `weekly_scoped`, Codex's 7-day windows): the
 *   average since the window began, its spend from then to now over the hours in between,
 *   idle time and sleep included. Thirty minutes is under 0.5 % of a week: a burst of two
 *   agents at once, carried over the rest of the week, said a weekly limit would run out
 *   the same night. Under 6 hours into the window there is too little to average, and the
 *   last 30 minutes stand in.
 *
 * `rate(from)` is the spend per hour from `from` to now. A capture from before the
 * window's reset describes an older instance: the average is the current instance's.
 */
export function windowPace(
  windowMs: number | null,
  resetsAt: number,
  now: number,
  recent: Rate,
  rate: (from: number) => Rate,
): WindowPace {
  if (windowMs === null || !isWeekly(windowMs)) return { ...recent, basis: "30m" };
  const passed = now >= resetsAt ? Math.floor((now - resetsAt) / windowMs) + 1 : 0;
  const start = resetsAt + (passed - 1) * windowMs;
  if (now - start < MIN_AVERAGE_MS) return { ...recent, basis: "30m" };
  return { ...rate(start), basis: "window_avg" };
}

/** A projected exhaustion time (epoch ms), "safe" until the reset, or null for "—". */
export type Projection = number | "safe" | null;

export interface ProjectionInput {
  /** Utilisation at the capture, 0..1 (may exceed 1). */
  utilization: number;
  /** When it was captured (epoch ms). */
  capturedAt: number;
  /** The window's reset (epoch ms). */
  resetsAt: number;
  /** The window's length in ms, or null when unknown. */
  windowMs: number | null;
  /** The window's spend pace (USD per hour): `windowPace`'s. */
  costPerHour: number;
  now: number;
  /** USD the account spent in `[from, to)`. */
  spent(from: number, to: number): number;
}

/**
 * When the window reaches 100 % at its pace (`windowPace`). An **estimate**, to be labelled
 * as one wherever it is shown; a weekly window's only to about a part of a day.
 *
 * - The window started at `resetsAt - windowMs` (5 h or 7 d, from cc-usage's bucket
 *   metadata).
 * - Utilisation per dollar `k = u / S`, where `u` is the captured utilisation and `S` the
 *   USD this account spent from the window's start to the capture. Taken over the whole
 *   window so far, `k` is steadier than one from the change between two recent captures:
 *   the meter moves in whole percents, and a long window averages over the model and cache
 *   mix.
 * - Utilisation now is `u + k * (spend since the capture)`, so a capture minutes old still
 *   projects from now.
 * - At `pace` USD/h the rest of the window, `1 - u_now`, lasts `(1 - u_now) / (k * pace)`
 *   hours; the projection is now plus that. At or after the reset it is "safe".
 *
 * Null ("—") when the window has no known length, is already at 100 % or past its reset,
 * the window's spend is under $0.50, or the pace is zero. A window at 0 % despite that
 * spend is "safe": this account's spending does not move it.
 *
 * Limits of the estimate:
 * - Spend is what this machine's transcripts show, summed over every root linked to the
 *   account (T16). Usage of the same subscription elsewhere (another machine, claude.ai, a
 *   root not linked to it) moves the meter without showing up, which makes `k` too high
 *   and the projection too early.
 * - A window scoped to one model (Claude's per-model weekly limits) is divided by the
 *   account's whole spend, so its `k` is too low when other models dominate.
 * - API-equivalent dollars stand in for the provider's own, unpublished weighting, so a
 *   change in the model or cache mix changes `k`.
 * - The 5-hour window's pace is the last 30 minutes, which a burst or a pause dominates. A
 *   weekly window's is its average so far, which is slow to show a change of habit (a busy
 *   day after a quiet week).
 */
export function projectExhaustion(input: ProjectionInput): Projection {
  const { resetsAt, costPerHour, now } = input;
  const trend = windowTrend(input);
  if (trend === null || !(costPerHour > 0)) return null;
  if (trend.perDollar === 0) return "safe";
  if (trend.now >= 1) return now;
  const at = now + ((1 - trend.now) / (trend.perDollar * costPerHour)) * HOUR_MS;
  return at >= resetsAt ? "safe" : Math.round(at);
}

/**
 * The window's utilisation at its reset if its pace holds: utilisation now plus
 * `k * pace * hours left`, with `k` and its limits as in `projectExhaustion`. **An
 * estimate.** Null without enough data, or a zero pace.
 */
export function projectAtReset(input: ProjectionInput): number | null {
  const { resetsAt, costPerHour, now } = input;
  const trend = windowTrend(input);
  if (trend === null || !(costPerHour > 0)) return null;
  return trend.now + trend.perDollar * costPerHour * ((resetsAt - now) / HOUR_MS);
}

/**
 * Utilisation per dollar from the window's own history, and utilisation now; null when
 * the window has no known length, is at 100 % or past its reset, or saw under $0.50 of
 * spend before the capture.
 */
function windowTrend(input: ProjectionInput): { now: number; perDollar: number } | null {
  const { utilization: u, capturedAt, resetsAt, windowMs, now } = input;
  if (windowMs === null || !(u < 1) || now >= resetsAt || capturedAt >= resetsAt) return null;
  const spentToCapture = input.spent(resetsAt - windowMs, capturedAt);
  if (!(spentToCapture >= MIN_WINDOW_SPEND_USD)) return null;
  const perDollar = Math.max(0, u) / spentToCapture;
  // `now` itself included, as in the pace and T6's rolling periods.
  const since = perDollar > 0 && now >= capturedAt ? input.spent(capturedAt, now + 1) : 0;
  return { now: u + perDollar * since, perDollar };
}

// ── when, coarsely ───────────────────────────────────────────────────────────────────

/** Where each part of the day begins (local hour); the night runs on to 06:00. */
const PARTS = [
  [6, "morning"],
  [12, "afternoon"],
  [18, "evening"],
  [22, "night"],
] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MS = 24 * HOUR_MS;

/**
 * The part of the day local time `t` falls in, the day it belongs to (a local date, as a
 * UTC midnight; the small hours belong to the night that began the evening before), and
 * the local date and hour themselves.
 */
function partOf(t: number, offset: (t: number) => number) {
  const wall = t + offset(t);
  const hour = new Date(wall).getUTCHours();
  const date = Math.floor(wall / DAY_MS) * DAY_MS;
  const part = PARTS.findLast(([from]) => hour >= from)?.[1] ?? "night";
  return { day: date - (hour < PARTS[0][0] ? DAY_MS : 0), part, date, hour };
}

/**
 * A weekly window's projected time, as precise as it is (T18): a day and a part of it,
 * never minutes. Today: `~this morning`, `~this afternoon`, `~this evening`, `~tonight`.
 * The next day, all of it: `~tomorrow morning` … `~tomorrow night`. Later: `~Sun evening`,
 * and a week on, `~next Wed morning`.
 *
 * Mornings run from 06:00, afternoons from 12:00, evenings from 18:00, and nights from
 * 22:00 to 06:00. A night is named after the evening it begins, as people say it: 02:00 on
 * a Monday is "Sun night". Days are calendar days, so at 05:00 a time two hours on is "this
 * morning". In the small hours the night still running is "tonight", and the one coming
 * after the day is named by its weekday instead (`~Fri night`). Each part of each day has
 * one name. `offset(t)` is the zone's (`Zone.offset`).
 */
export function roughly(t: number, now: number, offset: (t: number) => number): string {
  const { day, part } = partOf(t, offset);
  const today = partOf(now, offset);
  const ahead = Math.round((day - today.date) / DAY_MS);
  const weekday = WEEKDAYS[new Date(day).getUTCDay()] as string;
  if (ahead < 0) return "~tonight";
  if (ahead === 0) {
    if (part !== "night") return `~this ${part}`;
    return today.hour < PARTS[0][0] ? `~${weekday} night` : "~tonight";
  }
  if (ahead === 1) return `~tomorrow ${part}`;
  return `~${ahead >= 7 ? "next " : ""}${weekday} ${part}`;
}

// ── how long, at most ────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
/** Each step's upper end (ms) and how it reads: a time left within it reads as it. */
const STEPS: readonly (readonly [number, string])[] = [
  ...[5, 10, 15, 20, 30, 45].map((m) => [m * MINUTE_MS, `<${m}m`] as const),
  ...[1, 1.5, 2, 3, 4, 6, 8, 12, 18, 24].map((h) => [h * HOUR_MS, `<${h}h`] as const),
];

/**
 * How long until a projected 100 % at `at`, from `now` (T26): `now` under a minute, else
 * the time left rounded **up** to the next step, so "within" holds: `<5m`, `<10m`, `<15m`,
 * `<20m`, `<30m`, `<45m`, `<1h`, `<1.5h`, `<2h`, `<3h`, `<4h`, `<6h`, `<8h`, `<12h`,
 * `<18h`, `<24h`; past a day, whole days up, `~2d`, `~3d` (only a weekly window gets that
 * far, and its projection is good to about a part of a day, hence `~`). Exactly 2 hours is
 * `<2h`, a minute more `<3h`. A duration, not a clock time: a DST change in between doesn't
 * move it.
 */
export function countdownTo(at: number, now: number): string {
  const left = at - now;
  if (left < MINUTE_MS) return "now";
  const step = STEPS.find(([upTo]) => left <= upTo);
  return step === undefined ? `~${Math.ceil(left / DAY_MS)}d` : step[1];
}

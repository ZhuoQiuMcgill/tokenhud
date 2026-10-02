import type { UsageQueries } from "../query/engine.ts";

/**
 * Numbers derived from limits and local usage: the spend pace and the projected time a
 * window runs out. Spend comes from the store through T6's query layer, priced exactly by
 * T2's cost engine; `pace` reads raw rows over the `usage_ts` index.
 */

/**
 * Spend of store accounts (`accounts.id`) together: one root's, or every root's on one
 * subscription account (T16), whose limits they share. An empty list spends nothing.
 */
export interface SpendSource {
  /** USD and tokens per hour over the last `minutes`. */
  pace(accts: readonly number[], minutes: number): { costPerHour: number; tokensPerHour: number };
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
  /** The account's spend pace (USD per hour). */
  costPerHour: number;
  now: number;
  /** USD the account spent in `[from, to)`. */
  spent(from: number, to: number): number;
}

/**
 * When the window reaches 100 % at the current pace. An **estimate**, to be labelled as one
 * wherever it is shown.
 *
 * - The window started at `resetsAt - windowMs` (5 h or 7 d, from cc-usage's bucket
 *   metadata).
 * - Utilisation per dollar `k = u / S`, where `u` is the captured utilisation and `S` the
 *   USD this account spent from the window's start to the capture.
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
 * - The pace is the last 30 minutes only; a burst or a pause dominates it.
 */
export function projectExhaustion(input: ProjectionInput): Projection {
  const { resetsAt, costPerHour, now } = input;
  const trend = windowTrend(input);
  if (trend === null || !(costPerHour > 0)) return null;
  if (trend.perDollar === 0) return "safe";
  if (trend.now >= 1) return now;
  const at = now + ((1 - trend.now) / (trend.perDollar * costPerHour)) * 3_600_000;
  return at >= resetsAt ? "safe" : Math.round(at);
}

/**
 * The window's utilisation at its reset if the current pace holds: utilisation now plus
 * `k * pace * hours left`, with `k` and its limits as in `projectExhaustion`. **An
 * estimate.** Null without enough data, or a zero pace.
 */
export function projectAtReset(input: ProjectionInput): number | null {
  const { resetsAt, costPerHour, now } = input;
  const trend = windowTrend(input);
  if (trend === null || !(costPerHour > 0)) return null;
  return trend.now + trend.perDollar * costPerHour * ((resetsAt - now) / 3_600_000);
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

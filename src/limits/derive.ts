import type { UsageQueries } from "../query/engine.ts";

/**
 * Numbers derived from limits and local usage: the spend pace and the projected time a
 * window runs out. Spend comes from the store through T6's query layer, priced exactly by
 * T2's cost engine; `pace` reads raw rows over the `usage_ts` index.
 */

/** Spend of one store account (`accounts.id`). */
export interface SpendSource {
  /** USD and tokens per hour over the last `minutes`. */
  pace(acct: number, minutes: number): { costPerHour: number; tokensPerHour: number };
  /** USD spent in `[from, to)` (epoch ms). */
  cost(acct: number, from: number, to: number): number;
}

/** A `SpendSource` over T6's query engine. */
export function spendFromQueries(queries: UsageQueries): SpendSource {
  return {
    pace(acct, minutes) {
      const pace = queries.pace({ accounts: [acct], minutes }).accounts[0];
      return { costPerHour: pace?.costPerHour ?? 0, tokensPerHour: pace?.tokensPerHour ?? 0 };
    },
    cost(acct, from, to) {
      if (to <= from) return 0;
      return queries.totals({ range: { from, to }, accounts: [acct] }).usage.cost;
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
 * - Spend is what this machine's transcripts show. Usage of the same subscription
 *   elsewhere (another machine, claude.ai, a Codex home not read here) moves the meter
 *   without showing up, which makes `k` too high and the projection too early.
 * - A window scoped to one model (Claude's per-model weekly limits) is divided by the
 *   account's whole spend, so its `k` is too low when other models dominate.
 * - API-equivalent dollars stand in for the provider's own, unpublished weighting, so a
 *   change in the model or cache mix changes `k`.
 * - The pace is the last 30 minutes only; a burst or a pause dominates it.
 */
export function projectExhaustion(input: ProjectionInput): Projection {
  const { utilization: u, capturedAt, resetsAt, windowMs, costPerHour, now } = input;
  if (windowMs === null || !(u < 1) || now >= resetsAt || capturedAt >= resetsAt) return null;
  const start = resetsAt - windowMs;
  const spentToCapture = input.spent(start, capturedAt);
  if (!(spentToCapture >= MIN_WINDOW_SPEND_USD)) return null;
  if (!(costPerHour > 0)) return null;
  const perDollar = Math.max(0, u) / spentToCapture;
  if (perDollar === 0) return "safe";
  // `now` itself included, as in the pace and T6's rolling periods.
  const uNow = u + perDollar * (now >= capturedAt ? input.spent(capturedAt, now + 1) : 0);
  if (uNow >= 1) return now;
  const at = now + ((1 - uNow) / (perDollar * costPerHour)) * 3_600_000;
  return at >= resetsAt ? "safe" : Math.round(at);
}

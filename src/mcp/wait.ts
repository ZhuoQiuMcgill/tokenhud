import { SAME_INSTANCE_MS } from "../limits/events.ts";
import type { AccountLimits, LimitWindow } from "../limits/index.ts";
import type { Zone } from "../query/tz.ts";
import {
  clock,
  DEFAULT_MIN_HEADROOM,
  duration,
  findWindow,
  percent,
  RESET_MARGIN_S,
} from "./decide.ts";

/**
 * `wait_for_reset`: sleeps until a limit window resets, in slices, for agents that cannot
 * resume on their own (`claude -p`, background tasks, teammates).
 *
 * - **Progress:** a notification after every slice (at most 30 s), with `total` and a
 *   message, because an idle stdio call is cut off after 30 minutes and progress resets
 *   that window (ARCHITECTURE.md §8.1). Without a progress token, it just sleeps.
 * - **Re-checks:** every 5 minutes, and once the reset (plus 30 s) is reached, through T8
 *   (`check(true)`), which keeps its own rate limits.
 * - **Ends** when the window resets (the time passes, or a re-check shows a new window), when
 *   utilisation drops under `until_utilization_below`, after `max_wait_s` (never later), or
 *   at once when the request is cancelled (`aborted: true`).
 */

export const MAX_WAIT_S = 18_000;
export const PROGRESS_EVERY_MS = 30_000;
export const RECHECK_EVERY_MS = 5 * 60_000;

export interface WaitClock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface WaitDeps {
  clock: WaitClock;
  zone: Zone;
  signal: AbortSignal;
  /** The account's limits; with `refresh`, after asking T8 for data at most 60 s old. */
  check(refresh: boolean): Promise<AccountLimits>;
  /** Sends one progress notification; absent when the request carried no progress token. */
  progress: ((progress: number, total: number, message: string) => Promise<void>) | null;
}

export interface WaitArgs {
  window?: string | undefined;
  max_wait_s: number;
  until_utilization_below?: number | undefined;
}

export interface WaitResult {
  waited_s: number;
  reset: boolean;
  utilization_now: number | null;
  aborted: boolean;
  window?: string;
  reason: string;
}

/**
 * The window to wait on: the one named, else the one `should_wait` would bind on at the
 * default headroom (the fullest window at or over 90 % that resets last), else the fullest.
 */
function target(limits: AccountLimits, name: string | undefined): LimitWindow | null {
  if (name !== undefined) return findWindow(limits, name);
  if (limits.windows.length === 0) return null;
  const full = limits.windows.filter((w) => w.utilization >= 1 - DEFAULT_MIN_HEADROOM);
  if (full.length > 0) return full.reduce((a, b) => (b.resets_at > a.resets_at ? b : a));
  return limits.windows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export async function waitForReset(args: WaitArgs, deps: WaitDeps): Promise<WaitResult> {
  const { clock: time, signal, zone } = deps;
  const start = time.now();
  const deadline = start + args.max_wait_s * 1000;
  const elapsed = () => Math.min(args.max_wait_s, Math.round((time.now() - start) / 1000));

  const aborted = (w: LimitWindow | null, u: number | null): WaitResult => ({
    waited_s: elapsed(),
    reset: false,
    utilization_now: u,
    aborted: true,
    ...(w !== null && { window: w.label }),
    reason: "cancelled",
  });

  /** A T8 re-check that never runs past the deadline: late, it falls back to the cache. */
  const checkBy = async (): Promise<AccountLimits> => {
    const left = deadline - time.now();
    if (left <= 0) return deps.check(false);
    const stop = new AbortController();
    const late = time.sleep(left, AbortSignal.any([signal, stop.signal])).then(() => null);
    const out = await Promise.race([deps.check(true), late]);
    stop.abort();
    return out ?? deps.check(false);
  };

  let limits = await deps.check(true);
  if (signal.aborted) return aborted(null, null);
  if (!limits.account.signed_in) {
    return {
      waited_s: 0,
      reset: false,
      utilization_now: null,
      aborted: false,
      reason: "limits unavailable: not signed in on this machine",
    };
  }
  const w = target(limits, args.window);
  if (w === null) {
    return {
      waited_s: 0,
      reset: false,
      utilization_now: null,
      aborted: false,
      reason: `limits unavailable: ${limits.error ?? "no limits captured yet"}`,
    };
  }
  const below = args.until_utilization_below;
  let u = w.utilization;
  const resetAt = w.resets_at;
  const done = (reset: boolean, reason: string): WaitResult => ({
    waited_s: elapsed(),
    reset,
    utilization_now: round4(u),
    aborted: false,
    window: w.label,
    reason,
  });
  if (below !== undefined && u < below) {
    return done(false, `${w.label} is at ${percent(u)}, already under ${percent(below)}`);
  }

  const end = Math.min(deadline, resetAt + RESET_MARGIN_S * 1000);
  const total = Math.max(1, Math.ceil((end - start) / 1000));
  let lastCheck = start;
  for (;;) {
    if (signal.aborted) return aborted(w, round4(u));
    const now = time.now();
    if (now >= resetAt + RESET_MARGIN_S * 1000) {
      limits = await checkBy();
      if (signal.aborted) return aborted(w, round4(u));
      u = limits.windows.find((x) => x.kind === w.kind)?.utilization ?? 0;
      return done(true, `${w.label} reset at ${clock(resetAt, now, zone)}; now at ${percent(u)}`);
    }
    if (now >= deadline) {
      return done(
        false,
        `stopped after max_wait_s (${duration(args.max_wait_s * 1000)}); ${w.label} is at ${percent(u)} and resets at ${clock(resetAt, now, zone)} (in ${duration(resetAt - now)})`,
      );
    }
    const next = Math.min(end, now + PROGRESS_EVERY_MS, lastCheck + RECHECK_EVERY_MS);
    await time.sleep(Math.max(0, next - now), signal);
    if (signal.aborted) return aborted(w, round4(u));

    const after = time.now();
    if (after - lastCheck >= RECHECK_EVERY_MS && after < resetAt + RESET_MARGIN_S * 1000) {
      limits = await checkBy();
      if (signal.aborted) return aborted(w, round4(u));
      lastCheck = time.now();
      const fresh = limits.windows.find((x) => x.kind === w.kind);
      if (fresh !== undefined) {
        u = fresh.utilization;
        // A capture of the next window: the reset came early (or the clock was off).
        if (fresh.resets_at - resetAt > SAME_INSTANCE_MS) {
          return done(true, `${w.label} has reset; now at ${percent(u)}`);
        }
      }
      if (below !== undefined && u < below) {
        return done(false, `${w.label} dropped to ${percent(u)}, under ${percent(below)}`);
      }
    }
    if (deps.progress !== null) {
      const at = time.now();
      const message = `waited ${duration(at - start)} of ${duration(total * 1000)}; ${w.label} ${percent(u)}, resets ${clock(resetAt, at, zone)}`;
      try {
        await deps.progress(Math.min(total, Math.round((at - start) / 1000)), total, message);
      } catch {
        // The client went away; the abort signal ends the wait.
      }
    }
  }
}

import { SAME_INSTANCE_MS } from "../limits/events.ts";
import type { AccountLimits, LimitWindow } from "../limits/index.ts";
import type { Zone } from "../query/tz.ts";
import { clock, duration, evaluate, percent, RESET_MARGIN_S } from "./decide.ts";

/**
 * `wait_for_reset`: sleeps until a limit window resets, in slices, for agents that cannot
 * resume on their own (`claude -p`, background tasks, teammates).
 *
 * - **Window:** the one named, else the one `should_wait` binds on for this `model`
 *   (account-wide windows, plus that model's own), else the fullest of those.
 * - **Progress:** a notification at least every 30 s, with `total` and a message, because
 *   an idle stdio call is cut off after 30 minutes and progress resets that window
 *   (ARCHITECTURE.md §8.1). It keeps coming while a T8 check is slow. Without a progress
 *   token, it just sleeps.
 * - **Checks:** at the start, every 5 minutes, and once the reset (plus 30 s) is reached,
 *   through T8 (`check(true)`), which keeps its own rate limits. None may run past the
 *   deadline or a cancellation: then the cached limits (`check(false)`) stand in.
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
  /** The agent's model id: model-scoped windows bind only when they match it. */
  model?: string | undefined;
}

export interface WaitResult {
  waited_s: number;
  reset: boolean;
  utilization_now: number | null;
  aborted: boolean;
  window?: string;
  reason: string;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export async function waitForReset(args: WaitArgs, deps: WaitDeps): Promise<WaitResult> {
  const { clock: time, signal, zone } = deps;
  const start = time.now();
  const deadline = start + args.max_wait_s * 1000;
  const elapsed = () => Math.min(args.max_wait_s, Math.round((time.now() - start) / 1000));
  /** The window waited on, once the first check has named it. */
  let w: LimitWindow | null = null;
  let u = 0;
  let resetAt = 0;
  let total = args.max_wait_s;
  let sent = 0;

  const tick = async (): Promise<void> => {
    if (deps.progress === null) return;
    const at = time.now();
    const value = Math.min(total, Math.round((at - start) / 1000));
    if (value <= sent) return;
    sent = value;
    const about =
      w === null
        ? "checking the limits"
        : `${w.label} ${percent(u)}, resets ${clock(resetAt, at, zone)}`;
    try {
      await deps.progress(
        value,
        total,
        `waited ${duration(at - start)} of ${duration(total * 1000)}; ${about}`,
      );
    } catch {
      // The client went away; the abort signal ends the wait.
    }
  };

  /**
   * A T8 check that can't stall progress or outlast the deadline or a cancellation: while it
   * runs, progress keeps ticking. Null when the deadline or the abort came first.
   */
  const guarded = async (): Promise<AccountLimits | null> => {
    if (deadline - time.now() <= 0) return null;
    const stop = new AbortController();
    const until = AbortSignal.any([signal, stop.signal]);
    const checking = deps.check(true);
    // A check that loses the race may still fail later; that is not this wait's concern.
    checking.catch(() => {});
    const ticking = (async (): Promise<null> => {
      for (;;) {
        const left = deadline - time.now();
        if (left <= 0 || until.aborted) return null;
        await time.sleep(Math.min(PROGRESS_EVERY_MS, left), until);
        if (until.aborted) return null;
        if (time.now() < deadline) await tick();
      }
    })();
    try {
      return await Promise.race([checking, ticking]);
    } finally {
      stop.abort();
    }
  };

  const aborted = (): WaitResult => ({
    waited_s: elapsed(),
    reset: false,
    utilization_now: w === null ? null : round4(u),
    aborted: true,
    ...(w !== null && { window: w.label }),
    reason: "cancelled",
  });
  const done = (reset: boolean, reason: string): WaitResult => ({
    waited_s: elapsed(),
    reset,
    utilization_now: round4(u),
    aborted: false,
    ...(w !== null && { window: w.label }),
    reason,
  });

  let limits = await guarded();
  if (signal.aborted) return aborted();
  limits ??= await deps.check(false);
  const first = evaluate(limits, args, time.now(), zone, () => null);
  if (first.window === null) {
    return {
      waited_s: elapsed(),
      reset: false,
      utilization_now: null,
      aborted: false,
      reason: first.verdict.reason,
    };
  }
  const target = first.window;
  w = target;
  u = target.utilization;
  resetAt = target.resets_at;
  const below = args.until_utilization_below;
  if (below !== undefined && u < below) {
    return done(false, `${target.label} is at ${percent(u)}, already under ${percent(below)}`);
  }

  const margin = RESET_MARGIN_S * 1000;
  const end = Math.min(deadline, resetAt + margin);
  total = Math.max(1, Math.ceil((end - start) / 1000));
  let lastCheck = time.now();
  for (;;) {
    if (signal.aborted) return aborted();
    const now = time.now();
    if (now >= resetAt + margin) {
      const fresh = await guarded();
      if (signal.aborted) return aborted();
      limits = fresh ?? (await deps.check(false));
      u = limits.windows.find((x) => x.kind === target.kind)?.utilization ?? 0;
      return done(
        true,
        `${target.label} reset at ${clock(resetAt, now, zone)}; now at ${percent(u)}`,
      );
    }
    if (now >= deadline) {
      return done(
        false,
        `stopped after max_wait_s (${duration(args.max_wait_s * 1000)}); ${target.label} is at ${percent(u)} and resets at ${clock(resetAt, now, zone)} (in ${duration(resetAt - now)})`,
      );
    }
    const next = Math.min(end, now + PROGRESS_EVERY_MS, lastCheck + RECHECK_EVERY_MS);
    await time.sleep(Math.max(0, next - now), signal);
    if (signal.aborted) return aborted();
    await tick();

    const after = time.now();
    if (after - lastCheck >= RECHECK_EVERY_MS && after < resetAt + margin) {
      const fresh = await guarded();
      if (signal.aborted) return aborted();
      limits = fresh ?? (await deps.check(false));
      lastCheck = time.now();
      const latest = limits.windows.find((x) => x.kind === target.kind);
      if (latest !== undefined) {
        u = latest.utilization;
        // A capture of the next window: the reset came early (or the clock was off).
        if (latest.resets_at - resetAt > SAME_INSTANCE_MS) {
          return done(true, `${target.label} has reset; now at ${percent(u)}`);
        }
      }
      if (below !== undefined && u < below) {
        return done(false, `${target.label} dropped to ${percent(u)}, under ${percent(below)}`);
      }
    }
  }
}

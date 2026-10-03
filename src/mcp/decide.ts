import {
  isWeekly,
  MIN_WINDOW_SPEND_USD,
  type PaceBasis,
  type Projection,
  roughly,
} from "../limits/derive.ts";
import type { AccountLimits, LimitWindow } from "../limits/index.ts";
import { scopeMatches, windowScope } from "../limits/scope.ts";
import type { Zone } from "../query/tz.ts";
import type { DetectedVia, Resolved } from "./accounts.ts";
import { ToolError } from "./errors.ts";

// A window's model scope lives in src/limits/scope.ts, which `tokenhud hook` loads alone.
export { scopeMatches, windowScope };

/**
 * The `limits` view of an account and the `should_wait` verdict, as pure functions of T8's
 * `AccountLimits`. Times leave here as ISO-8601 in the server's zone, since agents read
 * them; T8 keeps epoch ms.
 */

/** Wait when the projected exhaustion falls within this much of now (and before the reset). */
export const PROJECTION_HORIZON_MS = 10 * 60_000;
/** `wait_s` runs to the binding window's reset plus this, so the reset has surely happened. */
export const RESET_MARGIN_S = 30;
export const DEFAULT_MIN_HEADROOM = 0.1;
/** Limits older than this are called out in a verdict's reason. */
const STALE_NOTE_S = 10 * 60;

/** A window's pace and projection, as `limits` and `should_wait` report them. */
export interface PaceView {
  /** The pace the window projects from, USD per hour. */
  pace_cost_per_h: number | null;
  /** "30m": the last 30 minutes; "window_avg": a weekly window's average since it began. */
  pace_basis: PaceBasis | null;
  /**
   * An estimate at that pace: an instant, "safe" (not before the reset), or null. A weekly
   * window's instant is coarse, good to about a part of a day.
   */
  projected_exhaustion_at: string | "safe" | null;
  /**
   * Whole seconds from now to that instant (T26), 0 once it has come; null when there is no
   * instant ("safe" or null above).
   */
  projected_exhaustion_in_s: number | null;
}

export interface WindowView extends PaceView {
  kind: string;
  label: string;
  /** 0..1 (a provider may report more than 1). */
  utilization: number;
  resets_at: string;
  stale_s: number;
}

export interface LimitsView {
  account: {
    label: string;
    provider: string;
    config_dir: string;
    signed_in: boolean;
    detected_via: DetectedVia;
    /** The id of the roots on its subscription account (T16), or null for a root alone. */
    group: string | null;
    /** The labels of the other roots on that account: the windows and pace are theirs too. */
    shared_with: string[];
  };
  windows: WindowView[];
  as_of: string | null;
  /** The last fetch error when the windows are older than it; null otherwise. */
  error: string | null;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

function paceView(w: LimitWindow, zone: Zone, now: number): PaceView {
  const p: Projection = w.projected_exhaustion_at;
  return {
    pace_cost_per_h: w.pace_cost_per_h === null ? null : round(w.pace_cost_per_h, 2),
    pace_basis: w.pace_basis,
    projected_exhaustion_at: typeof p === "number" ? zone.iso(p) : p,
    // Rounded down: an agent reading it as a deadline is never told it has longer.
    projected_exhaustion_in_s:
      typeof p === "number" ? Math.max(0, Math.floor((p - now) / 1000)) : null,
  };
}

export function limitsView(
  resolved: Resolved,
  limits: AccountLimits,
  zone: Zone,
  now: number,
): LimitsView {
  return {
    account: {
      label: limits.account.label,
      provider: limits.account.provider,
      config_dir: resolved.root.path,
      signed_in: limits.account.signed_in,
      detected_via: resolved.detectedVia,
      group: limits.group?.id ?? null,
      shared_with: (limits.group?.members ?? [])
        .filter((m) => m.id !== limits.account.id)
        .map((m) => m.label),
    },
    windows: limits.windows.map((w) => ({
      kind: w.kind,
      label: w.label,
      utilization: round(w.utilization, 4),
      resets_at: zone.iso(w.resets_at),
      ...paceView(w, zone, now),
      stale_s: w.stale_s,
    })),
    as_of: limits.as_of === null ? null : zone.iso(limits.as_of),
    error: limits.error,
  };
}

/**
 * The window a `window` argument names: its kind ("session", "weekly_all") or its label
 * ("5-HOUR", "weekly"), ignoring case. Throws a `ToolError` naming the account's windows.
 */
export function findWindow(limits: AccountLimits, name: string): LimitWindow {
  const wanted = name.trim().toLowerCase();
  const found = limits.windows.find(
    (w) => w.kind.toLowerCase() === wanted || w.label.toLowerCase() === wanted,
  );
  if (found !== undefined) return found;
  const known = limits.windows.map((w) => `${w.label} (${w.kind})`).join(", ") || "none";
  throw new ToolError("bad_argument", `no window '${name}' on this account (windows: ${known})`);
}

// ── text ─────────────────────────────────────────────────────────────────────────

export const percent = (u: number) => `${Math.round(u * 100)}%`;

/** A short duration: "45s", "1m 15s" (seconds under 10 minutes), "38m", "2h 10m", "3d 4h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** Local wall-clock time "16:58", with the date when it is not today ("Oct 3 16:58"). */
export function clock(t: number, now: number, zone: Zone): string {
  const iso = zone.iso(t);
  const time = iso.slice(11, 16);
  if (iso.slice(0, 10) === zone.iso(now).slice(0, 10)) return time;
  const month = new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `${month} ${Number(iso.slice(8, 10))} ${time}`;
}

/**
 * When a window is projected to run out: `at 15:08`, or for a weekly window, whose
 * projection is good to about a part of a day, `~tonight` or `~Sun evening` (T18).
 */
function projected(w: LimitWindow, at: number, now: number, zone: Zone): string {
  if (!isWeekly(w.window_s === null ? null : w.window_s * 1000))
    return `at ${clock(at, now, zone)}`;
  return roughly(at, now, (t) => zone.offset(t));
}

function resets(w: LimitWindow, now: number, zone: Zone): string {
  const at = clock(w.resets_at, now, zone);
  return w.resets_at <= now
    ? `has reset (at ${at})`
    : `resets at ${at} (in ${duration(w.resets_at - now)})`;
}

// ── which windows bind ───────────────────────────────────────────────────────────

/**
 * Utilisation compares to `1 - min_headroom` with this tolerance: 1 - 0.18 is
 * 0.8200000000000001 in floating point, and 82 % must still count as at the line.
 */
const EPSILON = 1e-9;

/**
 * The windows that bind this agent: the one `window` names (an explicit choice binds
 * whatever its scope), else every account-wide window plus the model-scoped ones whose
 * model is `model`. The rest only get a note.
 */
function relevance(
  limits: AccountLimits,
  args: { window?: string | undefined; model?: string | undefined },
): { binding: LimitWindow[]; others: LimitWindow[] } {
  if (args.window !== undefined) return { binding: [findWindow(limits, args.window)], others: [] };
  const binding: LimitWindow[] = [];
  const others: LimitWindow[] = [];
  for (const w of limits.windows) {
    const scope = windowScope(limits.account.provider, w);
    const binds = scope === null || (args.model !== undefined && scopeMatches(scope, args.model));
    (binds ? binding : others).push(w);
  }
  return { binding, others };
}

// ── should_wait ──────────────────────────────────────────────────────────────────

export interface ShouldWaitArgs {
  min_headroom?: number | undefined;
  window?: string | undefined;
  /** USD (API-equivalent) the work about to start is expected to cost. */
  estimated_cost?: number | undefined;
  /** The agent's model id: model-scoped windows bind only when they match it. */
  model?: string | undefined;
}

/** The verdict; with a `window`, that window's pace and projection too (`PaceView`). */
export interface ShouldWaitResult extends Partial<PaceView> {
  wait: boolean;
  reason: string;
  window?: string;
  utilization: number | null;
  resets_at?: string;
  wait_s: number;
}

/** USD the account spent in `[from, to)` (epoch ms), or null without usage data for it. */
export type Spent = (from: number, to: number) => number | null;

interface Hit {
  window: LimitWindow;
  why: string;
}

/**
 * Utilisation per USD in a window, from the spend between its start and the capture (T8's
 * projection rule), or null when that is unknown or too small to scale.
 */
function perDollar(w: LimitWindow, asOf: number, now: number, spent: Spent): number | null {
  if (w.window_s === null || now >= w.resets_at || asOf >= w.resets_at) return null;
  const s = spent(w.resets_at - w.window_s * 1000, asOf);
  if (s === null || !(s >= MIN_WINDOW_SPEND_USD)) return null;
  return Math.max(0, w.utilization) / s;
}

const unavailable = (reason: string): ShouldWaitResult => ({
  wait: false,
  reason: `limits unavailable: ${reason}`,
  utilization: null,
  wait_s: 0,
});

/** A verdict, and the window it is about: the binding one, else the fullest that binds. */
export interface Evaluation {
  verdict: ShouldWaitResult;
  window: LimitWindow | null;
}

/**
 * Whether to pause before more work. Wait when a window that binds this agent (see
 * `relevance`) is at `1 - min_headroom` or more, would get there after `estimated_cost`, or
 * is projected to run out within 10 minutes and before its reset. `wait_s` runs to the
 * reset of the binding window, the triggered one that resets last (all must have reset
 * before work can go on), plus 30 s. Another model's window at the line is only noted.
 */
export function evaluate(
  limits: AccountLimits,
  args: ShouldWaitArgs,
  now: number,
  zone: Zone,
  spent: Spent,
): Evaluation {
  if (!limits.account.signed_in) {
    return { verdict: unavailable("not signed in on this machine"), window: null };
  }
  if (limits.windows.length === 0 || limits.as_of === null) {
    return { verdict: unavailable(limits.error ?? "no limits captured yet"), window: null };
  }
  const { binding: windows, others } = relevance(limits, args);
  const asOf = limits.as_of;
  const headroom = args.min_headroom ?? DEFAULT_MIN_HEADROOM;
  const ceiling = 1 - headroom;
  const atLine = (u: number) => u >= ceiling - EPSILON;
  const cost = args.estimated_cost;
  const hits: Hit[] = [];
  const costNotes: string[] = [];
  let unscaled = false;
  for (const w of windows) {
    if (atLine(w.utilization)) {
      hits.push({
        window: w,
        why: `${w.label} is at ${percent(w.utilization)}, at or over ${percent(ceiling)}`,
      });
      continue;
    }
    const p = w.projected_exhaustion_at;
    if (typeof p === "number" && p < w.resets_at && p < now + PROJECTION_HORIZON_MS) {
      hits.push({
        window: w,
        why: `${w.label} is at ${percent(w.utilization)} and is projected (an estimate) to run out ${projected(w, p, now, zone)}`,
      });
      continue;
    }
    if (cost !== undefined && cost > 0) {
      const k = perDollar(w, asOf, now, spent);
      if (k === null) {
        unscaled = true;
        continue;
      }
      const after = w.utilization + k * ((spent(asOf, now + 1) ?? 0) + cost);
      if (atLine(after)) {
        hits.push({
          window: w,
          why: `an estimated $${cost.toFixed(2)} would take ${w.label} from ${percent(w.utilization)} to about ${percent(after)}, over ${percent(ceiling)}`,
        });
      } else {
        costNotes.push(`${w.label} to about ${percent(after)}`);
      }
    }
  }

  const notes = others
    .filter((w) => atLine(w.utilization))
    .map((w) => {
      const until = w.resets_at > now ? ` until ${clock(w.resets_at, now, zone)}` : "";
      const which =
        args.model === undefined
          ? "it limits one model only; pass model to check yours"
          : "another model's limit";
      return `note: ${w.label} is at ${percent(w.utilization)}${until} (${which})`;
    });
  const age = Math.floor((now - asOf) / 1000);
  const tail =
    notes.map((n) => `; ${n}`).join("") +
    (age > STALE_NOTE_S ? ` (limits data ${duration(age * 1000)} old)` : "");
  if (hits.length > 0) {
    const binding = hits.reduce((a, b) => (b.window.resets_at > a.window.resets_at ? b : a));
    const w = binding.window;
    return {
      verdict: {
        wait: true,
        reason: `${binding.why}; it ${resets(w, now, zone)}${tail}`,
        window: w.label,
        utilization: round(w.utilization, 4),
        resets_at: zone.iso(w.resets_at),
        ...paceView(w, zone, now),
        wait_s: Math.max(0, Math.ceil((w.resets_at - now) / 1000)) + RESET_MARGIN_S,
      },
      window: w,
    };
  }
  if (windows.length === 0) {
    return {
      verdict: {
        wait: false,
        reason: `headroom ok: no window limits this model${tail}`,
        utilization: null,
        wait_s: 0,
      },
      window: null,
    };
  }
  const top = windows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  let reason = `headroom ok: ${top.label} is at ${percent(top.utilization)} and ${resets(top, now, zone)}`;
  if (costNotes.length > 0)
    reason += `; an estimated $${cost?.toFixed(2)} takes ${costNotes.join(", ")}`;
  if (unscaled)
    reason += "; estimated_cost not checked for windows with too little spend to scale it";
  return {
    verdict: {
      wait: false,
      reason: reason + tail,
      window: top.label,
      utilization: round(top.utilization, 4),
      resets_at: zone.iso(top.resets_at),
      ...paceView(top, zone, now),
      wait_s: 0,
    },
    window: top,
  };
}

export function shouldWait(
  limits: AccountLimits,
  args: ShouldWaitArgs,
  now: number,
  zone: Zone,
  spent: Spent,
): ShouldWaitResult {
  return evaluate(limits, args, now, zone, spent).verdict;
}

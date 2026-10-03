import { bucketLabel, type Capture, orderedBuckets, windowMinutes } from "../limits/capture.ts";
import { SAME_INSTANCE_MS } from "../limits/events.ts";
import { windowScope } from "../limits/scope.ts";
import type { Alert, AlertAccount, AlertWindow, Delivery } from "./store.ts";

/**
 * Which limit windows an alert watches, whether it fires, and what it says. Pure functions
 * of a window list, shared by `tokenhud hook` (windows from limits.json's captures), the
 * MCP tools and the TUI (windows from T8's `Limits`).
 */

/** A limit window as alerts read it: T8's `LimitWindow` has these fields. */
export interface WindowState {
  kind: string;
  label: string;
  /** 0..1 (a provider may report more); 0 once `resets_at` has passed. */
  utilization: number;
  /** Epoch ms. */
  resets_at: number;
  /** The window's length in seconds, or null when unknown. */
  window_s: number | null;
}

const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 86_400;
/** Utilisation compares to the threshold with this tolerance (0.82 * 100 is 81.99999999999999). */
const EPSILON = 1e-9;
/** Limits older than this get "(limits as of 6m ago)" in an alert's message. */
export const STALE_AFTER_MS = 2 * 60_000;

/**
 * Whether `alert`'s window kind covers `w`: "5h" the account-wide 5-hour window, "weekly"
 * the account-wide weekly one, "weekly_scoped" a model's own weekly window (each of them),
 * "any" every window.
 */
export function watches(
  window: AlertWindow,
  provider: string,
  w: Pick<WindowState, "kind" | "label" | "window_s">,
): boolean {
  if (window === "any") return true;
  const scoped = windowScope(provider, w) !== null;
  if (window === "5h") return !scoped && w.window_s === FIVE_HOURS_S;
  if (window === "weekly") return !scoped && w.window_s === WEEK_S;
  return scoped && w.window_s === WEEK_S;
}

/** A capture's windows as of `now`, as T8's `Limits` derives them. */
export function captureWindows(capture: Capture | null, now: number): WindowState[] {
  return orderedBuckets(capture).map(([kind, bucket]) => {
    const resetsAt = bucket.resets_at * 1000;
    const minutes = windowMinutes(kind, bucket);
    return {
      kind,
      label: bucketLabel(kind, bucket),
      utilization: now >= resetsAt ? 0 : bucket.used_percentage / 100,
      resets_at: resetsAt,
      window_s: minutes === null ? null : minutes * 60,
    };
  });
}

/** The delivery of `w`'s current instance, if the alert already fired (or was set) for it. */
export function deliveryFor(alert: Alert, w: Pick<WindowState, "kind" | "resets_at">) {
  return alert.delivered.find(
    (d) => d.kind === w.kind && Math.abs(d.resets_at - w.resets_at) < SAME_INSTANCE_MS,
  );
}

/** Whether `w` is at or over the alert's threshold now (a window past its reset never is). */
export function overLine(at: number, w: WindowState, now: number): boolean {
  return w.resets_at > now && w.utilization * 100 >= at - EPSILON;
}

/** One watched window of an alert, and where the alert stands with it. */
export interface Watched {
  window: WindowState;
  /** "armed": not fired for this instance; "fired": fired (or set over the line) for it. */
  status: "armed" | "fired";
  delivery: Delivery | null;
  /** Over the line and not yet fired for this instance: the alert fires now. */
  fires: boolean;
}

/** The windows `alert` watches among `windows`, each with its status. */
export function watched(alert: Alert, windows: readonly WindowState[], now: number): Watched[] {
  return windows
    .filter((w) => watches(alert.window, alert.account.provider, w))
    .map((w) => {
      const delivery = w.resets_at > now ? (deliveryFor(alert, w) ?? null) : null;
      return {
        window: w,
        status: delivery === null ? "armed" : "fired",
        delivery,
        fires: delivery === null && overLine(alert.at, w, now),
      };
    });
}

/**
 * Where the alert stands: "fired" when it fired (or was set over the line) for the current
 * instance of every window it watches, with the latest of those times; else "armed", which
 * includes an account with no such window captured yet.
 */
export function alertStatus(
  alert: Alert,
  windows: readonly WindowState[],
  now: number,
): { status: "armed" | "fired"; fired_at: number | null } {
  const ws = watched(alert, windows, now);
  if (ws.length === 0 || ws.some((w) => w.status === "armed")) {
    return { status: "armed", fired_at: null };
  }
  return { status: "fired", fired_at: Math.max(...ws.map((w) => w.delivery?.at ?? 0)) };
}

/** When it last fired (set-over-the-line deliveries aside), or null. */
export function lastFired(alert: Alert): number | null {
  const fired = alert.delivered.filter((d) => d.on_set !== true).map((d) => d.at);
  return fired.length === 0 ? null : Math.max(...fired);
}

/**
 * The roots on the alert's subscription account now, by limits.json's `groups` (written by
 * T16's detection, manual links included); the ones recorded when it was set until
 * detection has run.
 */
export function currentMembers(
  groups: Readonly<Record<string, { id: string }>> | undefined,
  account: AlertAccount,
): string[] {
  if (groups === undefined) return account.members;
  const id = groups[account.id]?.id;
  if (id === undefined) return [account.id];
  return Object.keys(groups).filter((root) => groups[root]?.id === id);
}

// ── the message ──────────────────────────────────────────────────────────────────

/** "45s", "38m", "1h12m", "2d4h": compact, for one line of an agent's context. */
export function compact(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`;
}

/** "5-hour limit", "weekly limit", or the provider's label ("FABLE WEEKLY limit"). */
export function windowName(provider: string, w: WindowState): string {
  const scoped = windowScope(provider, w) !== null;
  if (!scoped && w.window_s === FIVE_HOURS_S) return "5-hour limit";
  if (!scoped && w.window_s === WEEK_S) return "weekly limit";
  return `${w.label} limit`;
}

/**
 * The alert's line for an agent:
 * `[tokenhud alert] 5-hour limit (personal) is at 82% (alert at 80%), resets in 1h12m.
 * Note: pause the refactor and commit. Call should_wait before long tasks.`, with
 * `(limits as of 6m ago)` after the reset when the capture is over 2 minutes old.
 */
export function alertMessage(alert: Alert, w: WindowState, asOf: number, now: number): string {
  const stale = now - asOf > STALE_AFTER_MS ? ` (limits as of ${compact(now - asOf)} ago)` : "";
  const note =
    alert.note === null ? "" : ` Note: ${alert.note}${/[.!?]$/.test(alert.note) ? "" : "."}`;
  return (
    `[tokenhud alert] ${windowName(alert.account.provider, w)} (${alert.account.label}) is at ` +
    `${Math.round(w.utilization * 100)}% (alert at ${alert.at}%), resets in ` +
    `${compact(w.resets_at - now)}${stale}.${note} Call should_wait before long tasks.`
  );
}

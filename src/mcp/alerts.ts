import { alertStatus, deliveryFor, type WindowState, watched } from "../alerts/match.ts";
import { type Alert, readHookSeen, type ServerPlace, staleSession } from "../alerts/store.ts";
import type { Zone } from "../query/tz.ts";
import { clock, percent } from "./decide.ts";

/**
 * What the alert tools (`set_alert`, `list_alerts`, `clear_alert`) answer, as pure
 * functions of an alert, its account's windows and the hook's record (T29). Times leave as
 * ISO-8601 in the server's zone.
 */

/** At most this many alerts in alerts.json, every session's together. */
export const MAX_ALERTS = 100;

export const HOOK_WARNING =
  "alerts are stored but this session hasn't run the tokenhud hook: install the tokenhud plugin, or run `tokenhud mcp install --hooks`";
export const STALE_WARNING =
  "the tokenhud hook runs, but for a newer Claude Code session than the one this MCP server started in (after /clear or a resume), so session alerts set here can't reach it: use scope persistent, or reconnect the server with /mcp";
export const NO_SESSION_WARNING =
  "this session's id is unknown (Claude Code passes it as CLAUDE_CODE_SESSION_ID), so whether it runs the tokenhud hook can't be checked";

export interface AlertWindowView {
  kind: string;
  label: string;
  utilization: number;
  resets_at: string;
  /**
   * "armed": not told for this window instance yet; "fired": told; "already_reached": it
   * was at or over the threshold when the alert was set, so it counts as told and fires
   * next for the window's next instance.
   */
  status: "armed" | "fired" | "already_reached";
  /** When it was told (or the alert set, for already_reached); null while armed. */
  fired_at: string | null;
}

export interface AlertView {
  id: string;
  scope: "session" | "persistent";
  window: Alert["window"];
  at: number;
  note: string | null;
  account: { label: string; provider: string };
  created_at: string;
  /** "fired": for the current instance of every window it watches; else "armed". */
  status: "armed" | "fired";
  fired_at: string | null;
  /** Who is told: this session, or Claude Code sessions on the account (persistent). */
  delivered_to: string;
  windows: AlertWindowView[];
}

export interface HookDelivery {
  /** When this session's hook last ran; null when it never has (or the session is unknown). */
  hook_seen_at: string | null;
  /** Why alerts may not reach this session; null when the hook runs. */
  warning: string | null;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

export function windowViews(
  alert: Alert,
  windows: readonly WindowState[],
  zone: Zone,
  now: number,
): AlertWindowView[] {
  return watched(alert, windows, now).map((w) => {
    const d = w.delivery;
    return {
      kind: w.window.kind,
      label: w.window.label,
      utilization: round(w.window.utilization),
      resets_at: zone.iso(w.window.resets_at),
      status: d === null ? "armed" : d.on_set === true ? "already_reached" : "fired",
      fired_at: d === null ? null : zone.iso(d.at),
    };
  });
}

export function alertView(
  alert: Alert,
  windows: readonly WindowState[],
  session: string | null,
  zone: Zone,
  now: number,
): AlertView {
  const { status, fired_at } = alertStatus(alert, windows, now);
  return {
    id: alert.id,
    scope: alert.session === null ? "persistent" : "session",
    window: alert.window,
    at: alert.at,
    note: alert.note,
    account: { label: alert.account.label, provider: alert.account.provider },
    created_at: zone.iso(alert.created_at),
    status,
    fired_at: fired_at === null ? null : zone.iso(fired_at),
    delivered_to:
      alert.session === null
        ? `Claude Code sessions on ${alert.account.label}`
        : alert.session === session
          ? "this session"
          : "another session",
    windows: windowViews(alert, windows, zone, now),
  };
}

/**
 * Whether alerts reach this session: its hook's last run, from the MCP heartbeat dir. When
 * it never ran but ran for another session of this config dir since the server started, the
 * server's session id is stale (a /clear or resume it couldn't follow): said so, rather than
 * telling the user to install a hook they have.
 */
export function delivery(
  mcpDir: string,
  session: string | null,
  place: ServerPlace,
  zone: Zone,
): HookDelivery {
  if (session === null) return { hook_seen_at: null, warning: NO_SESSION_WARNING };
  const seen = readHookSeen(mcpDir, session);
  if (seen !== null) return { hook_seen_at: zone.iso(seen.seen_at), warning: null };
  return {
    hook_seen_at: null,
    warning: staleSession(mcpDir, session, place) ? STALE_WARNING : HOOK_WARNING,
  };
}

const KIND_NAMES: Record<Alert["window"], string> = {
  "5h": "5-hour window",
  weekly: "weekly window",
  weekly_scoped: "model's own weekly window",
  any: "window",
};

/** What `set_alert` says about the alert it just set. */
export function setMessage(
  alert: Alert,
  windows: readonly WindowState[],
  captured: boolean,
  zone: Zone,
  now: number,
): string {
  const ws = watched(alert, windows, now);
  const line = `${alert.at}%`;
  if (ws.length === 0) {
    return captured
      ? `armed: this account has no ${KIND_NAMES[alert.window]} now; the alert fires if one reaches ${line}`
      : `armed: no limits captured for this account yet; the alert fires once a ${KIND_NAMES[alert.window]} shows ${line}`;
  }
  const over = ws.filter((w) => w.delivery?.on_set === true);
  const armed = ws.filter((w) => deliveryFor(alert, w.window) === undefined);
  const parts: string[] = [];
  if (over.length > 0) {
    const which = over
      .map(
        (w) =>
          `${w.window.label} is already at ${percent(w.window.utilization)} (resets at ${clock(w.window.resets_at, now, zone)})`,
      )
      .join("; ");
    parts.push(
      `${which}: at or over ${line} already, so that counts as told, and the alert fires for it again only after its reset`,
    );
  }
  if (armed.length > 0) {
    const which = armed
      .map((w) => `${w.window.label} (now ${percent(w.window.utilization)})`)
      .join(", ");
    parts.push(`armed: you'll be told when ${which} reaches ${line}`);
  }
  return parts.join("; ");
}

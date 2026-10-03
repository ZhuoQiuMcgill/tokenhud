import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SAME_INSTANCE_MS } from "../limits/events.ts";
import { withLock } from "../limits/lease.ts";
import { configDir } from "../paths.ts";

/**
 * Limit alerts that agents set through the MCP server (T29), `<config dir>/alerts.json`:
 *
 *     {"alerts": [{"id", "created_at", "session", "account": {"id", "label", "provider",
 *       "group", "members"}, "window", "at", "note", "delivered": [{"kind", "resets_at",
 *       "at", "on_set"?}]}]}
 *
 * Times are epoch ms. `session` is the Claude Code session the alert ends with, or null for
 * a persistent one. `account` is the root it was set on, with the roots on its subscription
 * account then (T16). `delivered` lists the window instances (a window's kind and reset) it
 * already fired for, `on_set` marking one that was over the line when the alert was set.
 * It never holds a credential, a path or transcript content; `note` is the agent's own
 * text, at most 200 characters on one line.
 *
 * Writers (the MCP tools, `tokenhud hook`) take the file's lock, re-read it, change it and
 * replace it atomically, so no process loses another's alert. Readers take no lock.
 *
 * Each `tokenhud hook` run also records, in the MCP heartbeat dir, when it last saw its
 * session (`hook-<session>.json`): the MCP tools warn when it never has, and a session
 * alert expires once its session has shown no hook or MCP activity for 24 hours.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const ALERTS_FILE = "alerts.json";
export const ALERT_WINDOWS = ["5h", "weekly", "weekly_scoped", "any"] as const;
export type AlertWindow = (typeof ALERT_WINDOWS)[number];
export const NOTE_MAX = 200;
/** A session alert outlives its session's last hook or MCP activity by this. */
export const SESSION_TTL_MS = 24 * 3_600_000;
/** A hook run rewrites its session's seen file at most this often. */
export const SEEN_EVERY_MS = 60_000;
/** The file's lock is short-lived: a writer holds it for one read-modify-write. */
const LOCK_TTL_MS = 2_000;

/**
 * Claude Code session ids are UUIDs. Anything else (a dot, a slash) is ignored rather than
 * joined into a path.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function alertsPath(env: Env = process.env, home: string = homedir()): string {
  return join(configDir(env, home), ALERTS_FILE);
}

export interface AlertAccount {
  /** The root identity the alert was set on. */
  id: string;
  label: string;
  provider: "claude" | "codex";
  /** Its group's id when it was set (T16), or null for a root alone. */
  group: string | null;
  /** The roots on its subscription account when it was set, itself included. */
  members: string[];
}

/** A window instance the alert fired for. */
export interface Delivery {
  /** The window's kind ("session", "weekly_all", ...). */
  kind: string;
  /** The instance's reset, epoch ms. */
  resets_at: number;
  /** When it fired, or when the alert was set for `on_set`. */
  at: number;
  /** Already at or over the line when the alert was set: counted as delivered, never told. */
  on_set?: true;
}

export interface Alert {
  id: string;
  created_at: number;
  /** The session it ends with; null: persistent. */
  session: string | null;
  account: AlertAccount;
  window: AlertWindow;
  /** Percent used, 1-100. */
  at: number;
  note: string | null;
  delivered: Delivery[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The agent's note on one line, without control characters, at most 200 characters. */
export function cleanNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const text = note
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text.slice(0, NOTE_MAX);
}

function parseDelivery(value: unknown): Delivery | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (!finite(value.resets_at) || !finite(value.at)) return null;
  const out: Delivery = { kind: value.kind, resets_at: value.resets_at, at: value.at };
  if (value.on_set === true) out.on_set = true;
  return out;
}

function parseAccount(value: unknown): AlertAccount | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  if (value.provider !== "claude" && value.provider !== "codex") return null;
  const members = Array.isArray(value.members)
    ? value.members.filter((m): m is string => typeof m === "string" && m !== "")
    : [];
  return {
    id: value.id,
    label: typeof value.label === "string" ? value.label : value.id.slice(0, 8),
    provider: value.provider,
    group: typeof value.group === "string" ? value.group : null,
    members: members.includes(value.id) ? members : [value.id, ...members],
  };
}

/** One alert read back from the file; null when it is not well formed. */
export function parseAlert(value: unknown): Alert | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  const account = parseAccount(value.account);
  const window = ALERT_WINDOWS.find((w) => w === value.window);
  if (account === null || window === undefined || !finite(value.created_at)) return null;
  if (!finite(value.at) || value.at < 1 || value.at > 100) return null;
  const session = value.session;
  if (session !== null && (typeof session !== "string" || !SESSION_ID.test(session))) return null;
  return {
    id: value.id,
    created_at: value.created_at,
    session,
    account,
    window,
    at: value.at,
    note: cleanNote(typeof value.note === "string" ? value.note : null),
    delivered: Array.isArray(value.delivered)
      ? value.delivered.map(parseDelivery).filter((d): d is Delivery => d !== null)
      : [],
  };
}

/**
 * The alerts at `path`, and whether the file was there but unreadable as a whole (it is
 * then replaced on the next write). A missing file has none. Never throws.
 */
export function readAlerts(path: string): { alerts: Alert[]; unreadable: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { alerts: [], unreadable: false };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { alerts: [], unreadable: true };
  }
  if (!isRecord(data) || !Array.isArray(data.alerts)) return { alerts: [], unreadable: true };
  return {
    alerts: data.alerts.map(parseAlert).filter((a): a is Alert => a !== null),
    unreadable: false,
  };
}

export function loadAlerts(path: string): Alert[] {
  return readAlerts(path).alerts;
}

function save(path: string, alerts: readonly Alert[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ alerts }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Re-reads the alerts and lets `edit` change the list in place, under the file's lock;
 * saves it when `edit` returns true. Returns the list as it is after. Throws when the lock
 * stays taken or the file can't be written (it is then left as it was).
 */
export function editAlerts(path: string, edit: (alerts: Alert[]) => boolean): Alert[] {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(
    `${path}.lock`,
    () => {
      const { alerts, unreadable } = readAlerts(path);
      if (edit(alerts) || unreadable) save(path, alerts);
      return alerts;
    },
    LOCK_TTL_MS,
  );
}

// ── sessions ─────────────────────────────────────────────────────────────────────

/** What a hook run records of its session. */
export interface HookSeen {
  session: string;
  seen_at: number;
  /** The hook's parent: the Claude Code process, which also started the session's MCP server. */
  ppid: number | null;
}

const SEEN_FILE = /^hook-([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/;

export function hookSeenPath(mcpDir: string, session: string): string {
  return join(mcpDir, `hook-${session}.json`);
}

function parseSeen(text: string): HookSeen | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || typeof raw.session !== "string" || !SESSION_ID.test(raw.session)) {
      return null;
    }
    if (!finite(raw.seen_at)) return null;
    return {
      session: raw.session,
      seen_at: raw.seen_at,
      ppid: Number.isInteger(raw.ppid) ? (raw.ppid as number) : null,
    };
  } catch {
    return null;
  }
}

export function readHookSeen(mcpDir: string, session: string): HookSeen | null {
  if (!SESSION_ID.test(session)) return null;
  try {
    return parseSeen(readFileSync(hookSeenPath(mcpDir, session), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Records that the hook ran for `session`: rewrites its seen file when it is missing,
 * older than a minute, or names another parent. Throws when it can't be written.
 */
export function recordHookSeen(
  mcpDir: string,
  session: string,
  now: number,
  ppid: number | null,
): void {
  const seen = readHookSeen(mcpDir, session);
  if (seen !== null && now - seen.seen_at < SEEN_EVERY_MS && seen.ppid === ppid) return;
  const path = hookSeenPath(mcpDir, session);
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(mcpDir, { recursive: true });
  try {
    writeFileSync(tmp, `${JSON.stringify({ session, seen_at: now, ppid })}\n`);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function removeHookSeen(mcpDir: string, session: string): void {
  if (!SESSION_ID.test(session)) return;
  rmSync(hookSeenPath(mcpDir, session), { force: true });
}

/** Every session's seen file. Unreadable ones are skipped; nothing here throws. */
export function listHookSeen(mcpDir: string): HookSeen[] {
  let names: string[];
  try {
    names = readdirSync(mcpDir);
  } catch {
    return [];
  }
  const out: HookSeen[] = [];
  for (const name of names) {
    if (!SEEN_FILE.test(name)) continue;
    try {
      const seen = parseSeen(readFileSync(join(mcpDir, name), "utf8"));
      if (seen !== null) out.push(seen);
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/** Removes the seen files of sessions quiet for 24 hours (a session that crashed). */
export function sweepHookSeen(mcpDir: string, now: number): void {
  for (const seen of listHookSeen(mcpDir)) {
    if (now - seen.seen_at <= SESSION_TTL_MS) continue;
    try {
      removeHookSeen(mcpDir, seen.session);
    } catch {
      // read-only or vanished: nothing to clean up
    }
  }
}

/**
 * When each session was last active: its hook's seen file, and the heartbeat of an MCP
 * server running for it (`session` in `<pid>.json`, rewritten every minute while it runs).
 */
export function sessionActivity(mcpDir: string): Map<string, number> {
  const out = new Map<string, number>();
  const note = (session: string, at: number) =>
    out.set(session, Math.max(out.get(session) ?? at, at));
  for (const seen of listHookSeen(mcpDir)) note(seen.session, seen.seen_at);
  let names: string[];
  try {
    names = readdirSync(mcpDir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(mcpDir, name), "utf8"));
      if (!isRecord(raw) || !finite(raw.updated_at)) continue;
      if (typeof raw.session === "string" && SESSION_ID.test(raw.session)) {
        note(raw.session, raw.updated_at);
      }
    } catch {
      // damaged or gone meanwhile
    }
  }
  return out;
}

/** Whether a session alert's session has been quiet for 24 hours. Persistent ones never expire. */
export function expired(alert: Alert, now: number, activity: ReadonlyMap<string, number>): boolean {
  if (alert.session === null) return false;
  const last = Math.max(alert.created_at, activity.get(alert.session) ?? 0);
  return now - last > SESSION_TTL_MS;
}

/**
 * Drops expired session alerts and the deliveries of window instances long over (a reset
 * past by more than the instance tolerance). Returns whether anything changed.
 */
export function prune(
  alerts: Alert[],
  now: number,
  activity: ReadonlyMap<string, number>,
): boolean {
  let changed = false;
  for (let i = alerts.length - 1; i >= 0; i--) {
    const alert = alerts[i] as Alert;
    if (expired(alert, now, activity)) {
      alerts.splice(i, 1);
      changed = true;
      continue;
    }
    const kept = alert.delivered.filter((d) => d.resets_at + SAME_INSTANCE_MS >= now);
    if (kept.length !== alert.delivered.length) {
      alert.delivered = kept;
      changed = true;
    }
  }
  return changed;
}

/**
 * This MCP server's Claude Code session: the newest session whose hook ran under the same
 * Claude Code process since the server started (a /clear or /resume starts a new session
 * in that process, while the server keeps the environment it started with), else
 * `CLAUDE_CODE_SESSION_ID`. Null when neither names one.
 */
export function currentSession(
  env: Env,
  mcpDir: string,
  ppid: number,
  startedAt: number,
): string | null {
  let best: HookSeen | null = null;
  for (const seen of listHookSeen(mcpDir)) {
    if (seen.ppid !== ppid || seen.seen_at < startedAt) continue;
    if (best === null || seen.seen_at > best.seen_at) best = seen;
  }
  if (best !== null) return best.session;
  const id = env.CLAUDE_CODE_SESSION_ID;
  return id !== undefined && SESSION_ID.test(id) ? id : null;
}

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { limitsPath, loadLimitsCache } from "../limits/cache.ts";
import { freshest } from "../limits/capture.ts";
import { configDir, mcpDir } from "../paths.ts";
import { rootIdentity } from "../sources/roots.ts";
import { fileLog, LOG_DIR_NAME, scrub } from "../tui/log.ts";
import {
  alertMessage,
  captureWindows,
  currentMembers,
  deliveryFor,
  type WindowState,
  watched,
} from "./match.ts";
import { claudeProcess, type ReadProc } from "./proc.ts";
import {
  type Alert,
  alertsPath,
  editAlerts,
  loadAlerts,
  prune,
  readAlerts,
  recordHookSeen,
  removeHookSeen,
  SESSION_ID,
  sessionActivity,
  tryEditAlerts,
} from "./store.ts";

/**
 * `tokenhud hook`: the Claude Code hook that tells an agent about its limit alerts (T29).
 * Claude Code runs it on PostToolBatch and UserPromptSubmit, with the event as JSON on
 * stdin; it prints a hook reply whose `hookSpecificOutput.additionalContext` holds one line
 * per alert that fires, and nothing at all otherwise. On SessionEnd it removes the
 * session's alerts.
 *
 * Its data are alerts.json and limits.json. Besides them it keeps its session's record in
 * the MCP heartbeat dir (once a minute, naming the Claude Code process above it: see
 * src/alerts/proc.ts), and reads that dir when an alert fires, to drop expired session
 * alerts. No network, no store, no credentials. It never blocks or fails the agent: on any
 * error it prints nothing, exits 0 and logs the error once to `logs/hook.log`; and the
 * command line Claude Code runs ends `; exit 0` (src/alerts/install.ts), so even a tokenhud
 * without this command can't block a prompt.
 *
 * Which alerts: the session's own (on whatever account each was set), and the persistent
 * ones on the account the session runs on, or on another root of its subscription account
 * (T16). An alert fires when a window it watches is at or over its threshold and it has
 * not fired for that window's current instance; it is then marked delivered, under the
 * file's lock, before it is printed, so two hooks never both tell it. Only the main
 * thread is told: inside a subagent (`agent_id`), alerts wait for the main thread's next
 * event.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface HookOptions {
  env: Env;
  home: string;
  now: number;
  /** The hook's parent (`process.ppid`): the shell its command runs in. */
  ppid: number | null;
  /** How processes are read here (`procReader()`), to name the Claude Code process above. */
  readProc: ReadProc | null;
  log: (message: string) => void;
}

/** SessionEnd's whole budget is 1.5 s: it waits this long for the lock, then skips. */
export const SESSION_END_WAIT_MS = 300;

/** The context Claude Code caps a field at; longer is saved to a file the agent isn't shown. */
const MAX_CONTEXT = 9_000;

class BadInput extends Error {}

interface HookEvent {
  name: string;
  session: string;
  /** The session's config dir, from its transcript's path; null when that isn't one. */
  root: string | null;
  /** Fired inside a subagent. */
  subagent: boolean;
}

function parseEvent(input: string): HookEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new BadInput("the hook input is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadInput("the hook input is not a JSON object");
  }
  const event = raw as Record<string, unknown>;
  const session = event.session_id;
  if (typeof session !== "string" || !SESSION_ID.test(session)) {
    throw new BadInput("the hook input has no valid session_id");
  }
  if (typeof event.hook_event_name !== "string") {
    throw new BadInput("the hook input has no hook_event_name");
  }
  return {
    name: event.hook_event_name,
    session,
    root: transcriptRoot(event.transcript_path),
    subagent: typeof event.agent_id === "string" && event.agent_id !== "",
  };
}

/** `<root>` of a transcript path `<root>/projects/<project>/<session>.jsonl`, else null. */
function transcriptRoot(path: unknown): string | null {
  if (typeof path !== "string" || !path.endsWith(".jsonl")) return null;
  const projects = dirname(dirname(path));
  return basename(projects) === "projects" ? dirname(projects) : null;
}

/** The session's account: its transcript's root, else CLAUDE_CONFIG_DIR, else ~/.claude. */
function sessionIdentity(event: HookEvent, o: HookOptions): string {
  const dir = event.root ?? (o.env.CLAUDE_CONFIG_DIR || join(o.home, ".claude"));
  return rootIdentity(dir, o.home);
}

/** Runs the hook on one event; returns what to print (empty for nothing). Never throws. */
export function runHook(input: string, o: HookOptions): string {
  try {
    return hook(input, o);
  } catch (error) {
    o.log(
      error instanceof BadInput
        ? error.message
        : `failed (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)})`,
    );
    return "";
  }
}

function hook(input: string, o: HookOptions): string {
  const event = parseEvent(input);
  const mcp = mcpDir(o.env, o.home);
  const path = alertsPath(o.env, o.home);
  if (event.name === "SessionEnd") {
    endSession(path, mcp, event.session, o);
    return "";
  }
  if (event.name !== "PostToolBatch" && event.name !== "UserPromptSubmit") return "";
  let identity: string | null = null;
  const sessionRoot = () => {
    identity ??= sessionIdentity(event, o);
    return identity;
  };
  try {
    recordHookSeen(mcp, event.session, o.now, {
      ppid: o.ppid,
      claude: () => (o.ppid === null ? null : claudeProcess(o.ppid, o.readProc)),
      root: sessionRoot,
    });
  } catch (error) {
    // Delivery goes on; set_alert will only warn that it can't see the hook.
    o.log(`cannot record the session's hook (${(error as NodeJS.ErrnoException).code})`);
  }
  if (event.subagent) return "";
  const { alerts, unreadable } = readAlerts(path);
  if (unreadable) o.log("alerts.json is unreadable; it is moved aside on the next change");
  if (alerts.length === 0) return "";
  const limits = loadLimitsCache(limitsPath(o.env, o.home));
  const onSessionAccount = (alert: Alert) =>
    currentMembers(limits.groups, alert.account).includes(sessionRoot());
  const due: Array<{ alert: Alert; window: WindowState; asOf: number }> = [];
  for (const alert of alerts) {
    const mine = alert.session === null ? onSessionAccount(alert) : alert.session === event.session;
    if (!mine) continue;
    const members = currentMembers(limits.groups, alert.account);
    const capture = freshest(members.map((id) => limits.providers[id]));
    if (capture === null) continue;
    for (const w of watched(alert, captureWindows(capture, o.now), o.now)) {
      if (w.fires) due.push({ alert, window: w.window, asOf: capture.captured_at * 1000 });
    }
  }
  if (due.length === 0) return "";
  const lines = deliver(path, mcp, due, o);
  if (lines.length === 0) return "";
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: event.name, additionalContext: fit(lines) },
  })}\n`;
}

/**
 * Marks each due alert delivered for its window's instance, under the file's lock, and
 * returns the lines of those this run marked: another hook may have told one meanwhile.
 */
function deliver(
  path: string,
  mcp: string,
  due: ReadonlyArray<{ alert: Alert; window: WindowState; asOf: number }>,
  o: HookOptions,
): string[] {
  const { now } = o;
  const activity = sessionActivity(mcp);
  const lines: string[] = [];
  editAlerts(
    path,
    (alerts) => {
      const pruned = prune(alerts, now, activity);
      for (const d of due) {
        const alert = alerts.find((a) => a.id === d.alert.id);
        if (alert === undefined || deliveryFor(alert, d.window) !== undefined) continue;
        alert.delivered.push({ kind: d.window.kind, resets_at: d.window.resets_at, at: now });
        lines.push(alertMessage(alert, d.window, d.asOf, now));
      }
      return pruned || lines.length > 0;
    },
    { now, log: o.log },
  );
  return lines;
}

/** The lines within Claude Code's cap, the rest counted. */
function fit(lines: readonly string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_CONTEXT) break;
    kept.push(line);
    size += line.length + 1;
  }
  const more = lines.length - kept.length;
  if (more > 0) kept.push(`[tokenhud alert] ${more} more alerts fired: call list_alerts.`);
  return kept.join("\n");
}

/**
 * SessionEnd: the session's alerts and its seen file go. Within Claude Code's 1.5 s budget:
 * when alerts.json stays locked for 300 ms, its alerts are left to the 24-hour expiry.
 */
function endSession(path: string, mcp: string, session: string, o: HookOptions): void {
  removeHookSeen(mcp, session);
  if (!loadAlerts(path).some((a) => a.session === session)) return;
  const done = tryEditAlerts(
    path,
    (alerts) => {
      const before = alerts.length;
      for (let i = alerts.length - 1; i >= 0; i--) {
        if (alerts[i]?.session === session) alerts.splice(i, 1);
      }
      return alerts.length !== before;
    },
    { waitMs: SESSION_END_WAIT_MS, now: o.now, log: o.log },
  );
  if (done === null) o.log("SessionEnd: alerts.json stayed locked; its alerts expire in 24 h");
}

// ── the log ──────────────────────────────────────────────────────────────────────

export const HOOK_LOG = "hook.log";

export function hookLogPath(env: Env, home: string): string {
  return join(configDir(env, home), LOG_DIR_NAME, HOOK_LOG);
}

/** The last line of a file, from its last 4 KB; "" when there is none. */
function lastLine(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").trimEnd().split("\n");
    return lines[lines.length - 1] ?? "";
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The hook's log, `<config dir>/logs/hook.log` (size-capped and scrubbed as the TUI's): a
 * failure is written once, not again while it is the last thing logged, since the hook
 * runs after every batch of tool calls.
 */
export function hookLog(path: string, home: string): (message: string) => void {
  const log = fileLog(path, home);
  return (message) => {
    const last = lastLine(path);
    if (last.endsWith(` warn ${scrub(message, home)}`)) return;
    log.write("warn", message);
  };
}

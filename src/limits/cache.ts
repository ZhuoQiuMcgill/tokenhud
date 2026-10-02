import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ccUsageDir } from "../config.ts";
import { configDir } from "../paths.ts";
import { type Capture, freshest, parseCapture } from "./capture.ts";
import type { GroupRecord, PairState, PairWindow } from "./groups.ts";
import { withLock } from "./lease.ts";

/**
 * The last-good limits of every account, `~/.config/tokenhud/limits.json`. Its
 * `providers` map holds captures in exactly the shape of cc-usage's `provider-limits.json`,
 * keyed by account identity (the root's `sha256(resolved path)[:32]`) instead of
 * `claude:<label>`; `status` holds each account's fetch state, so the back-off, the Claude
 * rate limit and the history-only check hold across the TUI's Worker and every MCP server
 * process that reads and writes this file; `pairs` and `groups` hold which roots share one
 * subscription account (src/limits/groups.ts). It never holds a credential or a raw
 * response.
 *
 * Every write takes the file's lock, re-reads the file, merges into it (a capture is
 * replaced only by a fresher one) and replaces it atomically (a temp file, then a rename),
 * so processes that share it never lose each other's updates.
 */

type Env = Readonly<Record<string, string | undefined>>;

export function limitsPath(env: Env = process.env, home: string = homedir()): string {
  return join(configDir(env, home), "limits.json");
}

/** cc-usage's limits cache, imported once, read-only. */
export function ccUsageLimitsPath(env: Env = process.env, home: string = homedir()): string {
  return join(ccUsageDir(env, home), "provider-limits.json");
}

/** An account's fetch state. Times are epoch ms. */
export interface AccountStatus {
  /** False for a history-only account: shown, never fetched (or rarely, see `history_only`). */
  signed_in: boolean;
  /**
   * Why the account is history-only: "config" (listed in `history_only_roots`: never
   * fetched) or "detected" (no credential file, or a sign-in that could not be refreshed or
   * was refused: checked again daily, or as soon as the credential file changes). Null when
   * signed in.
   */
  history_only: "config" | "detected" | null;
  /** When `history_only` was last decided. */
  checked_at: number | null;
  /** The credential file's mtime then; null when it was missing. */
  cred_mtime: number | null;
  /** Consecutive failed fetches (drives the back-off). */
  errors: number;
  /** The last failure's message (never holds a credential); null after a success. */
  last_error: string | null;
  last_attempt_at: number | null;
  /** No scheduled fetch before this: the 5-minute cadence, or the back-off after errors. */
  next_at: number | null;
}

export function initialStatus(): AccountStatus {
  return {
    signed_in: true,
    history_only: null,
    checked_at: null,
    cred_mtime: null,
    errors: 0,
    last_error: null,
    last_attempt_at: null,
    next_at: null,
  };
}

export interface LimitsFile {
  /** Account identity -> its last-good capture. */
  providers: Record<string, Capture>;
  /** Account identity -> its fetch state. */
  status: Record<string, AccountStatus>;
  /** `pairKey` of two roots -> what auto-detection found of them; absent until it ran. */
  pairs?: Record<string, PairState>;
  /** Account identity -> the group of roots on its account; absent until detection ran. */
  groups?: Record<string, GroupRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function parseStatus(value: unknown): AccountStatus | null {
  if (!isRecord(value)) return null;
  const status = initialStatus();
  if (typeof value.signed_in === "boolean") status.signed_in = value.signed_in;
  if (value.history_only === "config" || value.history_only === "detected") {
    status.history_only = value.history_only;
  }
  status.checked_at = numberOrNull(value.checked_at);
  status.cred_mtime = numberOrNull(value.cred_mtime);
  const errors = numberOrNull(value.errors);
  status.errors = errors !== null && errors >= 0 ? Math.trunc(errors) : 0;
  status.last_error = typeof value.last_error === "string" ? value.last_error : null;
  status.last_attempt_at = numberOrNull(value.last_attempt_at);
  status.next_at = numberOrNull(value.next_at);
  return status;
}

/**
 * A pair's auto-detection state. One from before the co-movement rule (no `windows`) starts
 * over, unconfirmed: the rule it was decided by could link two idle accounts.
 */
function parsePair(value: unknown): PairState | null {
  if (!isRecord(value) || typeof value.linked !== "boolean") return null;
  const last = Array.isArray(value.last) ? value.last.map(numberOrNull) : [];
  const [a, b] = last;
  if (last.length !== 2 || a == null || b == null) return null;
  const count = (x: unknown) => {
    const n = numberOrNull(x);
    return n !== null && n >= 0 ? Math.trunc(n) : 0;
  };
  if (value.windows === undefined) {
    return { agree: 0, disagree: 0, linked: false, detected_at: null, last: [a, b], windows: null };
  }
  let windows: Record<string, PairWindow> | null = null;
  if (isRecord(value.windows)) {
    windows = {};
    for (const [kind, raw] of Object.entries(value.windows)) {
      const u = isRecord(raw) ? numberOrNull(raw.u) : null;
      const r = isRecord(raw) ? numberOrNull(raw.r) : null;
      if (u !== null && r !== null) windows[kind] = { u, r };
    }
  }
  return {
    agree: count(value.agree),
    disagree: count(value.disagree),
    linked: value.linked,
    detected_at: value.linked ? numberOrNull(value.detected_at) : null,
    last: [a, b],
    windows,
  };
}

function parseGroup(value: unknown): GroupRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  const detectedAt = numberOrNull(value.detected_at);
  if (detectedAt === null || (value.source !== "auto" && value.source !== "manual")) return null;
  return { id: value.id, detected_at: detectedAt, source: value.source };
}

/** The well-formed entries of `value`, a record of `parse`d values; null when it is not one. */
function records<T>(value: unknown, parse: (v: unknown) => T | null): Record<string, T> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = parse(raw);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

/** The cache at `path`; empty when it is missing or unreadable. Never throws. */
export function loadLimitsCache(path: string): LimitsFile {
  const file: LimitsFile = { providers: {}, status: {} };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return file;
  }
  if (!isRecord(data)) return file;
  if (isRecord(data.providers)) {
    for (const [id, raw] of Object.entries(data.providers)) {
      const capture = parseCapture(raw);
      if (capture !== null) file.providers[id] = capture;
    }
  }
  file.status = records(data.status, parseStatus) ?? {};
  const pairs = records(data.pairs, parsePair);
  if (pairs !== null) file.pairs = pairs;
  const groups = records(data.groups, parseGroup);
  if (groups !== null) file.groups = groups;
  return file;
}

/** Writes `file` atomically (a per-process temp file, then a rename). Throws on failure. */
export function saveLimitsCache(file: LimitsFile, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** One account's change to the shared file. */
export interface CacheUpdate {
  capture?: Capture | null;
  status?: AccountStatus;
}

/**
 * Re-reads the file, applies `updates` (a capture replaces the stored one only when it is
 * fresher), and writes it back, all under the file's lock (`limits.json.lock`), so another
 * process's update made in between is never lost. Returns the merged file. Throws
 * `LeaseTimeoutError` when the lock stays taken (the file is then left as it was).
 */
export function updateLimitsCache(
  path: string,
  updates: ReadonlyMap<string, CacheUpdate>,
  lockTtlMs?: number,
): LimitsFile {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(
    `${path}.lock`,
    () => {
      const file = loadLimitsCache(path);
      for (const [id, update] of updates) {
        if (update.capture) {
          // On a tie the update wins: it was decided (snapshot over last-good) after the read.
          const best = freshest([update.capture, file.providers[id]]);
          if (best !== null) file.providers[id] = best;
        }
        if (update.status) file.status[id] = update.status;
      }
      saveLimitsCache(file, path);
      return file;
    },
    lockTtlMs,
  );
}

/**
 * Re-reads the file and lets `edit` change it, all under the file's lock; writes it back
 * when `edit` returns true. Returns the file as it is after. Throws as `updateLimitsCache`.
 */
export function editLimitsCache(
  path: string,
  edit: (file: LimitsFile) => boolean,
  lockTtlMs?: number,
): LimitsFile {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(
    `${path}.lock`,
    () => {
      const file = loadLimitsCache(path);
      if (edit(file)) saveLimitsCache(file, path);
      return file;
    },
    lockTtlMs,
  );
}

/**
 * Where one fetch lease lives: beside limits.json, in `.limits-leases/`. `key` is a root's
 * identity, or the id of a group of roots on one account, which are fetched as one.
 */
export function leasePath(limitsPath: string, key: string): string {
  return join(dirname(limitsPath), ".limits-leases", `${key}.lease`);
}

/** An account as cc-usage named it: its labels are the ones in cc-usage's ledger. */
export interface KnownAccount {
  provider: string;
  identity: string;
  label: string;
}

/**
 * The captures of cc-usage's `provider-limits.json` (read-only), keyed by identity: its
 * keys are `claude:<label>` and `codex:<label>`, matched against accounts by provider and
 * label. Pass the store's accounts first (they carry cc-usage's labels, imported from its
 * ledger), then the discovered roots. Unknown labels and bare legacy keys are skipped, as
 * cc-usage's own loader skips the latter. Captures are marked `via: "cc-usage"`.
 */
export function importCcUsageLimits(
  path: string,
  accounts: readonly KnownAccount[],
): Record<string, Capture> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const providers = isRecord(data) ? data.providers : null;
  if (!isRecord(providers)) return {};
  const out: Record<string, Capture> = {};
  for (const [name, raw] of Object.entries(providers)) {
    const colon = name.indexOf(":");
    if (colon < 0) continue;
    const provider = name.slice(0, colon);
    const label = name.slice(colon + 1);
    const account = accounts.find((a) => a.provider === provider && a.label === label);
    const capture = parseCapture(raw);
    if (account === undefined || capture === null || capture.source !== provider) continue;
    capture.via = "cc-usage";
    out[account.identity] ??= capture;
  }
  return out;
}

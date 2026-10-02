import { existsSync } from "node:fs";
import type { Log } from "../ingest/pass.ts";
import type { Root } from "../sources/roots.ts";
import {
  type AccountStatus,
  type CacheUpdate,
  importCcUsageLimits,
  initialStatus,
  type KnownAccount,
  type LimitsFile,
  leasePath,
  loadLimitsCache,
  saveLimitsCache,
  updateLimitsCache,
} from "./cache.ts";
import {
  type Capture,
  CodexAppServerUnavailable,
  freshest,
  LimitFetchError,
  SignedOut,
} from "./capture.ts";
import { credentialsMtime, fetchClaudeLimits } from "./claude.ts";
import { codexAuthMtime, fetchCodexLimits } from "./codex.ts";
import { type Lease, tryLease } from "./lease.ts";
import { type CodexSnapshots, NO_SNAPSHOTS } from "./snapshots.ts";

/**
 * Keeps every account's limits current, off the UI thread: the ingest Worker runs one
 * (after its first scan, then on its own timer) and answers `refreshLimits` requests with
 * it; the MCP server can run one for its on-demand refreshes.
 *
 * - **Cadence:** each account is fetched every 5 minutes.
 * - **On demand:** `refresh(account, maxAgeS)` fetches only when the account's data is
 *   older than `maxAgeS`. Requests for an account already being fetched join that fetch,
 *   and a Claude account is fetched at most once per 30 s.
 * - **Back-off:** consecutive failures wait 30 s, 1, 2, 4 ... minutes, up to 30 minutes,
 *   before the next attempt (on demand too).
 * - **History-only accounts** (`signed_in: false`): an account in `history_only_roots` is
 *   never fetched. One detected as not signed in here (Claude: no credential file, or a
 *   sign-in the official client could not refresh; Codex: the app-server's request refused
 *   as unauthorised) is checked again once a day, or as soon as its credential file appears
 *   or changes (only the file's mtime is read here).
 * - **Codex:** an account's limits are the freshest of its rollout snapshot (T5), its
 *   last-good capture and, for the default `~/.codex` only, the app-server RPC run with
 *   that CODEX_HOME. That is where cc-usage ran the RPC; every other Codex home, including
 *   the Windows ones seen from WSL, relies on snapshots, as in cc-usage. An app-server that
 *   cannot work at all latches the RPC off for the life of the process.
 * - **Never blank:** a failure keeps the last-good capture and records the error; readers
 *   show the capture's age.
 * - **Across processes:** fetch state lives in limits.json beside the captures, and an
 *   account is fetched only under its lease file, so the cadence, the back-off, the 30 s
 *   rate limit and de-duplication hold across the ingest Worker and every MCP server
 *   process (see `#run`).
 * Nothing here throws to the caller.
 */

export interface LimitsTiming {
  intervalMs: number;
  claudeMinGapMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  recheckMs: number;
  /** A fetch lease older than this belongs to a crashed process (a fetch takes at most ~1 min). */
  leaseTtlMs: number;
}

export const DEFAULT_LIMITS_TIMING: LimitsTiming = {
  intervalMs: 5 * 60_000,
  claudeMinGapMs: 30_000,
  backoffMinMs: 30_000,
  backoffMaxMs: 30 * 60_000,
  recheckMs: 24 * 3_600_000,
  leaseTtlMs: 2 * 60_000,
};

/** The shortest wait between scheduled rounds. */
const MIN_ROUND_DELAY_MS = 1_000;
/** `stop()` returns within this, whatever is still running (it has been aborted). */
const STOP_WAIT_MS = 1_500;

export interface LimitsServiceOptions {
  /** limits.json. */
  limitsPath: string;
  /** cc-usage's provider-limits.json, imported once when limits.json does not exist yet. */
  ccUsageLimits?: string | null;
  /** The enabled roots of both providers, read again every round. */
  roots: () => readonly Root[];
  /** Accounts as cc-usage labelled them (the store's), for the import. */
  knownAccounts?: () => readonly KnownAccount[];
  snapshots?: CodexSnapshots;
  /** Stores the events a capture implies (the ingest Worker's store); absent elsewhere. */
  recordEvents?: ((root: Root, capture: Capture) => void) | null;
  /** Called with the identities whose entry in limits.json changed. */
  onChanged?: (accounts: string[]) => void;
  /** Fetchers get the service's signal, aborted by `stop()`. */
  fetchClaude?: (root: Root, signal: AbortSignal) => Promise<Capture>;
  fetchCodex?: (root: Root, signal: AbortSignal) => Promise<Capture>;
  credentialsMtime?: (root: Root) => number | null;
  /** Whether a Codex root gets the app-server RPC; the default `~/.codex` when it exists. */
  usesRpc?: (root: Root) => boolean;
  /** Epoch ms. */
  now?: () => number;
  log?: Log;
  timing?: Partial<LimitsTiming>;
}

/** What `refresh` did for one account. */
export interface RefreshOutcome {
  /** The account's identity. */
  account: string;
  /** A provider was asked (a network request or the app-server). */
  fetched: boolean;
  /** The account's last fetch error, when its data is older than that failure. */
  error: string | null;
}

type Mode = { kind: "scheduled" } | { kind: "demand"; maxAgeMs: number };

/** The result of one fetch; `capture` is set on success. */
interface Attempt {
  capture: Capture | null;
  error: unknown;
}

function errorMessage(error: unknown): string {
  if (error instanceof LimitFetchError) return error.message;
  return `limits fetch failed unexpectedly (${error instanceof Error ? error.name : "error"})`;
}

/**
 * The error a reader shows next to an account's data: a Claude account's last failure when
 * it is newer than the data (which is then stale); a Codex account's only when there is no
 * data at all, since rollout snapshots cover a failing app-server (as in cc-usage).
 */
export function shownError(
  root: Pick<Root, "provider">,
  status: AccountStatus | undefined,
  capture: Capture | null,
): string | null {
  if (status === undefined || status.last_error === null) return null;
  if (capture === null) return status.last_error;
  if (root.provider === "codex") return null;
  return (status.last_attempt_at ?? 0) > capture.captured_at * 1000 ? status.last_error : null;
}

export class LimitsService {
  readonly #o: LimitsServiceOptions;
  readonly #timing: LimitsTiming;
  readonly #now: () => number;
  readonly #log: Log;
  readonly #snapshots: CodexSnapshots;
  readonly #inflight = new Map<string, Promise<RefreshOutcome>>();
  /** Set once the app-server proved it can never work in this process. */
  #codexLatch: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #round: Promise<void> | null = null;
  #stopped = false;
  readonly #abort = new AbortController();

  constructor(options: LimitsServiceOptions) {
    this.#o = options;
    this.#timing = { ...DEFAULT_LIMITS_TIMING, ...options.timing };
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#snapshots = options.snapshots ?? NO_SNAPSHOTS;
  }

  /** The latched app-server failure, if any. */
  get codexLatch(): string | null {
    return this.#codexLatch;
  }

  /**
   * Imports cc-usage's limits cache (read-only) when limits.json does not exist yet.
   * Returns how many accounts it brought.
   */
  importIfFirstRun(): number {
    const source = this.#o.ccUsageLimits;
    if (!source || existsSync(this.#o.limitsPath) || !existsSync(source)) return 0;
    let known: readonly KnownAccount[] = [];
    try {
      known = this.#o.knownAccounts?.() ?? [];
    } catch {
      // No store to read cc-usage's labels from: the discovered roots' labels still match.
    }
    const accounts: KnownAccount[] = [...known, ...this.#safeRoots()];
    const providers = importCcUsageLimits(source, accounts);
    const count = Object.keys(providers).length;
    if (count === 0) return 0;
    try {
      saveLimitsCache({ providers, status: {} }, this.#o.limitsPath);
    } catch (error) {
      this.#log(
        "warn",
        `limits: cannot save the imported cc-usage limits (${errorMessage(error)})`,
      );
      return 0;
    }
    this.#log("info", `limits: imported cc-usage's last limits for ${count} accounts`);
    return count;
  }

  /** Starts the schedule: a round now (the caller runs it after its first scan), then as due. */
  start(): void {
    if (this.#stopped || this.#round !== null || this.#timer !== null) return;
    this.importIfFirstRun();
    this.#schedule(0);
  }

  /**
   * Stops the schedule and aborts fetches in flight (requests are cancelled, the refresh
   * run and the app-server killed). Returns once they have settled, within 1.5 s.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_WAIT_MS);
    });
    await Promise.race([Promise.allSettled([this.#round, ...this.#inflight.values()]), late]);
    clearTimeout(timer);
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#round = this.refreshDue()
        .then((next) => {
          this.#round = null;
          this.#schedule(next);
        })
        .catch(() => {
          this.#round = null;
          this.#schedule(this.#timing.intervalMs);
        });
    }, delay);
  }

  #safeRoots(): Root[] {
    try {
      return this.#o.roots().filter((root) => root.enabled);
    } catch (error) {
      this.#log("warn", `limits: cannot list accounts (${errorMessage(error)})`);
      return [];
    }
  }

  /**
   * One scheduled round: fetches every account that is due, folds in Codex snapshots and
   * records events. Resolves with the delay (ms) until the next account is due.
   */
  async refreshDue(): Promise<number> {
    const roots = this.#safeRoots();
    await Promise.all(roots.map((root) => this.#process(root, { kind: "scheduled" })));
    const file = loadLimitsCache(this.#o.limitsPath);
    const now = this.#now();
    let next = now + this.#timing.intervalMs;
    for (const root of roots) {
      const at = file.status[root.identity]?.next_at;
      if (at !== null && at !== undefined && this.#fetchable(root, file.status[root.identity])) {
        next = Math.min(next, at);
      }
    }
    return Math.max(MIN_ROUND_DELAY_MS, next - now);
  }

  /**
   * On demand: fetches each matching account (identity or label; all when null) whose data
   * is older than `maxAgeS`, within the back-off and rate limits.
   */
  async refresh(account: string | null, maxAgeS: number): Promise<RefreshOutcome[]> {
    const roots = this.#safeRoots().filter(
      (root) => account === null || root.identity === account || root.label === account,
    );
    const mode: Mode = { kind: "demand", maxAgeMs: Math.max(0, maxAgeS) * 1000 };
    return Promise.all(roots.map((root) => this.#process(root, mode)));
  }

  /** Whether the schedule fetches this root at all (as opposed to only folding snapshots). */
  #fetchable(root: Root, status: AccountStatus | undefined): boolean {
    if (root.historyOnly) return false;
    if (status?.history_only === "detected") return false;
    return root.provider === "claude" || (this.#codexLatch === null && this.#usesRpc(root));
  }

  #usesRpc(root: Root): boolean {
    if (this.#o.usesRpc) return this.#o.usesRpc(root);
    return root.provider === "codex" && root.source === "auto" && existsSync(root.path);
  }

  /** The mtime of the account's credential file (Claude's, or Codex's auth.json). */
  #credMtime(root: Root): number | null {
    if (this.#o.credentialsMtime) return this.#o.credentialsMtime(root);
    return root.provider === "claude" ? credentialsMtime(root.path) : codexAuthMtime(root.path);
  }

  /** Requests for an account already in flight join it. */
  #process(root: Root, mode: Mode): Promise<RefreshOutcome> {
    const running = this.#inflight.get(root.identity);
    if (running) return running;
    const job = this.#run(root, mode)
      .catch(
        (error): RefreshOutcome => ({
          account: root.identity,
          fetched: false,
          error: errorMessage(error),
        }),
      )
      .finally(() => this.#inflight.delete(root.identity));
    this.#inflight.set(root.identity, job);
    return job;
  }

  /** The account's stored capture, its status, and its rollout snapshot, as they are now. */
  #read(root: Root): {
    prior: Capture | null;
    /** The stored status, as JSON, to tell whether this run changed it. */
    before: string;
    status: AccountStatus;
    current: Capture | null;
  } {
    const file = loadLimitsCache(this.#o.limitsPath);
    const prior = file.providers[root.identity] ?? null;
    const snapshot =
      root.provider === "codex" ? (this.#snapshots().get(root.identity) ?? null) : null;
    let status: AccountStatus = { ...(file.status[root.identity] ?? initialStatus()) };
    const before = JSON.stringify(status);
    if (root.historyOnly) {
      status = { ...status, signed_in: false, history_only: "config", last_error: null };
    } else if (status.history_only === "config") {
      status = initialStatus();
    }
    // cc-usage's order: on a captured_at tie the snapshot beats last-good, which beats the RPC.
    return { prior, before, status, current: freshest([snapshot, prior]) };
  }

  /**
   * Decides, fetches and records one account. A fetch happens only under the account's
   * lease (`.limits-leases/<identity>.lease` beside limits.json), so one process at a time
   * fetches an account; the holder decides again on the file as it is then and records the
   * attempt before fetching, so a process that comes after it within 30 s does not fetch.
   * A process that cannot get the lease serves what limits.json holds.
   */
  async #run(root: Root, mode: Mode): Promise<RefreshOutcome> {
    const id = root.identity;
    let { prior, before, status, current } = this.#read(root);
    let fetched = false;
    if (!root.historyOnly && !this.#stopped && this.#due(root, status, current, mode)) {
      const lease = this.#lease(id);
      if (lease !== null) {
        try {
          ({ prior, before, status, current } = this.#read(root));
          if (this.#due(root, status, current, mode)) {
            fetched = true;
            this.#save(id, null, { ...status, last_attempt_at: this.#now() });
            const attempt = await this.#fetch(root);
            if (this.#stopped && attempt.capture === null) {
              // Cancelled by stop(): not a failure of the account; leave its state alone.
              return { account: id, fetched, error: null };
            }
            status = this.#after(root, status, attempt);
            current = freshest([current, attempt.capture]);
          }
        } finally {
          lease.release();
        }
      }
    }

    const newCapture = current !== null && JSON.stringify(current) !== JSON.stringify(prior);
    const changed = newCapture || JSON.stringify(status) !== before;
    if (changed) {
      this.#save(id, newCapture ? current : null, status);
      this.#o.onChanged?.([id]);
    }
    if (current !== null && (changed || mode.kind === "scheduled")) this.#record(root, current);
    return { account: id, fetched, error: shownError(root, status, current) };
  }

  /** The account's fetch lease, or null while another process holds it. */
  #lease(id: string): Lease | null {
    try {
      return tryLease(leasePath(this.#o.limitsPath, id), this.#timing.leaseTtlMs, this.#now);
    } catch (error) {
      // No writable config dir: limits.json cannot be saved either; fetch unguarded.
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      this.#log("warn", `limits: cannot take the fetch lease (${code})`);
      return { path: "", release() {} };
    }
  }

  #due(root: Root, status: AccountStatus, current: Capture | null, mode: Mode): boolean {
    const now = this.#now();
    if (root.provider === "codex" && (this.#codexLatch !== null || !this.#usesRpc(root))) {
      return false;
    }
    if (status.history_only === "detected") {
      const recheck =
        now - (status.checked_at ?? 0) >= this.#timing.recheckMs ||
        this.#credMtime(root) !== status.cred_mtime;
      if (!recheck) return false;
      // A re-check that failed for another reason backs off like any fetch.
      if (status.errors > 0 && status.next_at !== null && now < status.next_at) return false;
    } else if (mode.kind === "scheduled") {
      if (status.next_at !== null && now < status.next_at) return false;
    } else {
      const age = current === null ? Number.POSITIVE_INFINITY : now - current.captured_at * 1000;
      if (age <= mode.maxAgeMs) return false;
      if (status.errors > 0 && status.next_at !== null && now < status.next_at) return false;
    }
    if (root.provider === "claude" && status.last_attempt_at !== null) {
      if (now - status.last_attempt_at < this.#timing.claudeMinGapMs) return false;
    }
    return true;
  }

  async #fetch(root: Root): Promise<Attempt> {
    const signal = this.#abort.signal;
    try {
      const capture =
        root.provider === "claude"
          ? await (
              this.#o.fetchClaude ??
              ((r: Root, s: AbortSignal) => fetchClaudeLimits(r, { signal: s }))
            )(root, signal)
          : await (
              this.#o.fetchCodex ??
              ((r: Root, s: AbortSignal) => fetchCodexLimits({ codexHome: r.path, signal: s }))
            )(root, signal);
      return { capture, error: null };
    } catch (error) {
      return { capture: null, error };
    }
  }

  /** The account's status after an attempt. */
  #after(root: Root, status: AccountStatus, attempt: Attempt): AccountStatus {
    const now = this.#now();
    if (attempt.capture !== null) {
      return { ...initialStatus(), last_attempt_at: now, next_at: now + this.#timing.intervalMs };
    }
    const message = errorMessage(attempt.error);
    if (attempt.error instanceof SignedOut) {
      if (status.history_only !== "detected") {
        this.#log("info", `limits: ${root.label} is not signed in here (${message}); history only`);
      }
      return {
        ...status,
        signed_in: false,
        history_only: "detected",
        checked_at: now,
        cred_mtime: this.#credMtime(root),
        errors: 0,
        last_error: message,
        last_attempt_at: now,
        next_at: now + this.#timing.recheckMs,
      };
    }
    if (attempt.error instanceof CodexAppServerUnavailable) {
      this.#codexLatch = message;
      this.#log("warn", `limits: ${root.label}: ${message}; not asking the app-server again`);
      return { ...status, errors: status.errors + 1, last_error: message, last_attempt_at: now };
    }
    const errors = status.errors + 1;
    const backoff = Math.min(
      this.#timing.backoffMinMs * 2 ** (errors - 1),
      this.#timing.backoffMaxMs,
    );
    this.#log("warn", `limits: ${root.label}: ${message}`);
    return {
      ...status,
      signed_in: status.history_only === "detected" ? status.signed_in : true,
      errors,
      last_error: message,
      last_attempt_at: now,
      next_at: now + backoff,
    };
  }

  #save(id: string, capture: Capture | null, status: AccountStatus): LimitsFile | null {
    const update: CacheUpdate = capture === null ? { status } : { capture, status };
    try {
      return updateLimitsCache(this.#o.limitsPath, new Map([[id, update]]));
    } catch (error) {
      // limits.json keeps what it had (a busy lock, an unwritable dir): this round's
      // update is shown from memory and saved on the next one.
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      this.#log("warn", `limits: cannot save limits.json (${code}); serving the cached limits`);
      return null;
    }
  }

  #record(root: Root, capture: Capture): void {
    const record = this.#o.recordEvents;
    if (!record) return;
    try {
      record(root, capture);
    } catch (error) {
      this.#log("warn", `limits: cannot record limit events (${(error as Error).message})`);
    }
  }
}

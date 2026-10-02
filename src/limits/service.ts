import { existsSync } from "node:fs";
import type { Log } from "../ingest/pass.ts";
import type { Root } from "../sources/roots.ts";
import {
  type AccountStatus,
  type CacheUpdate,
  editLimitsCache,
  importCcUsageLimits,
  initialStatus,
  type KnownAccount,
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
import {
  compareCaptures,
  detectPairs,
  type ManualLinks,
  mergeGroups,
  NO_LINKS,
  newInstance,
  pairKey,
  provenDifferent,
  resolveGroups,
} from "./groups.ts";
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
 * - **Roots on one account** (src/limits/groups.ts) are fetched as one: through one member
 *   per round, the first signed in (fewest recent errors first), and through the next
 *   signed-in member when that fetch fails for a reason of its own or a server error. A
 *   429, the network or a bad response backs off the whole group instead (`failover`). The
 *   lease and the in-flight request are the group's. Each fetch's capture is kept under the
 *   member it came from; readers take the group's freshest, and limit events are recorded
 *   once for the group.
 * - **Keeping auto-detection fresh:** right after a group's fetch, under its lease, each
 *   other member is fetched too every 30 minutes, every one at once when a member's
 *   credential file changed (stat only), and a signed-out one when its re-check is due.
 *   Right after a root's fetch, a root on its own whose resets agree with it and whose
 *   capture is over 60 s old is fetched too. After every round and on-demand refresh,
 *   auto-detection compares the roots' captures and records the groups in limits.json.
 * Nothing here throws to the caller.
 */

export interface LimitsTiming {
  intervalMs: number;
  claudeMinGapMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  recheckMs: number;
  /** How often each other member of a group is fetched to check it is still on the account. */
  verifyMs: number;
  /** A fetch lease older than this belongs to a crashed process (a fetch takes at most ~1 min). */
  leaseTtlMs: number;
}

export const DEFAULT_LIMITS_TIMING: LimitsTiming = {
  intervalMs: 5 * 60_000,
  claudeMinGapMs: 30_000,
  backoffMinMs: 30_000,
  backoffMaxMs: 30 * 60_000,
  recheckMs: 24 * 3_600_000,
  verifyMs: 30 * 60_000,
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
  /**
   * Stores the events a capture of `root` implies (the ingest Worker's store); absent
   * elsewhere. `shared`: the other roots on its account, whose events are the same ones.
   */
  recordEvents?: ((root: Root, capture: Capture, shared: readonly Root[]) => void) | null;
  /** Called with the identities whose entry in limits.json changed. */
  onChanged?: (accounts: string[]) => void;
  /** Fetchers get the service's signal, aborted by `stop()`. */
  fetchClaude?: (root: Root, signal: AbortSignal) => Promise<Capture>;
  fetchCodex?: (root: Root, signal: AbortSignal) => Promise<Capture>;
  credentialsMtime?: (root: Root) => number | null;
  /** Manual account links (config `same_account`, `separate_accounts`), read every round. */
  links?: () => ManualLinks;
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
  /** A provider was asked (a network request or the app-server), for it or its group. */
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

/** Roots fetched as one: a group of roots on one account, or a root on its own. */
interface Unit {
  /** The group's id, or the root's identity: the key of its lease and its request. */
  key: string;
  /** In discovery order. */
  members: Root[];
}

/** A round's view of the roots: the enabled ones, as fetch units, and the pairs kept apart. */
interface Round {
  roots: Root[];
  units: Unit[];
  /** `pairKey`s of the config's `separate_accounts`. */
  separate: Set<string>;
}

/** One root as `#read` found it in limits.json. */
interface Read {
  prior: Capture | null;
  /** The stored status, as JSON, to tell whether this run changed it. */
  before: string;
  status: AccountStatus;
  current: Capture | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof LimitFetchError) return error.message;
  return `limits fetch failed unexpectedly (${error instanceof Error ? error.name : "error"})`;
}

/**
 * Whether another root of the same account may be asked after a failure (an error, or a
 * stored `last_error`): "next" for a failure of the root's own (signed out, its
 * credentials or their refresh, a 401 or 403) and for a server error (5xx); "hold" for one
 * that asking again would only repeat: a 429 (the provider asks the account to slow down),
 * the network, a bad response, a missing app-server. A "hold" backs off the whole group.
 */
export function failover(failure: unknown): "next" | "hold" {
  if (failure instanceof SignedOut) return "next";
  if (failure instanceof CodexAppServerUnavailable) return "hold";
  const message = typeof failure === "string" ? failure : errorMessage(failure);
  return /\bHTTP (40[13]|5\d\d)\b|credential|sign-in|signed in|OAuth/i.test(message)
    ? "next"
    : "hold";
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

/**
 * `shownError` for roots on one account, against the group's capture: the error of the
 * member asked last (the first member's when none was asked yet).
 */
export function groupError(
  members: readonly Root[],
  status: (identity: string) => AccountStatus | undefined,
  capture: Capture | null,
): string | null {
  let last = members[0];
  let at = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    const t = status(member.identity)?.last_attempt_at ?? null;
    if (t !== null && t > at) {
      at = t;
      last = member;
    }
  }
  return last === undefined ? null : shownError(last, status(last.identity), capture);
}

export class LimitsService {
  readonly #o: LimitsServiceOptions;
  readonly #timing: LimitsTiming;
  readonly #now: () => number;
  readonly #log: Log;
  readonly #snapshots: CodexSnapshots;
  readonly #inflight = new Map<string, Promise<RefreshOutcome[]>>();
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
   * One scheduled round: fetches every account (or group of roots on one account) that is
   * due, with the partner and verification fetches that keep auto-detection fresh, folds
   * in Codex snapshots, records events and runs auto-detection. Resolves with the delay
   * (ms) until the next one is due.
   */
  async refreshDue(): Promise<number> {
    const round = this.#survey();
    await Promise.all(round.units.map((unit) => this.#process(unit, { kind: "scheduled" }, round)));
    this.#detect(round.roots);
    const file = loadLimitsCache(this.#o.limitsPath);
    const now = this.#now();
    let next = now + this.#timing.intervalMs;
    for (const unit of round.units) {
      const at = this.#nextAt(unit, (id) => file.status[id]);
      if (at !== null) next = Math.min(next, at);
    }
    return Math.max(MIN_ROUND_DELAY_MS, next - now);
  }

  /**
   * On demand: fetches each matching account (identity or label; all when null) whose data
   * is older than `maxAgeS`, within the back-off and rate limits. A root on an account with
   * others is fetched as their group, and its data is the group's.
   */
  async refresh(account: string | null, maxAgeS: number): Promise<RefreshOutcome[]> {
    const round = this.#survey();
    const wanted = round.roots.filter(
      (root) => account === null || root.identity === account || root.label === account,
    );
    const ids = new Set(wanted.map((root) => root.identity));
    const units = round.units.filter((unit) => unit.members.some((m) => ids.has(m.identity)));
    const mode: Mode = { kind: "demand", maxAgeMs: Math.max(0, maxAgeS) * 1000 };
    const outcomes = (
      await Promise.all(units.map((unit) => this.#process(unit, mode, round)))
    ).flat();
    if (units.length > 0) this.#detect(round.roots);
    const byId = new Map(outcomes.map((o) => [o.account, o]));
    return wanted.flatMap((root) => byId.get(root.identity) ?? []);
  }

  /** The roots, their links, and the roots as fetch units: each group, and every other root. */
  #survey(): Round {
    const roots = this.#safeRoots();
    const links = this.#links();
    const file = loadLimitsCache(this.#o.limitsPath);
    const groups = resolveGroups(roots, links, file.pairs, file.groups);
    const units: Unit[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      const group = groups.get(root.identity);
      if (group === undefined) units.push({ key: root.identity, members: [root] });
      else if (!seen.has(group.id)) {
        seen.add(group.id);
        units.push({ key: group.id, members: [...group.members] });
      }
    }
    const separate = new Set(
      links.separate
        .filter((p) => p.length === 2)
        .map((p) => pairKey(p[0] as string, p[1] as string)),
    );
    return { roots, units, separate };
  }

  #links(): ManualLinks {
    try {
      return this.#o.links?.() ?? NO_LINKS;
    } catch (error) {
      this.#log("warn", `limits: cannot read the account links (${errorMessage(error)})`);
      return NO_LINKS;
    }
  }

  /** Whether the schedule fetches this root at all (as opposed to only folding snapshots). */
  #fetchable(root: Root, status: AccountStatus | undefined): boolean {
    if (root.historyOnly) return false;
    if (status?.history_only === "detected") return false;
    return root.provider === "claude" || (this.#codexLatch === null && this.#usesRpc(root));
  }

  /**
   * The unit's members a fetch may go through, in the order to try them: the fetchable
   * ones, fewest consecutive errors first (a member that just failed goes after the one
   * that took over from it), then discovery order.
   */
  #signedIn(unit: Unit, status: (identity: string) => AccountStatus | undefined): Root[] {
    const errors = (root: Root) => status(root.identity)?.errors ?? 0;
    return unit.members
      .filter((root) => this.#fetchable(root, status(root.identity)))
      .sort((a, b) => errors(a) - errors(b));
  }

  /**
   * Until when the whole unit waits: the member asked last failed in a way that asking
   * another member would only repeat (a 429, the network, a bad response), and its
   * back-off still runs. Null when nothing holds the unit back.
   */
  #heldUntil(unit: Unit, status: (identity: string) => AccountStatus | undefined): number | null {
    let last: AccountStatus | undefined;
    for (const root of unit.members) {
      const s = status(root.identity);
      const at = s?.last_attempt_at ?? null;
      if (at !== null && at > (last?.last_attempt_at ?? Number.NEGATIVE_INFINITY)) last = s;
    }
    if (last === undefined || last.errors === 0 || last.last_error === null) return null;
    if (failover(last.last_error) === "next" || last.next_at === null) return null;
    return last.next_at > this.#now() ? last.next_at : null;
  }

  /** When the unit's next scheduled fetch is due; null when no member is fetched. */
  #nextAt(unit: Unit, status: (identity: string) => AccountStatus | undefined): number | null {
    const first = this.#signedIn(unit, status)[0];
    if (first === undefined) return null;
    const at = status(first.identity)?.next_at ?? null;
    const held = this.#heldUntil(unit, status);
    return held === null ? at : Math.max(at ?? held, held);
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

  /**
   * Whether a member's credential file changed since its own last fetch (stat only): it
   * may now be signed in to another account. Tokenhud's own refresh run rewrites the file
   * during a fetch, so the mtime is recorded after each fetch.
   */
  #credentialsChanged(root: Root, status: AccountStatus): boolean {
    if (root.historyOnly || status.last_attempt_at === null) return false;
    return this.#credMtime(root) !== status.cred_mtime;
  }

  /** Requests for a unit already in flight join it. */
  #process(unit: Unit, mode: Mode, round: Round): Promise<RefreshOutcome[]> {
    const running = this.#inflight.get(unit.key);
    if (running) return running;
    const job = this.#run(unit, mode, round)
      .catch((error): RefreshOutcome[] =>
        unit.members.map((root) => ({
          account: root.identity,
          fetched: false,
          error: errorMessage(error),
        })),
      )
      .finally(() => this.#inflight.delete(unit.key));
    this.#inflight.set(unit.key, job);
    return job;
  }

  /** The account's stored capture, its status, and its rollout snapshot, as they are now. */
  #read(root: Root): Read {
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

  #readUnit(unit: Unit): Map<string, Read> {
    return new Map(unit.members.map((root) => [root.identity, this.#read(root)]));
  }

  /**
   * The members to ask, in order, when the unit is due; none when it isn't. The first
   * signed-in member decides whether the unit is due, against the unit's freshest capture.
   * A group is due at once, too, when a member's credential file changed and that member
   * can be asked now (`#askable`): its one immediate verification. The others stand in
   * when the first fails for a reason of its own, unless their back-off or Claude's 30 s
   * gap holds them back. A unit with no member signed in re-checks the first one due for
   * it (daily, or when its credential file changes).
   */
  #plan(unit: Unit, reads: ReadonlyMap<string, Read>, mode: Mode): Root[] {
    const read = (root: Root) => reads.get(root.identity) as Read;
    const status = (id: string) => reads.get(id)?.status;
    const current = freshest(unit.members.map((root) => read(root).current));
    const [first, ...others] = this.#signedIn(unit, status);
    if (first === undefined) {
      const recheck = unit.members.find(
        (root) => !root.historyOnly && this.#due(root, read(root).status, current, mode),
      );
      return recheck === undefined ? [] : [recheck];
    }
    if (this.#heldUntil(unit, status) !== null) return [];
    const changed =
      unit.members.length > 1 &&
      unit.members.some(
        (root) =>
          this.#credentialsChanged(root, read(root).status) &&
          this.#askable(root, read(root).status),
      );
    const due =
      (changed && this.#mayStandIn(first, read(first).status)) ||
      this.#due(first, read(first).status, current, mode);
    if (!due) return [];
    return [first, ...others.filter((root) => this.#mayStandIn(root, read(root).status))];
  }

  /**
   * Whether a member may be asked now, out of schedule: signed in, outside its back-off
   * and Claude's 30 s gap; or not signed in here, with its re-check due.
   */
  #askable(root: Root, status: AccountStatus): boolean {
    if (root.historyOnly) return false;
    if (status.history_only === "detected") {
      return this.#due(root, status, null, { kind: "scheduled" });
    }
    return this.#fetchable(root, status) && this.#mayStandIn(root, status);
  }

  /** Whether a member may be asked now, out of schedule: its back-off and Claude's 30 s gap. */
  #mayStandIn(root: Root, status: AccountStatus): boolean {
    const now = this.#now();
    if (status.errors > 0 && status.next_at !== null && now < status.next_at) return false;
    return !(
      root.provider === "claude" &&
      status.last_attempt_at !== null &&
      now - status.last_attempt_at < this.#timing.claudeMinGapMs
    );
  }

  /**
   * The group's other members to fetch right after `by` fetched it, under the group's
   * lease, so that each pair compared is seconds apart, each when it can be asked now
   * (`#askable`): every 30 minutes; at once when its credential file changed (or `by`'s,
   * which puts every pair in question); next round after an inconclusive pair; and, when
   * not signed in here, when its re-check is due (daily, or on a credential change).
   * `changed`: the members whose credential file changed before this run.
   */
  #verifiers(
    unit: Unit,
    by: Root,
    reads: ReadonlyMap<string, Read>,
    changed: ReadonlySet<string>,
  ): Root[] {
    const now = this.#now();
    const pairs = loadLimitsCache(this.#o.limitsPath).pairs ?? {};
    return unit.members.filter((root) => {
      const { status } = reads.get(root.identity) as Read;
      if (root === by || !this.#askable(root, status)) return false;
      if (status.history_only === "detected") return true;
      if (changed.has(by.identity) || changed.has(root.identity)) return true;
      if ((pairs[pairKey(by.identity, root.identity)]?.inconclusive ?? 0) > 0) return true;
      return now - (status.last_attempt_at ?? Number.NEGATIVE_INFINITY) >= this.#timing.verifyMs;
    });
  }

  /** Asks `root` once, records the attempt first, and folds the outcome into `read`. */
  async #ask(root: Root, read: Read): Promise<Attempt> {
    this.#save(root.identity, null, { ...read.status, last_attempt_at: this.#now() });
    const attempt = await this.#fetch(root);
    if (this.#stopped && attempt.capture === null) return attempt;
    read.status = this.#after(root, read.status, attempt);
    read.current = freshest([read.current, attempt.capture]);
    return attempt;
  }

  /**
   * Decides, fetches and records one unit. A fetch happens only under the unit's lease
   * (`.limits-leases/<key>.lease` beside limits.json), so one process at a time fetches an
   * account; the holder decides again on the file as it is then and records the attempt
   * before fetching, so a process that comes after it within 30 s does not fetch. A
   * process that cannot get the lease serves what limits.json holds. A capture fetched
   * here is followed, back to back, by the fetches that let auto-detection compare it:
   * the group's members due for verification, and unlinked partners (`#partners`).
   */
  async #run(unit: Unit, mode: Mode, round: Round): Promise<RefreshOutcome[]> {
    let reads = this.#readUnit(unit);
    let fetched = false;
    let by: { root: Root; capture: Capture; changed: boolean } | null = null;
    if (!this.#stopped && this.#plan(unit, reads, mode).length > 0) {
      const lease = this.#lease(unit.key);
      if (lease !== null) {
        try {
          reads = this.#readUnit(unit);
          const changed = new Set(
            unit.members
              .filter((root) =>
                this.#credentialsChanged(root, (reads.get(root.identity) as Read).status),
              )
              .map((root) => root.identity),
          );
          for (const root of this.#plan(unit, reads, mode)) {
            fetched = true;
            const attempt = await this.#ask(root, reads.get(root.identity) as Read);
            if (this.#stopped && attempt.capture === null) {
              // Cancelled by stop(): not a failure of the account; leave its state alone.
              return unit.members.map((m) => ({ account: m.identity, fetched, error: null }));
            }
            if (attempt.capture !== null) {
              by = { root, capture: attempt.capture, changed: changed.has(root.identity) };
              break;
            }
            // Another member would fail the same way (a 429, the network): stop here.
            if (failover(attempt.error) === "hold") break;
          }
          if (by !== null) {
            for (const root of this.#verifiers(unit, by.root, reads, changed)) {
              if (this.#stopped) break;
              await this.#ask(root, reads.get(root.identity) as Read);
            }
          }
        } finally {
          lease.release();
        }
      }
    }

    const updates = new Map<string, CacheUpdate>();
    let newData = false;
    for (const root of unit.members) {
      const { prior, before, status, current } = reads.get(root.identity) as Read;
      const newCapture = current !== null && JSON.stringify(current) !== JSON.stringify(prior);
      if (newCapture || JSON.stringify(status) !== before) {
        newData ||= newCapture;
        updates.set(root.identity, newCapture ? { capture: current, status } : { status });
      }
    }
    if (updates.size > 0) {
      this.#saveAll(updates);
      this.#o.onChanged?.([...updates.keys()]);
    }
    const currents = unit.members.map((root) => (reads.get(root.identity) as Read).current);
    const capture = freshest(currents);
    if (capture !== null && (newData || mode.kind === "scheduled")) {
      // One record per window instance for the whole account, from its freshest capture.
      const owner = unit.members[currents.indexOf(capture)] as Root;
      this.#record(
        owner,
        capture,
        unit.members.filter((root) => root !== owner),
      );
    }
    if (by !== null && !this.#stopped) await this.#partners(by, unit, round);
    const error = groupError(unit.members, (id) => reads.get(id)?.status, capture);
    return unit.members.map((root) => ({ account: root.identity, fetched, error }));
  }

  /**
   * Fetches, right after `by.root` gave `by.capture`, each root that may be on its account
   * and whose own capture is too far from it to compare utilisation: a root of the same
   * provider on its own (in no group), not kept apart in config, signed in, whose last
   * capture's resets agree with `by.capture`. A root proven different (two disagreeing
   * pairs) is left alone until either root shows a new window instance or either's
   * credential file changed (`by.changed`: before its fetch). Each is fetched under its own
   * lease, within its back-off and Claude's 30 s gap; a successful fetch also moves its
   * schedule to this one's, so the next round's pair is seconds apart without help.
   */
  async #partners(
    by: { root: Root; capture: Capture; changed: boolean },
    unit: Unit,
    round: Round,
  ): Promise<void> {
    const { capture } = by;
    const pairs = loadLimitsCache(this.#o.limitsPath).pairs ?? {};
    for (const other of round.units) {
      const root = other.members[0] as Root;
      if (other.members.length !== 1 || other.key === unit.key) continue;
      const key = pairKey(by.root.identity, root.identity);
      if (root.provider !== by.root.provider || round.separate.has(key)) continue;
      const read = this.#read(root);
      if (read.current === null || !this.#fetchable(root, read.status)) continue;
      const c = compareCaptures(capture, read.current);
      if (c.shared === 0 || !c.resetsAgree || c.close || !this.#mayStandIn(root, read.status)) {
        continue;
      }
      const state = pairs[key];
      if (provenDifferent(state)) {
        const [mine, theirs] = by.root.identity < root.identity ? [0, 1] : [1, 0];
        const fresh =
          newInstance(state?.resets[mine] ?? {}, capture) ||
          newInstance(state?.resets[theirs] ?? {}, read.current) ||
          by.changed ||
          this.#credentialsChanged(root, read.status);
        if (!fresh) continue;
      }
      const lease = this.#lease(other.key);
      if (lease === null) continue;
      try {
        const again = this.#read(root);
        if (this.#stopped || !this.#mayStandIn(root, again.status)) continue;
        const attempt = await this.#ask(root, again);
        if (this.#stopped && attempt.capture === null) return;
        const newCapture =
          again.current !== null && JSON.stringify(again.current) !== JSON.stringify(again.prior);
        this.#saveAll(
          new Map([
            [
              root.identity,
              newCapture && again.current !== null
                ? { capture: again.current, status: again.status }
                : { status: again.status },
            ],
          ]),
        );
        this.#o.onChanged?.([root.identity]);
        if (again.current !== null) this.#record(root, again.current, []);
      } finally {
        lease.release();
      }
    }
  }

  /**
   * Auto-detection over the roots' current captures (their rollout snapshots and
   * limits.json), then the groups they and the manual links make, both saved in
   * limits.json under its lock, when they changed. `groups` is merged per root: this
   * process rewrites only the entries of the roots it evaluated.
   */
  #detect(roots: readonly Root[]): void {
    const snapshots = roots.some((root) => root.provider === "codex")
      ? this.#snapshots()
      : new Map<string, Capture>();
    const links = this.#links();
    const now = this.#now();
    let changed: string[] = [];
    try {
      editLimitsCache(this.#o.limitsPath, (file) => {
        const captures = new Map(
          roots.map((root) => [
            root.identity,
            freshest([snapshots.get(root.identity), file.providers[root.identity]]),
          ]),
        );
        const pairs = detectPairs(roots, captures, file.pairs ?? {}, now);
        const before = file.groups ?? {};
        const groups = mergeGroups(roots, resolveGroups(roots, links, pairs, before), before, now);
        changed = roots
          .map((root) => root.identity)
          .filter((id) => JSON.stringify(groups[id]) !== JSON.stringify(before[id]));
        if (JSON.stringify(pairs) === JSON.stringify(file.pairs ?? {}) && changed.length === 0) {
          return false;
        }
        file.pairs = pairs;
        file.groups = groups;
        return true;
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      this.#log("warn", `limits: cannot save which accounts are shared (${code})`);
      return;
    }
    if (changed.length > 0) this.#o.onChanged?.(changed);
  }

  /** The unit's fetch lease, or null while another process holds it. */
  #lease(key: string): Lease | null {
    try {
      return tryLease(leasePath(this.#o.limitsPath, key), this.#timing.leaseTtlMs, this.#now);
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
    // The credential file as this fetch left it: a change after it is someone else's.
    const credMtime = this.#credMtime(root);
    if (attempt.capture !== null) {
      return {
        ...initialStatus(),
        cred_mtime: credMtime,
        last_attempt_at: now,
        next_at: now + this.#timing.intervalMs,
      };
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
        cred_mtime: credMtime,
        errors: 0,
        last_error: message,
        last_attempt_at: now,
        next_at: now + this.#timing.recheckMs,
      };
    }
    if (attempt.error instanceof CodexAppServerUnavailable) {
      this.#codexLatch = message;
      this.#log("warn", `limits: ${root.label}: ${message}; not asking the app-server again`);
      return {
        ...status,
        cred_mtime: credMtime,
        errors: status.errors + 1,
        last_error: message,
        last_attempt_at: now,
      };
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
      cred_mtime: credMtime,
      errors,
      last_error: message,
      last_attempt_at: now,
      next_at: now + backoff,
    };
  }

  #save(id: string, capture: Capture | null, status: AccountStatus): void {
    this.#saveAll(new Map([[id, capture === null ? { status } : { capture, status }]]));
  }

  #saveAll(updates: ReadonlyMap<string, CacheUpdate>): void {
    try {
      updateLimitsCache(this.#o.limitsPath, updates);
    } catch (error) {
      // limits.json keeps what it had (a busy lock, an unwritable dir): this round's
      // update is shown from memory and saved on the next one.
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      this.#log("warn", `limits: cannot save limits.json (${code}); serving the cached limits`);
    }
  }

  #record(root: Root, capture: Capture, shared: readonly Root[]): void {
    const record = this.#o.recordEvents;
    if (!record) return;
    try {
      record(root, capture, shared);
    } catch (error) {
      this.#log("warn", `limits: cannot record limit events (${(error as Error).message})`);
    }
  }
}

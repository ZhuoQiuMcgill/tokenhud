import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import {
  type DiscoverOptions,
  discoverClaudeRoots,
  discoverCodexRoots,
  isWsl,
  onWindowsDrive,
  type Root,
} from "../sources/roots.ts";
import {
  backup,
  backupDue,
  mergedAny,
  openDurableStore,
  processPending,
  type RecoveryOptions,
  type RecoveryReport,
  replaceCorruptStore,
} from "../store/durability.ts";
import { StoreCorrupt, StoreError } from "../store/errors.ts";
import { type ImportOutcome, ImportSourceError, importCcUsage } from "../store/import-cc-usage.ts";
import type { Store } from "../store/store.ts";
import { CursorCache } from "./cursors.ts";
import { listDir, statFiles, walk } from "./files.ts";
import {
  type ChangedEvent,
  codexSessionIndex,
  type Log,
  type PassFile,
  type PassReport,
  runPass,
} from "./pass.ts";
import { defaultPoolSize } from "./pool.ts";

/**
 * Owns ingest for one process: discovers roots, imports cc-usage's history on the first
 * run, runs passes and keeps the store current as transcripts grow.
 *
 * Live updates differ by where a root lives:
 * - **Linux roots:** a recursive `fs.watch` per root marks files dirty; a short debounce
 *   batches a burst of appends into one pass.
 * - **Windows roots under WSL (`/mnt/<drive>/...`):** `fs.watch` sees nothing across 9P,
 *   so they are polled. A directory's mtime moves when an entry is added but not when a
 *   file is appended to, so each tick stats the root's directories plus its *hot* files
 *   (modified in the last 2 h): every 5 s, or every 2 s while a file is growing.
 * - **Every root:** a full sweep every 60 s re-discovers roots and stats every transcript,
 *   which catches whatever a watch missed and old sessions that are resumed.
 * Passes run one at a time. An error in one is logged and the next runs as usual.
 *
 * A full pass also refreshes each Codex session's rollouts (to find a child rollout's
 * parent), and it re-keys the Codex accounts the store marks as pending (scheme 1 -> 2).
 *
 * The engine keeps the store durable (src/store/durability.ts), always here in the ingest
 * worker and never on the UI thread:
 * - **An unreadable store** is moved aside, never deleted, whether found on open or in a
 *   pass; a fresh store takes its place and the moved file and the backups are queued.
 * - **The recovery queue** is worked before the first pass and retried on every full pass
 *   while anything is left (a full disk, say).
 * - **A store the cursors were not written for** (recovered, or replaced by another
 *   process) has every transcript read again, so it is backfilled from what is on disk.
 * - **The daily backup** follows a full pass once a day, and at once after a completed
 *   recovery or a key-scheme migration.
 */

export interface LiveTiming {
  sweepMs: number;
  pollMs: number;
  fastPollMs: number;
  hotMs: number;
  debounceMs: number;
}

export const DEFAULT_TIMING: LiveTiming = {
  sweepMs: 60_000,
  pollMs: 5_000,
  fastPollMs: 2_000,
  hotMs: 2 * 60 * 60 * 1000,
  debounceMs: 30,
};

export interface EngineOptions {
  storePath: string;
  cachePath: string;
  config: Config;
  discover: DiscoverOptions;
  /** cc-usage's ledger, imported (read-only) before the first pass if the store has no cc-usage import; null never imports. */
  importLedger: string | null;
  poolSize?: number;
  log?: Log;
  onChanged?: (event: ChangedEvent) => void;
  /** Every pass's report (watch mode prints them with --stats). */
  onPass?: (report: PassReport) => void;
  timing?: Partial<LiveTiming>;
  /** Poll every root, as if all were Windows roots (tests). */
  pollAll?: boolean;
  /** How recovery copies its sources (tests simulate a full disk). */
  recovery?: RecoveryOptions;
}

/** Transcript directories of a root: Claude's `projects`; Codex's active and archived sessions. */
export function transcriptDirs(root: Root): string[] {
  return root.provider === "codex"
    ? [root.projects, join(root.path, "archived_sessions")]
    : [root.projects];
}

/** Margin for coarse directory mtimes when deciding what changed during a walk. */
const MTIME_SLACK_MS = 2000;

interface Hot {
  root: Root;
  size: number;
  mtimeMs: number;
}

export class IngestEngine {
  readonly store: Store;
  readonly cursors: CursorCache;
  readonly #options: EngineOptions;
  readonly #timing: LiveTiming;
  readonly #log: Log;
  readonly #wsl: boolean;
  #roots: Root[] = [];
  #chain: Promise<void> = Promise.resolve();
  #live = false;
  #stopped = false;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #dirty = new Map<string, Root>();
  readonly #rescan = new Set<Root>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Polled roots' directories and their last mtimes. */
  readonly #pollDirs = new Map<string, { root: Root; mtimeMs: number }>();
  readonly #hot = new Map<string, Hot>();
  /** Codex session id -> its rollouts, as of the last full pass. */
  #codexSessions: Record<string, string[]> = {};
  /** A backup is owed now, not just daily: after a key-scheme migration or a completed recovery. */
  #backupNow: boolean;
  /** The last backup failure logged, so a failing backup warns once, not every sweep. */
  #backupError: string | null = null;

  private constructor(options: EngineOptions, store: Store, cursors: CursorCache) {
    this.#options = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#log = options.log ?? (() => {});
    this.#wsl = isWsl(options.discover.platform ?? process.platform);
    this.store = store;
    this.cursors = cursors;
    this.#backupNow = store.keySchemeMigrated;
    if (cursors.note === "rebuilt")
      this.#log("warn", "the read-position cache was damaged and has been rebuilt");
    if (cursors.note === "in-memory") {
      this.#log(
        "warn",
        "the read-position cache cannot be used; every pass re-reads all transcripts",
      );
    }
  }

  /**
   * Opens the store, checking it whole, and the cursor cache. An unreadable store is moved
   * aside and a fresh one opened (call `recover()` next). Throws `StoreError` when no store
   * can be used.
   */
  static open(options: EngineOptions): IngestEngine {
    const { store, movedTo } = openDurableStore(options.storePath, { verify: true });
    try {
      const engine = new IngestEngine(options, store, CursorCache.open(options.cachePath));
      if (movedTo !== null) {
        engine.#log("warn", `the usage store was unreadable and was moved to ${movedTo}`);
      }
      return engine;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  /** Every discovered root, enabled or not, Claude first. */
  discover(): Root[] {
    const { config, discover } = this.#options;
    const claude = discoverClaudeRoots(config, discover);
    return [...claude, ...discoverCodexRoots(config, discover, claude)];
  }

  /** The roots the last full pass read: enabled, and of a provider tokenhud can parse. */
  get roots(): readonly Root[] {
    return this.#roots;
  }

  #polled(root: Root): boolean {
    return this.#options.pollAll === true || (this.#wsl && onWindowsDrive(root));
  }

  // ── durability ─────────────────────────────────────────────────────────────────

  /**
   * Merges what the store's recovery queue can take now (durability.ts) and logs what
   * happened. Call it once after `open`, before `importIfFirstRun`, so recovered import
   * records count; full passes retry it while anything is left. Never throws.
   */
  recover(): RecoveryReport | null {
    try {
      return this.#recover();
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      this.#log("error", `recovering the usage store failed: ${error.message}`);
      return null;
    }
  }

  #recover(): RecoveryReport | null {
    const report = processPending(this.store, this.#options.recovery);
    if (report === null) return null;
    this.#log("warn", `usage store recovery: ${report.summary}`);
    if (report.stillPending.length === 0) this.#backupNow = true;
    if (mergedAny(report)) {
      const accounts = [...this.store.accounts().values()].map((a) => a.identity);
      this.#options.onChanged?.({
        type: "changed",
        accounts,
        fromTs: 0,
        toTs: Number.MAX_SAFE_INTEGER,
      });
    }
    return report;
  }

  /**
   * Follows the store's path to a file another process put there, and drops the cursors
   * when the store is not the one they were written for. True when they were dropped: the
   * caller must read every transcript again. A store that cannot be reached now is left
   * for the pass to meet and report; only an unreadable one throws (`StoreCorrupt`).
   */
  #checkStore(): boolean {
    let storeId: string | null;
    try {
      this.store.ensureCurrent();
      storeId = this.store.storeId;
    } catch (error) {
      if (!(error instanceof StoreError) || error instanceof StoreCorrupt) throw error;
      return false;
    }
    if (!this.cursors.bind(storeId)) return false;
    this.#log(
      "info",
      "the usage store is new to the read positions; reading every transcript again",
    );
    return true;
  }

  /** Retries the recovery queue while anything is left in it (a full disk, say). */
  #recoverIfPending(): void {
    let pending = false;
    try {
      pending = this.store.pendingRecovery().length > 0;
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
    }
    if (pending) this.recover();
  }

  /** The store proved unreadable: moved aside, replaced by a fresh one, recovery queued and run. */
  #replaceCorrupt(): void {
    const moved = replaceCorruptStore(this.store);
    this.#log(
      "warn",
      moved === null
        ? "the usage store was unreadable; another tokenhud process has already replaced it"
        : `the usage store was unreadable and was moved to ${moved}`,
    );
    this.#checkStore();
    this.recover();
  }

  /**
   * Runs `pass`. When the store proves unreadable, it is replaced (see `#replaceCorrupt`)
   * and a full pass reads every transcript into the fresh store; a second failure
   * propagates.
   */
  async #withRecovery<T>(pass: () => Promise<T>, full: () => Promise<T>): Promise<T> {
    try {
      return await pass();
    } catch (error) {
      if (!(error instanceof StoreCorrupt)) throw error;
      this.#replaceCorrupt();
      return await full();
    }
  }

  /**
   * Takes the daily backup when due, or at once when owed, after checking the whole store
   * (the daily integrity check; passes only touch the rows they write). An unreadable store
   * throws `StoreCorrupt`, for `#withRecovery`; any other failure is logged, once.
   */
  #maybeBackup(): void {
    try {
      if (!this.#backupNow && !backupDue(this.store)) return;
      const check = this.store.quickCheck();
      if (check !== "ok") {
        throw new StoreCorrupt(`the store failed its integrity check: ${check.slice(0, 200)}`);
      }
      // False: a slot held history not merged yet; it is queued, and the next full pass
      // merges it and then backs up.
      if (backup(this.store)) this.#backupNow = false;
      this.#backupError = null;
    } catch (error) {
      if (!(error instanceof StoreError) || error instanceof StoreCorrupt) throw error;
      if (error.message !== this.#backupError) {
        this.#log("warn", `the usage store backup failed: ${error.message}`);
      }
      this.#backupError = error.message;
    }
  }

  /**
   * Imports cc-usage's ledger (only read, through a snapshot copy) when the store has no
   * cc-usage import yet. Returns null when there is nothing to do.
   */
  importIfFirstRun(): ImportOutcome | null {
    const ledger = this.#options.importLedger;
    if (ledger === null || !existsSync(ledger)) return null;
    if (this.store.meta.imports.some((record) => record.source === "cc-usage")) return null;
    try {
      const outcome = importCcUsage(this.store, ledger);
      if (outcome.status === "deferred") this.#log("warn", outcome.warning);
      else {
        const left =
          outcome.tombstoned > 0 ? ` (${outcome.tombstoned} replayed Codex rows left out)` : "";
        this.#log("info", `imported ${outcome.inserted} rows of cc-usage history${left}`);
      }
      return outcome;
    } catch (error) {
      const reason = error instanceof ImportSourceError ? ` (${error.reason})` : "";
      this.#log("warn", `cc-usage history was not imported${reason}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Runs `job` after every earlier pass; a failure is logged and resolves to null. */
  #enqueue<T>(job: () => Promise<T>): Promise<T | null> {
    const run = this.#chain.then(() => (this.#stopped ? null : job()));
    const settled = run.catch((error: unknown) => {
      this.#log("error", `ingest pass failed: ${(error as Error).message}`);
      return null;
    });
    this.#chain = settled.then(() => {});
    return settled;
  }

  #ctx(rekey?: ReadonlySet<string>) {
    return {
      store: this.store,
      cursors: this.cursors,
      poolSize: this.#options.poolSize ?? defaultPoolSize(),
      log: this.#log,
      codexSessions: this.#codexSessions,
      ...(rekey === undefined ? {} : { rekey }),
    };
  }

  /** The Codex accounts awaiting the scheme-2 re-key among `roots`. */
  #pendingRekey(roots: readonly Root[]): Set<string> {
    let pending: string[];
    try {
      pending = this.store.meta.codexRekeyPending;
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      return new Set();
    }
    const codex = new Set(roots.filter((r) => r.provider === "codex").map((r) => r.identity));
    return new Set(pending.filter((id) => codex.has(id)));
  }

  /** Account labels as the store has them (a root's own label until it has rows). */
  labels(roots: readonly Root[]): string[] {
    let stored: Map<string, string>;
    try {
      stored = new Map(
        [...this.store.accounts().values()].map((a) => [`${a.provider}\0${a.identity}`, a.label]),
      );
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      stored = new Map();
    }
    return roots.map((r) => stored.get(`${r.provider}\0${r.identity}`) ?? r.label);
  }

  #report(report: PassReport): PassReport {
    this.#options.onPass?.(report);
    if (report.event !== null) this.#options.onChanged?.(report.event);
    return report;
  }

  /** Re-discovers roots and reads every transcript that changed since its cursor. */
  fullPass(): Promise<PassReport | null> {
    return this.#enqueue(() =>
      this.#withRecovery(
        () => this.#full(),
        () => this.#full(),
      ),
    );
  }

  async #full(): Promise<PassReport> {
    this.#checkStore();
    this.#recoverIfPending();
    const t0 = performance.now();
    const walkedAt = Date.now();
    this.#roots = this.discover().filter((root) => root.enabled);
    const files: PassFile[] = [];
    const polledDirs: { dir: string; root: Root }[] = [];
    for (const root of this.#roots) {
      for (const dir of transcriptDirs(root)) {
        const found = walk(dir);
        for (const path of found.files) files.push({ path, root });
        if (this.#polled(root)) for (const d of found.dirs) polledDirs.push({ dir: d, root });
      }
    }
    const stats = await statFiles(files.map((f) => f.path));
    files.forEach((f, i) => {
      f.stat = stats[i] ?? null;
    });
    this.#refreshCodex(files);
    const report = await runPass(this.#ctx(this.#pendingRekey(this.#roots)), files, true);
    if (report.rekey !== null) {
      const sum = (f: "deleted" | "changed" | "untouched") =>
        report.rekey?.accounts.reduce((a, r) => a + r[f], 0) ?? 0;
      this.#log(
        "info",
        `re-keyed Codex history (scheme ${report.rekey.scheme}): ${sum("deleted")} replayed rows removed, ${sum("changed")} rows corrected, ${sum("untouched")} rows from deleted rollouts kept`,
      );
    }
    report.wallMs = performance.now() - t0;
    if (this.#live) await this.#refreshLive(files, polledDirs, walkedAt);
    if (report.storeError === null) {
      this.cursors.notePass(
        this.#roots.map((r) => r.identity),
        Date.now(),
      );
    }
    this.#maybeBackup();
    return this.#report(report);
  }

  /** Indexes Codex rollouts by session, to find a child rollout's parent. */
  #refreshCodex(files: readonly PassFile[]): void {
    this.#codexSessions = codexSessionIndex(files);
  }

  // ── live ─────────────────────────────────────────────────────────────────────

  /** Starts watching and polling, after a first full pass. */
  async startLive(): Promise<void> {
    this.#live = true;
    await this.fullPass();
    if (this.#stopped) return;
    this.#sweepTimer = setInterval(() => void this.fullPass(), this.#timing.sweepMs);
    this.#schedulePoll(this.#timing.pollMs);
  }

  /**
   * Re-arms watchers and the poll baseline after a full pass that walked from `walkedAt`.
   * A directory's mtime is stat-ed after it was listed, so an entry made in between would
   * hide behind it: a directory changed since the walk began is listed again next tick.
   */
  async #refreshLive(
    files: readonly PassFile[],
    polledDirs: readonly { dir: string; root: Root }[],
    walkedAt: number,
  ): Promise<void> {
    const wanted = new Map<string, Root>();
    for (const root of this.#roots) {
      if (this.#polled(root)) continue;
      for (const dir of transcriptDirs(root)) if (existsSync(dir)) wanted.set(dir, root);
    }
    for (const [dir, watcher] of this.#watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.#watchers.delete(dir);
      }
    }
    for (const [dir, root] of wanted) if (!this.#watchers.has(dir)) this.#watch(dir, root);

    const dirStats = await statFiles(polledDirs.map((d) => d.dir));
    this.#pollDirs.clear();
    polledDirs.forEach(({ dir, root }, i) => {
      const st = dirStats[i];
      if (st)
        this.#pollDirs.set(dir, {
          root,
          mtimeMs: st.mtimeMs >= walkedAt - MTIME_SLACK_MS ? Number.NaN : st.mtimeMs,
        });
    });
    const now = Date.now();
    this.#hot.clear();
    for (const f of files) {
      if (!this.#polled(f.root) || !f.stat) continue;
      if (now - f.stat.mtimeMs < this.#timing.hotMs) {
        this.#hot.set(f.path, { root: f.root, size: f.stat.size, mtimeMs: f.stat.mtimeMs });
      }
    }
  }

  #watch(dir: string, root: Root): void {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (typeof filename === "string" && filename.endsWith(".jsonl"))
          this.#dirty.set(join(dir, filename), root);
        else this.#rescan.add(root);
        this.#scheduleFlush();
      });
      watcher.on("error", () => {
        watcher.close();
        this.#watchers.delete(dir);
        this.#rescan.add(root);
        this.#scheduleFlush();
      });
      this.#watchers.set(dir, watcher);
    } catch (error) {
      this.#log(
        "warn",
        `cannot watch '${root.label}' (${(error as NodeJS.ErrnoException).code ?? "error"}); the 60 s sweep covers it`,
      );
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null || this.#stopped) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flush();
    }, this.#timing.debounceMs);
  }

  /** A pass over the files marked dirty since the last one. */
  #flush(): Promise<PassReport | null> {
    return this.#enqueue(() =>
      this.#withRecovery(
        () => this.#flushOnce(),
        () => this.#full(),
      ),
    );
  }

  async #flushOnce(): Promise<PassReport | null> {
    if (this.#checkStore()) {
      this.#dirty.clear();
      this.#rescan.clear();
      return await this.#full();
    }
    const files = new Map<string, PassFile>();
    for (const [path, root] of this.#dirty) files.set(path, { path, root });
    this.#dirty.clear();
    for (const root of this.#rescan) {
      for (const dir of transcriptDirs(root))
        for (const path of walk(dir).files) files.set(path, { path, root });
    }
    this.#rescan.clear();
    if (files.size === 0) return null;
    const report = await runPass(this.#ctx(), [...files.values()], false);
    this.#notePass(report);
    return this.#report(report);
  }

  /** Notes, for `doctor`, the roots an incremental pass covered. */
  #notePass(report: PassReport): void {
    if (report.storeError !== null || report.roots.length === 0) return;
    this.cursors.notePass(
      report.roots.map((r) => r.identity),
      Date.now(),
    );
  }

  #schedulePoll(delay: number): void {
    if (this.#stopped) return;
    this.#pollTimer = setTimeout(() => {
      const poll = () =>
        this.#withRecovery(
          () => this.#poll(),
          async () => {
            await this.#full();
            return false;
          },
        );
      void this.#enqueue(poll).then((grew) =>
        this.#schedulePoll(grew ? this.#timing.fastPollMs : this.#timing.pollMs),
      );
    }, delay);
  }

  /**
   * One poll of the polled (Windows) roots: new entries in their directories and changes
   * to their hot files. Returns whether a file grew, which shortens the next interval.
   */
  async #poll(): Promise<boolean> {
    if (this.#checkStore()) {
      await this.#full();
      return false;
    }
    if (this.#pollDirs.size === 0 && this.#hot.size === 0) return false;
    const dirs = [...this.#pollDirs.keys()];
    const hot = [...this.#hot.keys()];
    const stats = await statFiles([...dirs, ...hot]);
    const dirty = new Map<string, PassFile>();
    for (const [i, dir] of dirs.entries()) {
      const st = stats[i];
      const known = this.#pollDirs.get(dir) as { root: Root; mtimeMs: number };
      if (!st) {
        this.#pollDirs.delete(dir);
        continue;
      }
      if (st.mtimeMs === known.mtimeMs) continue;
      known.mtimeMs = st.mtimeMs;
      const listing = listDir(dir);
      for (const path of listing.files)
        if (!this.#hot.has(path)) dirty.set(path, { path, root: known.root });
      for (const sub of listing.dirs) {
        if (this.#pollDirs.has(sub)) continue;
        // A new directory may still be filling: list it again on the next tick (NaN never
        // equals an mtime), which then records an mtime taken before that listing.
        const found = walk(sub);
        for (const d of found.dirs)
          this.#pollDirs.set(d, { root: known.root, mtimeMs: Number.NaN });
        for (const path of found.files) dirty.set(path, { path, root: known.root });
      }
    }
    let grew = false;
    for (const [k, path] of hot.entries()) {
      const st = stats[dirs.length + k] ?? null;
      const entry = this.#hot.get(path) as Hot;
      if (st !== null && st.size === entry.size && st.mtimeMs === entry.mtimeMs) continue;
      grew ||= st === null || st.size !== entry.size;
      dirty.set(path, { path, root: entry.root, stat: st });
    }
    if (dirty.size === 0) return false;
    const files = [...dirty.values()];
    const unstated = files.filter((f) => f.stat === undefined);
    const fresh = await statFiles(unstated.map((f) => f.path));
    unstated.forEach((f, i) => {
      f.stat = fresh[i] ?? null;
    });
    const report = await runPass(this.#ctx(), files, false);
    this.#notePass(report);
    this.#report(report);
    // A file modified in the last 2 h is hot from now on. An old file listed only because
    // its directory changed is left to the sweep, and a vanished one is dropped.
    const now = Date.now();
    for (const f of files) {
      if (!f.stat || now - f.stat.mtimeMs >= this.#timing.hotMs) {
        this.#hot.delete(f.path);
        continue;
      }
      if (!this.#hot.has(f.path) && f.stat.size > 0) grew = true;
      this.#hot.set(f.path, { root: f.root, size: f.stat.size, mtimeMs: f.stat.mtimeMs });
    }
    return grew;
  }

  /** Stops live updates, waits for the running pass, and closes the store and cache. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of [this.#flushTimer, this.#pollTimer])
      if (timer !== null) clearTimeout(timer);
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    await this.#chain;
    this.close();
  }

  close(): void {
    try {
      this.cursors.close();
    } finally {
      this.store.close();
    }
  }
}

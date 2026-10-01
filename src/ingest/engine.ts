import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import {
  type DiscoverOptions,
  discoverClaudeRoots,
  discoverCodexRoots,
  isWsl,
  type Root,
} from "../sources/roots.ts";
import { StoreError } from "../store/errors.ts";
import { type ImportOutcome, ImportSourceError, importCcUsage } from "../store/import-cc-usage.ts";
import { openStore, type Store } from "../store/store.ts";
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
}

/** Transcript directories of a root: Claude's `projects`; Codex's active and archived sessions. */
export function transcriptDirs(root: Root): string[] {
  return root.provider === "codex"
    ? [root.projects, join(root.path, "archived_sessions")]
    : [root.projects];
}

const WINDOWS_DRIVE = /^\/mnt\/[a-z]\//i;
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

  private constructor(options: EngineOptions, store: Store, cursors: CursorCache) {
    this.#options = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#log = options.log ?? (() => {});
    this.#wsl = isWsl(options.discover.platform ?? process.platform);
    this.store = store;
    this.cursors = cursors;
    if (cursors.note === "rebuilt")
      this.#log("warn", "the read-position cache was damaged and has been rebuilt");
    if (cursors.note === "in-memory") {
      this.#log(
        "warn",
        "the read-position cache cannot be used; every pass re-reads all transcripts",
      );
    }
  }

  /** Opens the store and the cursor cache. Throws `StoreError` when the store cannot be used. */
  static open(options: EngineOptions): IngestEngine {
    const store = openStore(options.storePath);
    try {
      return new IngestEngine(options, store, CursorCache.open(options.cachePath));
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
    return this.#options.pollAll === true || (this.#wsl && WINDOWS_DRIVE.test(root.projects));
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
    return this.#enqueue(async () => {
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
      return this.#report(report);
    });
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
    return this.#enqueue(async () => {
      const files = new Map<string, PassFile>();
      for (const [path, root] of this.#dirty) files.set(path, { path, root });
      this.#dirty.clear();
      for (const root of this.#rescan) {
        for (const dir of transcriptDirs(root))
          for (const path of walk(dir).files) files.set(path, { path, root });
      }
      this.#rescan.clear();
      if (files.size === 0) return null;
      return this.#report(await runPass(this.#ctx(), [...files.values()], false));
    });
  }

  #schedulePoll(delay: number): void {
    if (this.#stopped) return;
    this.#pollTimer = setTimeout(() => {
      void this.#enqueue(() => this.#poll()).then((grew) =>
        this.#schedulePoll(grew ? this.#timing.fastPollMs : this.#timing.pollMs),
      );
    }, delay);
  }

  /**
   * One poll of the polled (Windows) roots: new entries in their directories and changes
   * to their hot files. Returns whether a file grew, which shortens the next interval.
   */
  async #poll(): Promise<boolean> {
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
    this.#report(await runPass(this.#ctx(), files, false));
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

// The view-model Worker's state: a read-only store connection, a query engine that only
// forgets what it is told to (`autoInvalidate: false`), and the four view models it keeps
// current. Driven by messages, so tests run it in-process with fake timers.

import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { Config } from "../../config.ts";
import { Limits, spendFromQueries } from "../../limits/index.ts";
import { codexSnapshotsFrom } from "../../limits/snapshots.ts";
import { type McpActivity, readMcpActivity } from "../../mcp/heartbeat.ts";
import { loadPriceTable } from "../../pricing/overrides.ts";
import type { PriceTable } from "../../pricing/table.ts";
import { UsageQueries } from "../../query/engine.ts";
import { Zone } from "../../query/tz.ts";
import {
  discoverClaudeRoots,
  discoverCodexRoots,
  expandPath,
  isWsl,
  type Root,
  rootIdentity,
} from "../../sources/roots.ts";
import { emptyStoreDatabase, openStoreReader } from "../../store/store.ts";
import type { AccountSources } from "./accounts.ts";
import {
  affectedViews,
  COMPUTE,
  type ComputeContext,
  type Computed,
  changeRange,
} from "./compute.ts";
import { readAccountEvents } from "./history.ts";
import type {
  AccountInfo,
  IngestMode,
  RootInfo,
  ViewId,
  ViewModels,
  VmMessage,
  VmRequest,
  VmSettings,
  VmStart,
} from "./types.ts";
import { VIEW_IDS } from "./types.ts";

/** At most one recompute per this many ms (T10 §2). */
export const RECOMPUTE_INTERVAL_MS = 250;
/** The longest a clock-driven refresh waits; also keeps setTimeout in range. */
const MAX_TIMER_MS = 3_600_000;

export interface Timers {
  /** Monotonic ms, for spacing recomputes. */
  monotonic(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_TIMERS: Timers = {
  monotonic: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs `run` at most once per `interval` ms, as soon as allowed after a request. */
export class Coalescer {
  #last = Number.NEGATIVE_INFINITY;
  #timer: unknown = null;
  readonly #run: () => void;
  readonly #interval: number;
  readonly #timers: Timers;

  constructor(run: () => void, interval: number, timers: Timers) {
    this.#run = run;
    this.#interval = interval;
    this.#timers = timers;
  }

  request(): void {
    if (this.#timer !== null) return;
    const delay = Math.max(0, this.#last + this.#interval - this.#timers.monotonic());
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.#last = this.#timers.monotonic();
      this.#run();
    }, delay);
  }

  cancel(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export interface StoreAccount {
  readonly id: number;
  readonly provider: string;
  readonly identity: string;
  readonly label: string;
}

export function readStoreAccounts(db: Database): StoreAccount[] {
  return db
    .query<{ id: bigint; provider: string; identity: string; label: string }, []>(
      "SELECT id, provider, identity, label FROM accounts ORDER BY id",
    )
    .all()
    .map((a) => ({ id: Number(a.id), provider: a.provider, identity: a.identity, label: a.label }));
}

export function discoverRoots(config: Config, discover: VmStart["discover"]): Root[] {
  const claude = discoverClaudeRoots(config, discover);
  return [...claude, ...discoverCodexRoots(config, discover, claude)];
}

/**
 * Labels configured for roots, by provider and identity. They win over the store's: the
 * store takes a new label only with the account's next ingested row.
 */
export function configuredLabels(roots: readonly Root[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const root of roots) {
    if (root.labelExplicit) labels.set(`${root.provider}\0${root.identity}`, root.label);
  }
  return labels;
}

/** The store's accounts as the TUI shows them: configured labels, history-only flags. */
export function displayAccounts(
  stored: readonly StoreAccount[],
  labels: ReadonlyMap<string, string>,
  config: Config,
): AccountInfo[] {
  const historyOnly = new Set(config.history_only_roots);
  return stored.map((a) => ({
    id: a.id,
    label: labels.get(`${a.provider}\0${a.identity}`) ?? a.label,
    provider: a.provider,
    identity: a.identity,
    historyOnly: historyOnly.has(a.identity),
  }));
}

/** The engine every view model is computed with: caches are dropped only on request. */
export function createQueries(db: Database, prices: PriceTable, tz: string, now: () => number) {
  return new UsageQueries(db, prices, { tz, now, autoInvalidate: false });
}

/** The roots the settings editor lists, with what it needs to edit their config. */
export function rootInfos(roots: readonly Root[], config: Config, home: string): RootInfo[] {
  return roots.map((root) => {
    const entries = root.provider === "claude" ? config.claude_roots : config.codex_roots;
    // By identity, as discovery applies entries: `~/.claude` and its absolute path match.
    const index = entries.findIndex((e) => rootIdentity(e.path, home) === root.identity);
    return {
      provider: root.provider,
      label: root.label,
      path: root.path,
      source: root.source,
      enabled: root.enabled,
      historyOnly: root.historyOnly,
      identity: root.identity,
      disabledBy: config.disabled_roots.filter(
        (raw) => raw !== "" && expandPath(raw, home) === root.path,
      ),
      configIndex: index >= 0 ? index : null,
    };
  });
}

export class VmSession {
  readonly #start: VmStart;
  readonly #post: (message: VmMessage) => void;
  readonly #timers: Timers;
  readonly #coalescer: Coalescer;
  #config: Config;
  #settings: VmSettings;
  #mode: IngestMode;
  #db: Database;
  #storeMissing = false;
  #prices: PriceTable;
  #queries: UsageQueries;
  #zone: Zone;
  #storeAccounts: readonly StoreAccount[] = [];
  #accounts: AccountInfo[] = [];
  #labels: ReadonlyMap<string, string> = new Map();
  #roots: Root[] = [];
  /** What the Accounts view shows of the roots (none yet), to notice when it changes. */
  #rootsKey = "[]";
  readonly #computed = new Map<ViewId, Computed<unknown>>();
  readonly #dirty = new Set<ViewId>(VIEW_IDS);
  #dataVersion: bigint | null = null;
  #imports: string | null = null;
  #validity: unknown = null;
  #mcp = "";
  #activity: McpActivity | null = null;
  /** limits.json's mtime when last read (0: missing). */
  #limitsMtime = 0;
  readonly #wsl = isWsl();
  #scopeLabel: string | null;
  #closed = false;

  constructor(start: VmStart, post: (message: VmMessage) => void, timers: Timers = REAL_TIMERS) {
    this.#start = start;
    this.#post = post;
    this.#timers = timers;
    this.#config = start.config;
    this.#settings = start.settings;
    this.#mode = start.mode;
    this.#scopeLabel = start.scopeLabel;
    this.#coalescer = new Coalescer(() => this.#recompute(), RECOMPUTE_INTERVAL_MS, timers);
    const { table } = loadPriceTable(start.overridesPath);
    this.#prices = table;
    this.#zone = start.settings.tz === null ? Zone.system() : Zone.of(start.settings.tz);
    this.#db = this.#openStore();
    this.#queries = createQueries(this.#db, this.#prices, this.#zone.name, () => this.#now());
  }

  #now(): number {
    return this.#start.now ?? Date.now();
  }

  #openStore(): Database {
    try {
      const db = openStoreReader(this.#start.storePath);
      if (db !== null) {
        this.#storeMissing = false;
        return db;
      }
    } catch (error) {
      this.#post({ type: "error", message: `cannot read the store: ${(error as Error).message}` });
    }
    this.#storeMissing = true;
    return emptyStoreDatabase();
  }

  /**
   * The first frame's data: warm the engine over the whole store (T6: 20–50 ms at 1M rows),
   * compute every view and post them. Root discovery, which can be slow on Windows roots,
   * comes after.
   */
  begin(): void {
    this.#guard(() => {
      this.#loadAccounts();
      this.#queries.warm();
      this.#dataVersion = this.#pragmaVersion();
      this.#imports = this.#importsRecord();
    });
    this.#limitsChanged();
    this.#recompute();
    this.#discover();
    this.#pollMcp();
  }

  handle(request: VmRequest): void {
    if (this.#closed) return;
    switch (request.type) {
      case "changed":
        this.#changed(request.fromTs, request.toTs, request.accounts);
        break;
      case "invalidate":
        this.#invalidateAll();
        break;
      case "settings":
        this.#applySettings(request.settings);
        break;
      case "config":
        // Labels, enabled roots and history-only marks may all have changed.
        this.#config = request.config;
        this.#discover();
        this.#applyLabels();
        this.#markAll();
        break;
      case "mode":
        this.#mode = request.mode;
        // Writes made by the previous owner before the takeover were never reported.
        if (request.mode === "owner") this.#invalidateAll();
        break;
      case "tick":
        this.#tick();
        break;
      case "roots":
        this.#discover();
        break;
      case "stop":
        this.close();
        break;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#coalescer.cancel();
    if (this.#validity !== null) this.#timers.clearTimeout(this.#validity);
    this.#db.close();
  }

  #guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#post({ type: "error", message: (error as Error).message });
    }
  }

  #pragmaVersion(): bigint | null {
    const row = this.#db.query<{ data_version: bigint }, []>("PRAGMA data_version").get();
    return row?.data_version ?? null;
  }

  #importsRecord(): string | null {
    const row = this.#db
      .query<{ v: string | null }, []>("SELECT v FROM meta WHERE k = 'imports'")
      .get();
    return row?.v ?? null;
  }

  #loadAccounts(): void {
    this.#storeAccounts = readStoreAccounts(this.#db);
    this.#applyLabels();
  }

  #applyLabels(): void {
    this.#accounts = displayAccounts(this.#storeAccounts, this.#labels, this.#config);
    if (this.#scopeLabel !== null) {
      const match = this.#accounts.find((a) => a.label === this.#scopeLabel);
      if (match !== undefined) {
        this.#settings = { ...this.#settings, scope: match.id };
        this.#scopeLabel = null;
      }
    }
  }

  #discover(): void {
    this.#guard(() => {
      const options = this.#start.discover;
      this.#roots = discoverRoots(this.#config, options);
      const labels = configuredLabels(this.#roots);
      const changed =
        labels.size !== this.#labels.size ||
        [...labels].some(([k, v]) => this.#labels.get(k) !== v);
      this.#labels = labels;
      if (changed) {
        this.#applyLabels();
        this.#markAll();
      }
      const rootsKey = JSON.stringify(
        this.#roots.map((r) => [r.provider, r.identity, r.path, r.enabled, r.historyOnly]),
      );
      if (rootsKey !== this.#rootsKey) {
        this.#rootsKey = rootsKey;
        this.#mark("accounts");
      }
      this.#post({
        type: "roots",
        roots: rootInfos(this.#roots, this.#config, options.home),
      });
    });
  }

  #applySettings(settings: VmSettings): void {
    if (settings.tz !== this.#settings.tz) {
      this.#zone = settings.tz === null ? Zone.system() : Zone.of(settings.tz);
      this.#queries = createQueries(this.#db, this.#prices, this.#zone.name, () => this.#now());
      this.#guard(() => this.#queries.warm());
    }
    this.#settings = settings;
    this.#scopeLabel = null;
    this.#markAll();
  }

  #changed(fromTs: number, toTs: number, identities: readonly string[]): void {
    if (this.#reopen()) return;
    let ids: number[] | null = [];
    for (const identity of identities) {
      const account = this.#storeAccounts.find((a) => a.identity === identity);
      if (account === undefined) {
        ids = null;
        break;
      }
      ids.push(account.id);
    }
    const range = changeRange(fromTs, toTs);
    this.#queries.invalidate(range);
    if (ids === null) {
      // A new account: its row and every view's list of accounts change.
      this.#guard(() => this.#loadAccounts());
      this.#markAll();
      return;
    }
    for (const id of affectedViews(this.#computed, range, ids, this.#settings.scope)) {
      this.#dirty.add(id);
    }
    this.#coalescer.request();
  }

  #invalidateAll(): void {
    if (this.#reopen()) return;
    this.#queries.invalidate();
    this.#guard(() => this.#loadAccounts());
    this.#markAll();
  }

  #markAll(): void {
    for (const id of VIEW_IDS) this.#dirty.add(id);
    this.#coalescer.request();
  }

  #mark(id: ViewId): void {
    this.#dirty.add(id);
    this.#coalescer.request();
  }

  /**
   * Opens the store if it didn't exist (or couldn't be read) before: the first ingest
   * creates it. Returns true when it was just opened, with every view due for a recompute.
   */
  #reopen(): boolean {
    if (!this.#storeMissing) return false;
    const db = this.#openStore();
    if (this.#storeMissing) {
      db.close();
      return false;
    }
    this.#db.close();
    this.#db = db;
    this.#queries = createQueries(db, this.#prices, this.#zone.name, () => this.#now());
    this.#guard(() => {
      this.#loadAccounts();
      this.#queries.warm();
      this.#dataVersion = this.#pragmaVersion();
      this.#imports = this.#importsRecord();
    });
    this.#markAll();
    return true;
  }

  #tick(): void {
    this.#guard(() => {
      if (this.#storeMissing) {
        this.#reopen();
        return;
      }
      if (this.#mode === "reader") {
        // Another process ingests; we hear nothing from it but the store's change counter.
        const version = this.#pragmaVersion();
        if (version !== this.#dataVersion) {
          this.#dataVersion = version;
          this.#invalidateAll();
        }
      } else {
        // Our ingest Worker reports its own writes; an import run beside the TUI does not.
        const imports = this.#importsRecord();
        if (imports !== this.#imports) {
          this.#imports = imports;
          this.#invalidateAll();
        }
      }
    });
    this.#expire();
    this.#pollMcp();
    this.#pollLimits();
  }

  /** The limits fetcher (the ingest Worker, an MCP server) rewrote limits.json. */
  #pollLimits(): void {
    if (this.#limitsChanged()) this.#mark("accounts");
  }

  #limitsChanged(): boolean {
    const path = this.#start.limitsPath;
    if (path === undefined) return false;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // not there (yet)
    }
    if (mtime === this.#limitsMtime) return false;
    this.#limitsMtime = mtime;
    return true;
  }

  #pollMcp(): void {
    this.#guard(() => {
      const activity = readMcpActivity(this.#start.mcpDir, Date.now());
      const key = JSON.stringify(activity);
      if (key === this.#mcp) return;
      this.#mcp = key;
      const before = this.#activity;
      this.#activity = activity;
      this.#post({ type: "mcp", activity });
      // The Accounts view shows each account's last call, and whether a server runs.
      const shown = (a: McpActivity | null) =>
        JSON.stringify([(a?.servers ?? 0) > 0, a?.recent ?? []]);
      if (shown(activity) !== shown(before)) this.#mark("accounts");
    });
  }

  /** Marks the views the clock has made stale (a new day, the next activity bucket). */
  #expire(): void {
    const now = this.#now();
    let any = false;
    for (const [id, c] of this.#computed) {
      if (c.validUntil <= now) {
        this.#dirty.add(id);
        any = true;
      }
    }
    if (any) this.#coalescer.request();
  }

  #scheduleExpiry(): void {
    if (this.#validity !== null) this.#timers.clearTimeout(this.#validity);
    this.#validity = null;
    if (this.#start.now !== undefined) return; // a frozen clock never expires anything
    let next = Number.POSITIVE_INFINITY;
    for (const c of this.#computed.values()) next = Math.min(next, c.validUntil);
    if (!Number.isFinite(next)) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(1000, next - this.#now() + 50));
    this.#validity = this.#timers.setTimeout(() => {
      this.#validity = null;
      this.#expire();
      this.#scheduleExpiry();
    }, delay);
  }

  /** What the Accounts view reads besides usage (T13): roots, limits, MCP activity. */
  #accountSources(): AccountSources {
    const { limitsPath, cachePath } = this.#start;
    const roots = this.#roots;
    return {
      roots,
      limits:
        limitsPath === undefined
          ? null
          : new Limits({
              limitsPath,
              roots: () => roots,
              db: this.#db,
              spend: spendFromQueries(this.#queries),
              ...(cachePath === undefined ? {} : { snapshots: codexSnapshotsFrom(cachePath) }),
              now: () => this.#now(),
            }),
      mcp: this.#activity,
      wsl: this.#wsl,
      home: this.#start.discover.home,
    };
  }

  #context(): ComputeContext {
    return {
      q: this.#queries,
      now: this.#now(),
      zone: this.#zone,
      accounts: this.#accounts,
      scope: this.#settings.scope,
      window: this.#settings.window,
      limitEvents: (range) => readAccountEvents(this.#db, this.#storeAccounts, range),
      prices: this.#prices,
      sources: this.#accountSources(),
    };
  }

  #recompute(): void {
    if (this.#closed || this.#dirty.size === 0) return;
    const t0 = performance.now();
    const views: ViewModels = {};
    this.#guard(() => {
      const ctx = this.#context();
      this.#queries.snapshot(() => {
        for (const id of VIEW_IDS) {
          if (!this.#dirty.has(id)) continue;
          const computed = COMPUTE[id](ctx);
          this.#computed.set(id, computed);
          (views as Record<ViewId, unknown>)[id] = computed.vm;
        }
      });
      this.#dirty.clear();
    });
    this.#scheduleExpiry();
    if (Object.keys(views).length === 0) return;
    this.#post({
      type: "views",
      views,
      accounts: this.#accounts,
      scope: this.#settings.scope,
      ms: performance.now() - t0,
    });
  }
}

/**
 * "Ingest once if stale" for the `usage` tool. When the store's newest data is over two
 * minutes old, the server runs one incremental ingest pass, but only while it holds the
 * single-writer ingest lock, so it never competes with a running TUI (whose Worker keeps
 * the store live) or another MCP server. Without the lock it answers from the store as it
 * is and says how old that is (`stale_s`).
 *
 * The lock is T10's (`src/lock.ts`), reached through `AcquireWriterLock` so this module
 * doesn't define a second one; `tokenhud mcp` passes it. With `acquireWriterLock` null
 * (tests) the server never ingests.
 */

/** A held single-writer lock: T10's `WriterLock` has exactly these methods. */
export interface WriterLockHandle {
  /** Refreshes the holder record; true while held (an OS lock can't be taken over). */
  heartbeat(): boolean;
  release(): void;
}

/** Takes the lock if it is free or stale; null while another process holds it. */
export type AcquireWriterLock = () => WriterLockHandle | null;

export const STALE_AFTER_MS = 2 * 60_000;
/** T10's heartbeat interval: it keeps the lock's "who holds it" record current during a pass. */
export const LOCK_HEARTBEAT_MS = 10_000;

export interface FreshnessOptions {
  /** Null: the store is never refreshed here (tests; `tokenhud mcp` passes T10's lock). */
  acquireWriterLock: AcquireWriterLock | null;
  /** One incremental ingest pass into the store; rejects when it could not store anything. */
  ingestOnce: () => Promise<void>;
  /** Epoch ms of the store's newest usage row; null for an empty or missing store. */
  newestData: () => number | null;
  now?: () => number;
  log?: (message: string) => void;
  lockHeartbeatMs?: number;
}

export interface Freshness {
  /**
   * Seconds since the store was known to be current: since its newest usage row, or since
   * this server's own last ingest pass if that is later. Null with no data at all.
   */
  stale_s: number | null;
  /** Why the store was not refreshed, when it is stale; null otherwise. */
  warning: string | null;
}

export class Freshener {
  readonly #o: FreshnessOptions;
  readonly #now: () => number;
  #lastPassAt: number | null = null;
  #running: Promise<Freshness> | null = null;

  constructor(options: FreshnessOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** Refreshes the store if it is stale and the lock is free. Concurrent calls share one pass. */
  ensure(): Promise<Freshness> {
    this.#running ??= this.#ensure().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  #asOf(): number | null {
    const newest = this.#o.newestData();
    if (newest === null) return this.#lastPassAt;
    return this.#lastPassAt === null ? newest : Math.max(newest, this.#lastPassAt);
  }

  #staleS(asOf: number | null): number | null {
    return asOf === null ? null : Math.max(0, Math.floor((this.#now() - asOf) / 1000));
  }

  async #ensure(): Promise<Freshness> {
    const asOf = this.#asOf();
    if (asOf !== null && this.#now() - asOf <= STALE_AFTER_MS) {
      return { stale_s: this.#staleS(asOf), warning: null };
    }
    const acquire = this.#o.acquireWriterLock;
    if (acquire === null) {
      return {
        stale_s: this.#staleS(asOf),
        warning:
          "the store was not refreshed: this build of the MCP server does not ingest (no single-writer lock yet); data is as of the last tokenhud ingest",
      };
    }
    let lock: WriterLockHandle | null;
    try {
      lock = acquire();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      this.#o.log?.(`cannot take the ingest lock (${code})`);
      return {
        stale_s: this.#staleS(asOf),
        warning: `the store was not refreshed: cannot take the ingest lock (${code})`,
      };
    }
    if (lock === null) {
      return {
        stale_s: this.#staleS(asOf),
        warning:
          "the store was not refreshed: another tokenhud process holds the ingest lock and keeps the store current",
      };
    }
    // The lock is held by the operating system until release, so heartbeat() only refreshes
    // its "who holds it" record; a false (never expected) is logged, and the store's
    // max-merge would keep a double write harmless anyway.
    let lost = false;
    const beat = setInterval(() => {
      if (!lost && !lock.heartbeat()) {
        lost = true;
        this.#o.log?.("lost the ingest lock to another process during a pass");
      }
    }, this.#o.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS);
    try {
      await this.#o.ingestOnce();
      this.#lastPassAt = this.#now();
      return { stale_s: this.#staleS(this.#asOf()), warning: null };
    } catch (error) {
      this.#o.log?.(`ingest pass failed: ${(error as Error).message}`);
      return {
        stale_s: this.#staleS(this.#asOf()),
        warning: "the store was not refreshed: the ingest pass failed (see the MCP log)",
      };
    } finally {
      clearInterval(beat);
      lock.release();
    }
  }
}

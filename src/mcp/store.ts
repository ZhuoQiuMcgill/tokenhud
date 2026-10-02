import type { Database } from "bun:sqlite";
import type { PriceTable } from "../pricing/table.ts";
import { UsageQueries } from "../query/engine.ts";
import { emptyStoreDatabase, openStoreReader } from "../store/store.ts";

/**
 * The usage store as the MCP server reads it: one read-only connection (`safeIntegers`,
 * never migrating or writing), opened on first use. Until a store exists, queries run on an
 * empty in-memory one, and each call looks for the real store again, so a store created
 * later (by the TUI, an import, or this server's own ingest pass) is picked up.
 */

export interface StoreHandle {
  /** The real store, or null while there is none. */
  db: Database | null;
  queries: UsageQueries;
}

export class StoreSource {
  readonly #path: string;
  readonly #prices: PriceTable;
  readonly #tz: string;
  readonly #now: () => number;
  #handle: StoreHandle | null = null;
  #empty: Database | null = null;

  constructor(path: string, prices: PriceTable, tz: string, now: () => number = Date.now) {
    this.#path = path;
    this.#prices = prices;
    this.#tz = tz;
    this.#now = now;
  }

  /** The store now. Throws a `StoreError` when it exists but cannot be read. */
  get(): StoreHandle {
    if (this.#handle?.db) return this.#handle;
    const db = openStoreReader(this.#path);
    if (db !== null) {
      this.#empty?.close();
      this.#empty = null;
      this.#handle = { db, queries: this.#queries(db) };
      return this.#handle;
    }
    if (this.#empty === null) {
      this.#empty = emptyStoreDatabase();
      this.#handle = { db: null, queries: this.#queries(this.#empty) };
    }
    return this.#handle as StoreHandle;
  }

  #queries(db: Database): UsageQueries {
    return new UsageQueries(db, this.#prices, { tz: this.#tz, now: this.#now });
  }

  close(): void {
    this.#handle?.db?.close();
    this.#empty?.close();
    this.#handle = null;
    this.#empty = null;
  }
}

/** Epoch ms of the store's newest usage row, or null when it has none. */
export function newestUsage(db: Database | null): number | null {
  if (db === null) return null;
  const row = db.query<{ ts: bigint | null }, []>("SELECT max(ts) AS ts FROM usage").get();
  return row?.ts === null || row?.ts === undefined ? null : Number(row.ts);
}

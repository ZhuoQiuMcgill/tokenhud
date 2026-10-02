import { SQLiteError } from "bun:sqlite";

/**
 * The store could not be used for this operation. Never fatal: the caller degrades (shows
 * a warning, keeps its in-memory data) and retries later. Ported from cc-usage's
 * `LedgerError` family; every failure leaves the store as `StoreError`, never as a raw
 * SQLite error.
 */
export class StoreError extends Error {
  override name = "StoreError";
}

/** Another process held the database past the busy timeout. Retry on the next pass. */
export class StoreBusy extends StoreError {
  override name = "StoreBusy";
}

/** The file is not a readable SQLite database. Recovery (durability.ts) moves it aside. */
export class StoreCorrupt extends StoreError {
  override name = "StoreCorrupt";
}

/** Disk full, read-only or unopenable location, or a store this version must not touch. */
export class StoreUnavailable extends StoreError {
  override name = "StoreUnavailable";
}

/**
 * The store's key scheme is unknown, newer than this build, or has no migration path.
 * The store is left untouched, so mixing schemes can never double count.
 */
export class SchemeRefused extends StoreError {
  override name = "SchemeRefused";
}

// SQLite primary result codes (the low byte of an extended code).
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/**
 * Maps a SQLite or file-system error onto the ways a caller reacts, as cc-usage's
 * `_classify`: by result code where the error carries one, by message otherwise.
 */
export function classify(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const message = error instanceof Error ? error.message || error.name : String(error);
  const primary = error instanceof SQLiteError ? error.errno & 0xff : undefined;
  const lowered = message.toLowerCase();
  const options = { cause: error };
  if (
    primary === SQLITE_CORRUPT ||
    primary === SQLITE_NOTADB ||
    (primary === undefined && (lowered.includes("malformed") || lowered.includes("not a database")))
  ) {
    return new StoreCorrupt(message, options);
  }
  if (
    primary === SQLITE_BUSY ||
    primary === SQLITE_LOCKED ||
    (primary === undefined && (lowered.includes("locked") || lowered.includes("busy")))
  ) {
    return new StoreBusy(message, options);
  }
  return new StoreUnavailable(message, options);
}

/**
 * Whether `error` comes from SQLite or the operating system, as opposed to a caller's
 * programming error (a TypeError or RangeError), which is rethrown unchanged.
 */
function isEnvironmental(error: unknown): boolean {
  if (error instanceof SQLiteError) return true;
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    "errno" in error
  );
}

/** Runs `fn`, turning SQLite and OS failures into `StoreError`s. */
export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof StoreError || !isEnvironmental(error)) throw error;
    throw classify(error);
  }
}

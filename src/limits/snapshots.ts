import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type Capture, parseCapture } from "./capture.ts";

/**
 * Codex rate-limit snapshots from rollouts, which T5's Codex ingest keeps in the derived
 * `cache.db` (cc-usage's `latest_rate_limits_by_account`). This is the whole interface
 * between the two tasks:
 *
 *     CREATE TABLE codex_limit_snapshots (
 *       identity TEXT PRIMARY KEY,   -- the Codex root's account identity
 *       captured_at REAL NOT NULL,   -- epoch seconds of the newest token_count event
 *       rate_limits TEXT NOT NULL    -- JSON: {"codex_primary": {"used_percentage",
 *                                    --   "resets_at" (epoch s), "window_minutes"?}, ...}
 *     )
 *
 * one row per account, replaced whole by a newer snapshot, numbers only. Until that table
 * exists (or if its shape differs), there are simply no snapshots: Codex limits then come
 * from the app-server RPC and the last-good cache.
 */

/** Account identity -> its newest rollout snapshot. */
export type CodexSnapshots = () => ReadonlyMap<string, Capture>;

export const NO_SNAPSHOTS: CodexSnapshots = () => new Map();

/** Reads the snapshots from `cachePath` (read-only, per call); empty on any problem. */
export function readCodexSnapshots(cachePath: string): Map<string, Capture> {
  const out = new Map<string, Capture>();
  if (!existsSync(cachePath)) return out;
  let db: Database | undefined;
  try {
    db = new Database(cachePath, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 1000");
    const rows = db
      .query<{ identity: unknown; captured_at: unknown; rate_limits: unknown }, []>(
        "SELECT identity, captured_at, rate_limits FROM codex_limit_snapshots",
      )
      .all();
    for (const row of rows) {
      if (typeof row.identity !== "string" || typeof row.rate_limits !== "string") continue;
      let buckets: unknown;
      try {
        buckets = JSON.parse(row.rate_limits);
      } catch {
        continue;
      }
      const capture = parseCapture({
        captured_at: row.captured_at,
        source: "codex",
        via: "rollout",
        rate_limits: buckets,
      });
      if (capture !== null && Object.keys(capture.rate_limits).length > 0) {
        out.set(row.identity, capture);
      }
    }
  } catch {
    // No table yet (T5 not there), another layout, or a cache being rebuilt.
  } finally {
    db?.close();
  }
  return out;
}

export function codexSnapshotsFrom(cachePath: string): CodexSnapshots {
  return () => readCodexSnapshots(cachePath);
}

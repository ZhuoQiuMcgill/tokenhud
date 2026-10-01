import type { Database } from "bun:sqlite";
import type { Root } from "../sources/roots.ts";
import type { LimitEventChanges, LimitEventRow, Store } from "../store/store.ts";
import { bucketLabel, type Capture, orderedBuckets, windowMinutes } from "./capture.ts";

/**
 * Limit events: when a window reached 100 %, when a weekly window passed 80 %, and when a
 * window that had reached 100 % became usable again after its reset. They are decided here
 * from captures and stored by the ingest Worker (`Store.recordLimitEvents`) in the
 * `limit_events` table, for the Overview's event list and the history detail.
 *
 * - **Window instance.** One reset period of one window, named by its reset time. Claude
 *   reports reset times with sub-second jitter around a fixed instant, so two captures
 *   belong to the same instance when their reset times are less than 15 minutes apart. A
 *   new instance starts at or after the old one's reset and lasts the window's length (at
 *   least 5 hours), so its reset time is always hours away from the old one's.
 * - **reached:** a capture with utilisation >= 1.0; once per instance.
 * - **passed_80:** a capture of a weekly (7-day) window with utilisation >= 0.8; once per
 *   instance.
 * - **resumed:** the first capture below 1.0 of a window whose `reached` instance has since
 *   reset. It closes that `reached` event (`resumed_at`); once per instance.
 * - A capture taken at or after its own window's reset describes a window that has already
 *   reset, so it decides nothing.
 * Re-running the rules on a capture already seen changes nothing, so the Worker simply
 * applies the latest capture of every account each round.
 */

export type LimitEventKind = "reached" | "passed_80" | "resumed";

/** Two reset times closer than this name the same window instance. */
export const SAME_INSTANCE_MS = 15 * 60_000;
/** Events older than this cannot share an instance with a new capture (a week plus slack). */
export const EVENT_HORIZON_MS = 8 * 24 * 3_600_000;
const WEEK_MINUTES = 10_080;

/** The events and resumes `capture` implies, given the account's `existing` events. */
export function detectLimitEvents(
  capture: Capture,
  existing: readonly LimitEventRow[],
): LimitEventChanges {
  const changes: LimitEventChanges = { insert: [], resume: [] };
  const at = Math.round(capture.captured_at * 1000);
  const seen = (kind: LimitEventKind, window: string, resetsAt: number) =>
    [...existing, ...changes.insert].some(
      (e) =>
        e.kind === kind &&
        e.window === window &&
        Math.abs(e.resetsAt - resetsAt) < SAME_INSTANCE_MS,
    );
  const resumed = new Set<number>();
  for (const [window, bucket] of orderedBuckets(capture)) {
    const resetsAt = Math.round(bucket.resets_at * 1000);
    if (at >= resetsAt) continue;
    const utilization = bucket.used_percentage / 100;
    const label = bucketLabel(window, bucket);
    const add = (kind: LimitEventKind) => {
      if (!seen(kind, window, resetsAt)) changes.insert.push({ kind, window, label, resetsAt, at });
    };
    if (utilization >= 1) add("reached");
    if (utilization >= 0.8 && windowMinutes(window, bucket) === WEEK_MINUTES) add("passed_80");
    if (utilization < 1) {
      const open = existing.filter(
        (e) =>
          e.kind === "reached" &&
          e.window === window &&
          e.resumedAt === null &&
          e.resetsAt <= at &&
          !resumed.has(e.id),
      );
      if (open.length === 0) continue;
      for (const e of open) {
        resumed.add(e.id);
        changes.resume.push({ id: e.id, at });
      }
      add("resumed");
    }
  }
  return changes;
}

/** Records the events `capture` implies for `root`'s account. Returns how many changed. */
export function recordCaptureEvents(store: Store, root: Root, capture: Capture): number {
  return store.recordLimitEvents(
    {
      provider: root.provider,
      identity: root.identity,
      label: root.label,
      derivedLabel: !root.labelExplicit,
    },
    Math.round(capture.captured_at * 1000) - EVENT_HORIZON_MS,
    (existing) => detectLimitEvents(capture, existing),
  );
}

/** A recorded event, as consumers read it. Times are epoch ms. */
export interface LimitEvent {
  /** The account: `id` is the root identity, as in `getLimits`. */
  account: { id: string; label: string; provider: string };
  kind: LimitEventKind;
  /** The window's kind ("session", "weekly_all", "codex_primary", ...). */
  window: string;
  /** The window's label when the event was recorded ("5-HOUR", "FABLE WEEKLY"). */
  label: string;
  /** The reset time of the window instance the event belongs to. */
  resets_at: number;
  at: number;
  /** For `reached`: when the window was found usable again, or null while it is not. */
  resumed_at: number | null;
}

/**
 * Events with `from <= at < to` (epoch ms), oldest first, optionally for some account
 * identities only. A store from before the events table (schema v3) has none.
 */
export function readLimitEvents(
  db: Database,
  range: { from: number; to: number },
  accounts?: readonly string[],
): LimitEvent[] {
  const table = db
    .query<{ n: bigint | number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'limit_events'",
    )
    .get();
  if (Number(table?.n ?? 0) === 0) return [];
  const rows = db
    .query<
      {
        provider: string;
        identity: string;
        account_label: string;
        kind: string;
        window: string;
        label: string;
        resets_at: bigint | number;
        at: bigint | number;
        resumed_at: bigint | number | null;
      },
      [number, number]
    >(
      `SELECT a.provider, a.identity, a.label AS account_label, e.kind, e.window, e.label,
              e.resets_at, e.at, e.resumed_at
       FROM limit_events e JOIN accounts a ON a.id = e.acct
       WHERE e.at >= ?1 AND e.at < ?2
       ORDER BY e.at, e.id`,
    )
    .all(range.from, range.to);
  const wanted = accounts === undefined ? null : new Set(accounts);
  return rows
    .filter((r) => wanted === null || wanted.has(r.identity))
    .map((r) => ({
      account: { id: r.identity, label: r.account_label, provider: r.provider },
      kind: r.kind as LimitEventKind,
      window: r.window,
      label: r.label,
      resets_at: Number(r.resets_at),
      at: Number(r.at),
      resumed_at: r.resumed_at === null ? null : Number(r.resumed_at),
    }));
}

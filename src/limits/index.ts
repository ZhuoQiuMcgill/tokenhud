import type { Database } from "bun:sqlite";
import type { Provider, Root } from "../sources/roots.ts";
import { loadLimitsCache } from "./cache.ts";
import {
  bucketLabel,
  type Capture,
  type CaptureVia,
  freshest,
  orderedBuckets,
  windowMinutes,
} from "./capture.ts";
import { PACE_MINUTES, type Projection, projectExhaustion, type SpendSource } from "./derive.ts";
import { type LimitEvent, readLimitEvents } from "./events.ts";
import { shownError } from "./service.ts";
import { type CodexSnapshots, NO_SNAPSHOTS } from "./snapshots.ts";

/**
 * The limits API for the TUI (M3) and the MCP server (T9).
 *
 * `Limits.getLimits` reads: limits.json (the last-good captures the fetcher keeps), Codex
 * rollout snapshots, and the store for spend. It never fetches; fetching is the
 * `LimitsService`'s job, in the ingest Worker (`IngestWorker.refreshLimits(account,
 * maxAgeS)`) or, for the MCP server, in-process (`LimitsService.refresh`, with
 * `maxAgeS = 60`). Times are epoch ms.
 */

export { limitsPath } from "./cache.ts";
export { type SpendSource, spendFromQueries } from "./derive.ts";
export type { LimitEvent, LimitEventKind } from "./events.ts";
export { LimitsService, type LimitsServiceOptions, type RefreshOutcome } from "./service.ts";
export { codexSnapshotsFrom } from "./snapshots.ts";

/** One limit window of an account. */
export interface LimitWindow {
  /**
   * The window's kind, stable across captures: "session" (5-hour), "weekly_all",
   * "weekly_scoped" (a per-model weekly limit), "codex_primary", "codex_secondary", ...
   */
  kind: string;
  /** "5-HOUR", "WEEKLY", "FABLE WEEKLY", "WEEKLY" ... as cc-usage shows them. */
  label: string;
  /**
   * 0..1 (a provider may report more than 1). 0 once `resets_at` has passed: the captured
   * value belonged to a window that has since reset (cc-usage's T10 rule).
   */
  utilization: number;
  resets_at: number;
  /** The window's length in seconds (5 h, 7 d), or null when unknown. */
  window_s: number | null;
  /** The account's spend pace, USD per hour over the last 30 minutes; null without a store. */
  pace_cost_per_h: number | null;
  /**
   * **An estimate** (label it so wherever it is shown): when the window reaches 100 % at
   * the current pace, "safe" when that is after the reset, null ("—") without enough data.
   * See `projectExhaustion` for the formula and its limits.
   */
  projected_exhaustion_at: Projection;
  /** Seconds since the window was captured. */
  stale_s: number;
}

export interface AccountLimits {
  account: {
    /** The root identity, `sha256(resolved root path)[:32]`. */
    id: string;
    label: string;
    provider: Provider;
    /**
     * False for a history-only account: in `history_only_roots`, or not signed in on this
     * machine. Show "not signed in here"; its last-good windows, if any, are still listed.
     */
    signed_in: boolean;
  };
  /** In cc-usage's display order; empty when nothing was ever captured. */
  windows: LimitWindow[];
  /** When the windows were captured; null when there are none. */
  as_of: number | null;
  /** Where they came from: the Claude API, the Codex app-server, a rollout, or cc-usage's cache. */
  source: CaptureVia | null;
  /** The last fetch error, when the windows are older than it; never holds a credential. */
  error: string | null;
  /** Spend over the last 30 minutes, per hour; null without a store. */
  pace: { cost_per_h: number; tokens_per_h: number } | null;
}

export interface LimitsOptions {
  limitsPath: string;
  /** The roots of both providers; disabled ones are left out. */
  roots: () => readonly Root[];
  /** The store (a read-only connection is enough), or null before one exists. */
  db: Database | null;
  /** Spend over that store (`spendFromQueries`), or null. */
  spend: SpendSource | null;
  snapshots?: CodexSnapshots;
  now?: () => number;
}

export class Limits {
  readonly #o: LimitsOptions;
  readonly #now: () => number;

  constructor(options: LimitsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** Every enabled account's limits, Claude first. */
  getLimits(): AccountLimits[];
  /** One account's limits, by identity or label; null when there is no such account. */
  getLimits(account: string): AccountLimits | null;
  getLimits(account?: string): AccountLimits[] | AccountLimits | null {
    const roots = this.#o.roots().filter((root) => root.enabled);
    const chosen =
      account === undefined
        ? roots
        : roots.filter((root) => root.identity === account || root.label === account).slice(0, 1);
    const file = loadLimitsCache(this.#o.limitsPath);
    const snapshots = chosen.some((root) => root.provider === "codex")
      ? (this.#o.snapshots ?? NO_SNAPSHOTS)()
      : new Map<string, Capture>();
    const now = this.#now();
    const out = chosen.map((root): AccountLimits => {
      // cc-usage's order: on a captured_at tie the snapshot beats last-good.
      const capture = freshest([snapshots.get(root.identity), file.providers[root.identity]]);
      const status = file.status[root.identity];
      return this.#account(
        root,
        capture,
        status?.signed_in ?? true,
        shownError(root, status, capture),
        now,
      );
    });
    return account === undefined ? out : (out[0] ?? null);
  }

  #account(
    root: Root,
    capture: Capture | null,
    signedIn: boolean,
    error: string | null,
    now: number,
  ): AccountLimits {
    const { spend } = this.#o;
    const acct = this.#storeAccount(root);
    const pace = acct !== null && spend !== null ? spend.pace(acct, PACE_MINUTES) : null;
    const capturedAt = capture === null ? 0 : capture.captured_at * 1000;
    const windows = orderedBuckets(capture).map(([kind, bucket]): LimitWindow => {
      const resetsAt = bucket.resets_at * 1000;
      const minutes = windowMinutes(kind, bucket);
      const utilization = now >= resetsAt ? 0 : bucket.used_percentage / 100;
      return {
        kind,
        label: bucketLabel(kind, bucket),
        utilization,
        resets_at: resetsAt,
        window_s: minutes === null ? null : minutes * 60,
        pace_cost_per_h: pace === null ? null : pace.costPerHour,
        projected_exhaustion_at:
          acct === null || spend === null || pace === null
            ? null
            : projectExhaustion({
                utilization,
                capturedAt,
                resetsAt,
                windowMs: minutes === null ? null : minutes * 60_000,
                costPerHour: pace.costPerHour,
                now,
                spent: (from, to) => spend.cost(acct, from, to),
              }),
        stale_s: Math.max(0, Math.floor((now - capturedAt) / 1000)),
      };
    });
    return {
      account: {
        id: root.identity,
        label: root.label,
        provider: root.provider,
        signed_in: !root.historyOnly && signedIn,
      },
      windows,
      as_of: capture === null ? null : Math.round(capturedAt),
      source: capture?.via ?? null,
      error,
      pace:
        pace === null ? null : { cost_per_h: pace.costPerHour, tokens_per_h: pace.tokensPerHour },
    };
  }

  /** The store's id for a root's account, or null when the store has none (no usage yet). */
  #storeAccount(root: Root): number | null {
    const db = this.#o.db;
    if (db === null) return null;
    const row = db
      .query<{ id: bigint | number }, [string, string]>(
        "SELECT id FROM accounts WHERE provider = ?1 AND identity = ?2",
      )
      .get(root.provider, root.identity);
    return row === null ? null : Number(row.id);
  }

  /**
   * Limit events with `from <= at < to`, oldest first; for one account (identity or label)
   * when given. Empty without a store.
   */
  limitEvents(range: { from: number; to: number }, account?: string): LimitEvent[] {
    const db = this.#o.db;
    if (db === null) return [];
    if (account === undefined) return readLimitEvents(db, range);
    const root = this.#o.roots().find((r) => r.identity === account || r.label === account);
    return readLimitEvents(db, range, [root?.identity ?? account]);
  }
}

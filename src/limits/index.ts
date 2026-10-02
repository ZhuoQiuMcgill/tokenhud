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
import {
  PACE_MINUTES,
  type PaceBasis,
  type Projection,
  projectExhaustion,
  type SpendSource,
  windowPace,
} from "./derive.ts";
import { type LimitEvent, readLimitEvents } from "./events.ts";
import {
  type AccountGroup,
  type GroupSource,
  type ManualLinks,
  NO_LINKS,
  resolveGroups,
} from "./groups.ts";
import { groupError } from "./service.ts";
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
export { type PaceBasis, type SpendSource, spendFromQueries } from "./derive.ts";
export type { LimitEvent, LimitEventKind } from "./events.ts";
export {
  type AccountGroup,
  type GroupSource,
  type ManualLinks,
  manualLinks,
  NO_LINKS,
} from "./groups.ts";
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
  /**
   * The spend pace this window projects from, USD per hour, every root on the account
   * together (`windowPace`): the last 30 minutes, or for a weekly window its average since
   * it began. Null without a store.
   */
  pace_cost_per_h: number | null;
  /** The same pace in tokens per hour; null without a store. */
  pace_tokens_per_h: number | null;
  /** Which pace that is: "30m" or "window_avg"; null without a store. */
  pace_basis: PaceBasis | null;
  /**
   * **An estimate** (label it so wherever it is shown): when the window reaches 100 % at
   * its pace, "safe" when that is after the reset, null ("—") without enough data. A
   * weekly window's is good to about a part of a day. See `projectExhaustion` for the
   * formula and its limits.
   */
  projected_exhaustion_at: Projection;
  /** Seconds since the window was captured. */
  stale_s: number;
}

/** The roots on one subscription account (T16), as `getLimits` reports them. */
export interface SharedAccount {
  /** A hash of the member identities. */
  id: string;
  /** Linked in config (`same_account`), or found by auto-detection. */
  source: GroupSource;
  /** Every root on the account, this one included, in discovery order. */
  members: { id: string; label: string }[];
  /**
   * Two of the roots showed different limits at their last comparison: for a manual link,
   * which is kept, a sign it may be wrong (an auto link is suspended then instead).
   */
  differs: boolean;
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
     * For roots on one account: true when any of them is signed in here.
     */
    signed_in: boolean;
  };
  /**
   * The roots this one shares its subscription account with, or null for a root on its
   * own. Its windows, pace and projections are then the account's: the freshest capture
   * of any of them, and their spend summed.
   */
  group: SharedAccount | null;
  /** In cc-usage's display order; empty when nothing was ever captured. */
  windows: LimitWindow[];
  /** When the windows were captured; null when there are none. */
  as_of: number | null;
  /** Where they came from: the Claude API, the Codex app-server, a rollout, or cc-usage's cache. */
  source: CaptureVia | null;
  /** The last fetch error, when the windows are older than it; never holds a credential. */
  error: string | null;
  /**
   * Spend over the last 30 minutes, per hour, of every root on the account together; null
   * without a store. A weekly window projects from its own pace (`LimitWindow`).
   */
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
  /** Manual account links (config `same_account`, `separate_accounts`). */
  links?: () => ManualLinks;
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
    const groups = resolveGroups(roots, this.#o.links?.() ?? NO_LINKS, file.pairs, file.groups);
    const members = (root: Root) => groups.get(root.identity)?.members ?? [root];
    const snapshots = chosen.some((root) => root.provider === "codex")
      ? (this.#o.snapshots ?? NO_SNAPSHOTS)()
      : new Map<string, Capture>();
    // cc-usage's order: on a captured_at tie the snapshot beats last-good.
    const captureOf = (root: Root) =>
      freshest([snapshots.get(root.identity), file.providers[root.identity]]);
    const now = this.#now();
    const out = chosen.map((root): AccountLimits => {
      const group = groups.get(root.identity) ?? null;
      const all = members(root);
      // The root's own capture first: on a tie it is the one shown.
      const capture = freshest([root, ...all.filter((m) => m !== root)].map(captureOf));
      const status = (id: string) => file.status[id];
      const signedIn = all.some((m) => !m.historyOnly && (status(m.identity)?.signed_in ?? true));
      return this.#account(root, group, capture, signedIn, groupError(all, status, capture), now);
    });
    return account === undefined ? out : (out[0] ?? null);
  }

  /**
   * The groups of roots on one subscription account, by member identity, among the enabled
   * roots: from the manual links and what auto-detection recorded in limits.json.
   */
  groups(): Map<string, AccountGroup> {
    const roots = this.#o.roots().filter((root) => root.enabled);
    const file = loadLimitsCache(this.#o.limitsPath);
    return resolveGroups(roots, this.#o.links?.() ?? NO_LINKS, file.pairs, file.groups);
  }

  #account(
    root: Root,
    group: AccountGroup | null,
    capture: Capture | null,
    signedIn: boolean,
    error: string | null,
    now: number,
  ): AccountLimits {
    const { spend } = this.#o;
    // Every root on the account spends from its limits: their store accounts together.
    const accts = (group?.members ?? [root])
      .map((member) => this.#storeAccount(member))
      .filter((id): id is number => id !== null);
    const pace = accts.length > 0 && spend !== null ? spend.pace(accts, PACE_MINUTES) : null;
    const capturedAt = capture === null ? 0 : capture.captured_at * 1000;
    const windows = orderedBuckets(capture).map(([kind, bucket]): LimitWindow => {
      const resetsAt = bucket.resets_at * 1000;
      const minutes = windowMinutes(kind, bucket);
      const windowMs = minutes === null ? null : minutes * 60_000;
      const utilization = now >= resetsAt ? 0 : bucket.used_percentage / 100;
      const rate =
        pace === null || spend === null
          ? null
          : windowPace(windowMs, resetsAt, now, pace, (from) => spend.rate(accts, from, now));
      return {
        kind,
        label: bucketLabel(kind, bucket),
        utilization,
        resets_at: resetsAt,
        window_s: minutes === null ? null : minutes * 60,
        pace_cost_per_h: rate?.costPerHour ?? null,
        pace_tokens_per_h: rate?.tokensPerHour ?? null,
        pace_basis: rate?.basis ?? null,
        projected_exhaustion_at:
          rate === null || spend === null
            ? null
            : projectExhaustion({
                utilization,
                capturedAt,
                resetsAt,
                windowMs,
                costPerHour: rate.costPerHour,
                now,
                spent: (from, to) => spend.cost(accts, from, to),
              }),
        stale_s: Math.max(0, Math.floor((now - capturedAt) / 1000)),
      };
    });
    return {
      account: {
        id: root.identity,
        label: root.label,
        provider: root.provider,
        signed_in: signedIn,
      },
      group:
        group === null
          ? null
          : {
              id: group.id,
              source: group.source,
              members: group.members.map((m) => ({ id: m.identity, label: m.label })),
              differs: group.differs,
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
   * when given, together with the other roots on its subscription account. Empty without a
   * store.
   */
  limitEvents(range: { from: number; to: number }, account?: string): LimitEvent[] {
    const db = this.#o.db;
    if (db === null) return [];
    if (account === undefined) return readLimitEvents(db, range);
    const root = this.#o.roots().find((r) => r.identity === account || r.label === account);
    if (root === undefined) return readLimitEvents(db, range, [account]);
    const group = this.groups().get(root.identity);
    return readLimitEvents(
      db,
      range,
      (group?.members ?? [root]).map((m) => m.identity),
    );
  }
}

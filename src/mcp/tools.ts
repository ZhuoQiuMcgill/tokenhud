import { BadArgument, parseBound } from "../commands/json.ts";
import { loadLimitsCache } from "../limits/cache.ts";
import { spendFromQueries } from "../limits/derive.ts";
import { type AccountLimits, Limits } from "../limits/index.ts";
import type { CodexSnapshots } from "../limits/snapshots.ts";
import type { DocumentRequest } from "../query/json.ts";
import { usageDocument } from "../query/json.ts";
import { calendarSlices, type Period, type PeriodName } from "../query/periods.ts";
import type { GroupBy, JsonUsageDocument } from "../query/types.ts";
import { isTimeZone, Zone } from "../query/tz.ts";
import type { Provider, Root } from "../sources/roots.ts";
import { type Resolved, type ResolveRequest, resolveAccount } from "./accounts.ts";
import { type LimitsView, limitsView, type ShouldWaitResult, shouldWait } from "./decide.ts";
import { ToolError } from "./errors.ts";
import type { Freshness } from "./freshness.ts";
import type { StoreHandle } from "./store.ts";
import { type WaitClock, type WaitResult, waitForReset } from "./wait.ts";

/**
 * The five MCP tools, independent of the protocol: `server.ts` registers them. Every
 * answer comes from T8 (limits, through `Limits` and an on-demand `refresh`) and T6 (usage,
 * through the shared query and JSON modules), so they match `tokenhud json` and the TUI.
 */

/** `limits` and `should_wait` ask T8 for data at most this old (ARCHITECTURE.md §7). */
export const LIMITS_MAX_AGE_S = 60;
/** The finest `usage` grouping per call (T6 critic Q1: fine queries over long ranges are slow). */
export const MAX_USAGE_GROUPS = 500;

export interface ToolsDeps {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The zone times are shown in. */
  zone: Zone;
  now: () => number;
  /** Every discovered root of both providers. */
  roots: () => readonly Root[];
  /** The store as it is (read-only); throws a `StoreError` when it cannot be read. */
  store: () => StoreHandle;
  /** Warnings that come with every usage answer (a malformed price overrides file). */
  priceWarnings: readonly string[];
  limitsPath: string;
  snapshots?: CodexSnapshots;
  /** T8's on-demand refresh (`LimitsService.refresh`), within its rate limits. */
  refresh: (account: string, maxAgeS: number) => Promise<unknown>;
  /** Ingest once if the store is stale and the single-writer lock is free. */
  freshen: () => Promise<Freshness>;
  hasTranscript: (root: Root, sessionId: string) => boolean;
  clock: WaitClock;
  /** Called once per tool call, with the account label it was about (heartbeat). */
  record?: (tool: string, account: string | null) => void;
}

export interface AccountArgs {
  account?: string | undefined;
  provider?: Provider | undefined;
}

export interface UsageArgs {
  period: PeriodName | "custom";
  since?: string | undefined;
  until?: string | undefined;
  group_by?: GroupBy | undefined;
  account?: string | undefined;
  provider?: Provider | undefined;
  tz?: string | undefined;
}

export interface AccountEntry {
  /** The root identity; any tool's `account` accepts it, or the label. */
  id: string;
  label: string;
  provider: Provider;
  signed_in: boolean;
  last_seen: string | null;
  is_current: boolean;
}

/** `projected_exhaustion_at` must always be labelled an estimate (T8). */
export const PROJECTION_NOTE =
  "projected_exhaustion_at is an estimate from this machine's recent spend pace";

export class Tools {
  readonly #d: ToolsDeps;

  constructor(deps: ToolsDeps) {
    this.#d = deps;
  }

  #roots(): Root[] {
    return this.#d.roots().filter((r) => r.enabled);
  }

  /** Store account id and newest usage per root identity. */
  #storeAccounts(store: StoreHandle): Map<string, { id: number; lastSeen: number | null }> {
    const out = new Map<string, { id: number; lastSeen: number | null }>();
    if (store.db === null) return out;
    const seen = new Map(store.queries.accounts().map((a) => [a.id, a.lastSeen]));
    for (const row of store.db
      .query<{ id: bigint; provider: string; identity: string }, []>(
        "SELECT id, provider, identity FROM accounts",
      )
      .all()) {
      const id = Number(row.id);
      out.set(`${row.provider}:${row.identity}`, { id, lastSeen: seen.get(id) ?? null });
    }
    return out;
  }

  #resolve(req: ResolveRequest, store: StoreHandle, roots: readonly Root[]): Resolved {
    let accounts: Map<string, { id: number; lastSeen: number | null }> | null = null;
    return resolveAccount(req, {
      env: this.#d.env,
      home: this.#d.home,
      roots,
      hasTranscript: this.#d.hasTranscript,
      lastSeen: (root) => {
        accounts ??= this.#storeAccounts(store);
        return accounts.get(`${root.provider}:${root.identity}`)?.lastSeen ?? null;
      },
    });
  }

  #limits(store: StoreHandle): Limits {
    return new Limits({
      limitsPath: this.#d.limitsPath,
      roots: () => this.#d.roots(),
      db: store.db,
      spend: store.db === null ? null : spendFromQueries(store.queries),
      ...(this.#d.snapshots !== undefined && { snapshots: this.#d.snapshots }),
      now: this.#d.now,
    });
  }

  /** The account's limits after a T8 refresh (when `refresh`) of data older than 60 s. */
  async #accountLimits(root: Root, refresh: boolean): Promise<AccountLimits> {
    if (refresh) await this.#d.refresh(root.identity, LIMITS_MAX_AGE_S);
    const limits = this.#limits(this.#d.store()).getLimits(root.identity);
    if (limits === null) {
      throw new ToolError("unknown_account", `account '${root.label}' is no longer enabled`);
    }
    return limits;
  }

  async limits(args: AccountArgs): Promise<LimitsView & { note: string }> {
    const resolved = this.#resolve(args, this.#d.store(), this.#roots());
    this.#d.record?.("limits", resolved.root.label);
    const limits = await this.#accountLimits(resolved.root, true);
    return { ...limitsView(resolved, limits, this.#d.zone), note: PROJECTION_NOTE };
  }

  async shouldWait(
    args: AccountArgs & { min_headroom?: number; window?: string; estimated_cost?: number },
  ): Promise<ShouldWaitResult> {
    const store = this.#d.store();
    const resolved = this.#resolve(args, store, this.#roots());
    this.#d.record?.("should_wait", resolved.root.label);
    const limits = await this.#accountLimits(resolved.root, true);
    const acct = this.#storeAccounts(store).get(
      `${resolved.root.provider}:${resolved.root.identity}`,
    )?.id;
    const spend = store.db === null ? null : spendFromQueries(store.queries);
    return shouldWait(
      limits,
      {
        min_headroom: args.min_headroom,
        window: args.window,
        estimated_cost: args.estimated_cost,
      },
      this.#d.now(),
      this.#d.zone,
      (from, to) => (acct === undefined || spend === null ? null : spend.cost(acct, from, to)),
    );
  }

  async waitForReset(
    args: AccountArgs & {
      window?: string;
      max_wait_s: number;
      until_utilization_below?: number;
    },
    signal: AbortSignal,
    progress: ((progress: number, total: number, message: string) => Promise<void>) | null,
  ): Promise<WaitResult> {
    const resolved = this.#resolve(args, this.#d.store(), this.#roots());
    this.#d.record?.("wait_for_reset", resolved.root.label);
    return waitForReset(
      {
        window: args.window,
        max_wait_s: args.max_wait_s,
        until_utilization_below: args.until_utilization_below,
      },
      {
        clock: this.#d.clock,
        zone: this.#d.zone,
        signal,
        progress,
        check: (refresh) => this.#accountLimits(resolved.root, refresh),
      },
    );
  }

  async usage(args: UsageArgs): Promise<JsonUsageDocument & { stale_s: number | null }> {
    const tz = args.tz ?? this.#d.zone.name;
    if (!isTimeZone(tz)) {
      throw new ToolError(
        "bad_argument",
        `unknown time zone '${tz}' (use an IANA name such as Europe/Paris)`,
      );
    }
    const zone = Zone.of(tz);
    const custom = args.since !== undefined || args.until !== undefined;
    if (args.period !== "custom" && custom) {
      throw new ToolError("bad_argument", "since and until need period 'custom'");
    }
    let period: Period;
    const now = this.#d.now();
    if (args.period === "custom") {
      if (args.since === undefined)
        throw new ToolError("bad_argument", "period 'custom' needs since");
      try {
        const since = parseBound("since", args.since, zone, false);
        const until =
          args.until === undefined ? now + 1 : parseBound("until", args.until, zone, true);
        if (until <= since) throw new BadArgument("until must be after since");
        period = { since, until };
      } catch (error) {
        if (error instanceof BadArgument) throw new ToolError("bad_argument", error.message);
        throw error;
      }
    } else {
      period = args.period;
    }

    const freshness = await this.#d.freshen();
    const store = this.#d.store();
    const roots = this.#roots();
    const named = args.account === undefined ? null : this.#storeIds(args.account, store, roots);
    this.#d.record?.("usage", named?.label ?? null);
    const req: DocumentRequest = {
      period,
      tz: zone.name,
      ...(named !== null && { accounts: named.ids }),
      ...(args.provider !== undefined && { providers: [args.provider] }),
    };
    const groupBy = args.group_by ?? null;
    if (groupBy === "day" || groupBy === "week" || groupBy === "month") {
      const groups = calendarSlices(store.queries.range(req), groupBy, zone).length;
      if (groups > MAX_USAGE_GROUPS) {
        throw new ToolError(
          "bad_argument",
          `group_by '${groupBy}' over this period gives ${groups} groups; at most ${MAX_USAGE_GROUPS} per call: use a coarser group_by or a shorter period`,
        );
      }
    }
    const warnings = [...this.#d.priceWarnings];
    if (freshness.warning !== null) warnings.push(freshness.warning);
    const doc = usageDocument(store.queries, req, groupBy, { now, warnings });
    return { ...doc, stale_s: freshness.stale_s };
  }

  /**
   * The store account ids an `account` argument names: a root (label or identity), else a
   * store-only account (one imported from cc-usage whose root is gone) by label or id.
   */
  #storeIds(
    account: string,
    store: StoreHandle,
    roots: readonly Root[],
  ): { ids: number[]; label: string } {
    const wanted = account.trim();
    const lower = wanted.toLowerCase();
    const root =
      roots.find((r) => r.identity === wanted) ??
      roots.find((r) => r.label.toLowerCase() === lower);
    if (root !== undefined) {
      // A root without usage yet has no store account: its usage is empty.
      const id = this.#storeAccounts(store).get(`${root.provider}:${root.identity}`)?.id;
      return { ids: id === undefined ? [] : [id], label: root.label };
    }
    const known = store.queries.accountList();
    const byStore = known.filter(
      (a) => a.label.toLowerCase() === lower || (/^\d+$/.test(wanted) && a.id === Number(wanted)),
    );
    if (byStore.length > 0)
      return { ids: byStore.map((a) => a.id), label: byStore[0]?.label ?? wanted };
    const labels = [...new Set([...roots.map((r) => r.label), ...known.map((a) => a.label)])];
    throw new ToolError(
      "unknown_account",
      `unknown account '${wanted.slice(0, 80)}' (accounts: ${labels.join(", ") || "none"})`,
    );
  }

  async accounts(): Promise<{ accounts: AccountEntry[] }> {
    this.#d.record?.("accounts", null);
    const roots = this.#roots();
    // An account never checked has no sign-in state yet: check each once, through T8 (no
    // request for one without a credential file; history-only roots are never fetched).
    const status = loadLimitsCache(this.#d.limitsPath).status;
    await Promise.all(
      roots
        .filter((r) => !r.historyOnly && status[r.identity] === undefined)
        .map((r) => this.#d.refresh(r.identity, 0)),
    );
    const store = this.#d.store();
    let current: string | null = null;
    try {
      current = this.#resolve({}, store, roots).root.identity;
    } catch {
      // No current Claude account (disabled, or an unknown CLAUDE_CONFIG_DIR).
    }
    const byIdentity = new Map(
      this.#limits(store)
        .getLimits()
        .map((l) => [l.account.id, l]),
    );
    const seen = this.#storeAccounts(store);
    return {
      accounts: roots.map((root) => {
        const lastSeen = seen.get(`${root.provider}:${root.identity}`)?.lastSeen ?? null;
        return {
          id: root.identity,
          label: root.label,
          provider: root.provider,
          signed_in: byIdentity.get(root.identity)?.account.signed_in ?? !root.historyOnly,
          last_seen: lastSeen === null ? null : this.#d.zone.iso(lastSeen),
          is_current: root.identity === current,
        };
      }),
    };
  }
}

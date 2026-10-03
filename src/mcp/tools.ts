import { BadArgument, parseBound } from "../commands/json.ts";
import { loadLimitsCache } from "../limits/cache.ts";
import { spendFromQueries } from "../limits/derive.ts";
import type { ManualLinks } from "../limits/groups.ts";
import { type AccountLimits, Limits } from "../limits/index.ts";
import type { CodexSnapshots } from "../limits/snapshots.ts";
import type { DocumentRequest } from "../query/json.ts";
import { usageDocument } from "../query/json.ts";
import { calendarSlices, type Period, type PeriodName } from "../query/periods.ts";
import type { GroupBy, JsonUsageDocument } from "../query/types.ts";
import { isTimeZone, Zone } from "../query/tz.ts";
import type { Provider, Root } from "../sources/roots.ts";
import { StoreError } from "../store/errors.ts";
import { type Resolved, type ResolveRequest, resolveAccount } from "./accounts.ts";
import {
  type LimitsView,
  limitsView,
  type ShouldWaitArgs,
  type ShouldWaitResult,
  type Spent,
  shouldWait,
} from "./decide.ts";
import { ToolError } from "./errors.ts";
import type { Freshness } from "./freshness.ts";
import type { StoreHandle } from "./store.ts";
import { type WaitArgs, type WaitClock, type WaitResult, waitForReset } from "./wait.ts";

/**
 * The five MCP tools, independent of the protocol: `server.ts` registers them. Every
 * answer comes from T8 (limits, through `Limits` and an on-demand `refresh`) and T6 (usage,
 * through the shared query and JSON modules), so they match `tokenhud json` and the TUI.
 *
 * Limits live in limits.json, not in the usage store, which only adds the spend pace,
 * projections and last-seen times. So `limits`, `should_wait`, `wait_for_reset` and
 * `accounts` still answer when the store can't be read, without those; only `usage` fails.
 */

/** `limits` and `should_wait` ask T8 for data at most this old (ARCHITECTURE.md §7). */
export const LIMITS_MAX_AGE_S = 60;
/** The finest `usage` grouping per call (T6 critic Q1: fine queries over long ranges are slow). */
export const MAX_USAGE_GROUPS = 500;

export const STORE_DOWN =
  "the usage store can't be read, so the spend pace and projections are unknown (run `tokenhud doctor`)";

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
  /** Manual account links (config `same_account`, `separate_accounts`). */
  links?: () => ManualLinks;
  /** T8's on-demand refresh (`LimitsService.refresh`), within its rate limits. */
  refresh: (account: string, maxAgeS: number) => Promise<unknown>;
  /** Ingest once if the store is stale and the single-writer lock is free. */
  freshen: () => Promise<Freshness>;
  hasTranscript: (root: Root, sessionId: string) => boolean;
  clock: WaitClock;
  /** Called once per tool call, with the account label it was about (heartbeat). */
  record?: (tool: string, account: string | null) => void;
  /** Detail of a failure the answer works around (stderr). */
  log?: (message: string) => void;
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
  /**
   * The id of the roots on its subscription account (T16), shared by every one of them;
   * null for a root alone.
   */
  group: string | null;
  /** Null until the account's limits are first checked (`limits` or the TUI). */
  signed_in: boolean | null;
  last_seen: string | null;
  is_current: boolean;
}

/**
 * `projected_exhaustion_at` must always be labelled an estimate (T8), a weekly one coarse
 * (T18); so must the seconds until it (T26).
 */
export const PROJECTION_NOTE =
  "projected_exhaustion_at, and projected_exhaustion_in_s (the seconds until it), are an estimate from this machine's spend pace: the last 30 minutes' (pace_basis 30m) or, for a weekly window, its average since the window began (window_avg); a weekly window's instant is coarse, good to about a part of a day";

type StoreAccounts = Map<string, { id: number; lastSeen: number | null }>;

export class Tools {
  readonly #d: ToolsDeps;

  constructor(deps: ToolsDeps) {
    this.#d = deps;
  }

  #roots(): Root[] {
    return this.#d.roots().filter((r) => r.enabled);
  }

  #storeFailed(error: unknown): void {
    if (!(error instanceof StoreError)) throw error;
    this.#d.log?.(`store error: ${error.message}`);
  }

  /** The store, or null when it can't be read (logged): limits don't need it. */
  #optionalStore(): StoreHandle | null {
    try {
      return this.#d.store();
    } catch (error) {
      this.#storeFailed(error);
      return null;
    }
  }

  /** Store account id and newest usage per `provider:identity`; empty without a store. */
  #storeAccounts(store: StoreHandle | null): StoreAccounts {
    const out: StoreAccounts = new Map();
    if (store === null || store.db === null) return out;
    const db = store.db;
    try {
      const seen = new Map(store.queries.accounts().map((a) => [a.id, a.lastSeen]));
      for (const row of db
        .query<{ id: bigint; provider: string; identity: string }, []>(
          "SELECT id, provider, identity FROM accounts",
        )
        .all()) {
        const id = Number(row.id);
        out.set(`${row.provider}:${row.identity}`, { id, lastSeen: seen.get(id) ?? null });
      }
    } catch (error) {
      this.#storeFailed(error);
      out.clear();
    }
    return out;
  }

  #resolve(req: ResolveRequest, store: StoreHandle | null, roots: readonly Root[]): Resolved {
    let accounts: StoreAccounts | null = null;
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

  #limits(store: StoreHandle | null): Limits {
    const db = store?.db ?? null;
    return new Limits({
      limitsPath: this.#d.limitsPath,
      roots: () => this.#d.roots(),
      db,
      spend: store === null || db === null ? null : spendFromQueries(store.queries),
      ...(this.#d.snapshots !== undefined && { snapshots: this.#d.snapshots }),
      ...(this.#d.links !== undefined && { links: this.#d.links }),
      now: this.#d.now,
    });
  }

  /** T8's limits of every account (or one), without the store if reading it fails. */
  #readLimits<T>(read: (limits: Limits) => T): { value: T; storeDown: boolean } {
    const store = this.#optionalStore();
    if (store !== null) {
      try {
        return { value: read(this.#limits(store)), storeDown: false };
      } catch (error) {
        this.#storeFailed(error);
      }
    }
    return { value: read(this.#limits(null)), storeDown: true };
  }

  /** The account's limits, after a T8 refresh (when `refresh`) of data older than 60 s. */
  async #accountLimits(
    root: Root,
    refresh: boolean,
  ): Promise<{ limits: AccountLimits; storeDown: boolean }> {
    if (refresh) await this.#d.refresh(root.identity, LIMITS_MAX_AGE_S);
    const { value, storeDown } = this.#readLimits((l) => l.getLimits(root.identity));
    if (value === null) {
      throw new ToolError("unknown_account", `account '${root.label}' is no longer enabled`);
    }
    return { limits: value, storeDown };
  }

  async limits(args: AccountArgs): Promise<LimitsView & { note: string; warnings: string[] }> {
    const resolved = this.#resolve(args, this.#optionalStore(), this.#roots());
    this.#d.record?.("limits", resolved.root.label);
    const { limits, storeDown } = await this.#accountLimits(resolved.root, true);
    return {
      ...limitsView(resolved, limits, this.#d.zone, this.#d.now()),
      note: PROJECTION_NOTE,
      warnings: storeDown ? [STORE_DOWN] : [],
    };
  }

  async shouldWait(args: AccountArgs & ShouldWaitArgs): Promise<ShouldWaitResult> {
    const resolved = this.#resolve(args, this.#optionalStore(), this.#roots());
    this.#d.record?.("should_wait", resolved.root.label);
    const { limits, storeDown } = await this.#accountLimits(resolved.root, true);
    const store = storeDown ? null : this.#optionalStore();
    // Every root on the account spends from its limits (T16).
    const accounts = this.#storeAccounts(store);
    const accts = (limits.group?.members.map((m) => m.id) ?? [resolved.root.identity])
      .map((id) => accounts.get(`${resolved.root.provider}:${id}`)?.id)
      .filter((id): id is number => id !== undefined);
    const spend = store === null ? null : spendFromQueries(store.queries);
    const spent: Spent = (from, to) => {
      if (accts.length === 0 || spend === null) return null;
      try {
        return spend.cost(accts, from, to);
      } catch (error) {
        this.#storeFailed(error);
        return null;
      }
    };
    const verdict = shouldWait(
      limits,
      {
        min_headroom: args.min_headroom,
        window: args.window,
        estimated_cost: args.estimated_cost,
        model: args.model,
      },
      this.#d.now(),
      this.#d.zone,
      spent,
    );
    return storeDown ? { ...verdict, reason: `${verdict.reason}; ${STORE_DOWN}` } : verdict;
  }

  async waitForReset(
    args: AccountArgs & WaitArgs,
    signal: AbortSignal,
    progress: ((progress: number, total: number, message: string) => Promise<void>) | null,
  ): Promise<WaitResult> {
    const resolved = this.#resolve(args, this.#optionalStore(), this.#roots());
    this.#d.record?.("wait_for_reset", resolved.root.label);
    return waitForReset(
      {
        window: args.window,
        max_wait_s: args.max_wait_s,
        until_utilization_below: args.until_utilization_below,
        model: args.model,
      },
      {
        clock: this.#d.clock,
        zone: this.#d.zone,
        signal,
        progress,
        check: async (refresh) => (await this.#accountLimits(resolved.root, refresh)).limits,
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

    // Everything that can refuse the call is checked before a stale store is refreshed, so
    // a request that will be refused never triggers an ingest pass.
    const roots = this.#roots();
    const groupBy = args.group_by ?? null;
    const request = (store: StoreHandle) => {
      const named = args.account === undefined ? null : this.#storeIds(args.account, store, roots);
      const req: DocumentRequest = {
        period,
        tz: zone.name,
        ...(named !== null && { accounts: named.ids }),
        ...(args.provider !== undefined && { providers: [args.provider] }),
      };
      if (groupBy === "day" || groupBy === "week" || groupBy === "month") {
        const groups = calendarSlices(store.queries.range(req), groupBy, zone).length;
        if (groups > MAX_USAGE_GROUPS) {
          throw new ToolError(
            "bad_argument",
            `group_by '${groupBy}' over this period gives ${groups} groups; at most ${MAX_USAGE_GROUPS} per call: use a coarser group_by or a shorter period`,
          );
        }
      }
      return { req, label: named?.label ?? null };
    };
    const checked = request(this.#d.store());
    this.#d.record?.("usage", checked.label);
    const freshness = await this.#d.freshen();
    // The pass may have created the store or new accounts: build the request again.
    const store = this.#d.store();
    const { req } = request(store);
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

  /**
   * Every enabled account from what is cached: no request, no app-server, no sign-in
   * refresh. `signed_in` is known once T8 has checked the account (its status in
   * limits.json, or that of a root on the same subscription account), for a history-only
   * root, or for a Codex account with limits read here (T8 counts those as signed in);
   * otherwise null.
   */
  async accounts(): Promise<{ accounts: AccountEntry[] }> {
    this.#d.record?.("accounts", null);
    const roots = this.#roots();
    const store = this.#optionalStore();
    let current: string | null = null;
    try {
      current = this.#resolve({}, store, roots).root.identity;
    } catch {
      // No current Claude account (disabled, or an unknown CLAUDE_CONFIG_DIR).
    }
    const status = loadLimitsCache(this.#d.limitsPath).status;
    const all = this.#readLimits((l) => l.getLimits()).value;
    const byIdentity = new Map(all.map((l) => [l.account.id, l]));
    const seen = this.#storeAccounts(store);
    return {
      accounts: roots.map((root) => {
        const limits = byIdentity.get(root.identity);
        const members = limits?.group?.members.map((m) => m.id) ?? [root.identity];
        const known =
          root.historyOnly ||
          members.some((id) => status[id] !== undefined) ||
          (root.provider === "codex" && (limits?.source === "rollout" || limits?.source === "rpc"));
        const lastSeen = seen.get(`${root.provider}:${root.identity}`)?.lastSeen ?? null;
        return {
          id: root.identity,
          label: root.label,
          provider: root.provider,
          group: limits?.group?.id ?? null,
          signed_in: known ? (limits?.account.signed_in ?? !root.historyOnly) : null,
          last_seen: lastSeen === null ? null : this.#d.zone.iso(lastSeen),
          is_current: root.identity === current,
        };
      }),
    };
  }
}

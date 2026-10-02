// View models from the query layer. Runs in the view-model Worker (and in `--once`), never
// on the interactive UI thread. Each view model comes with the time ranges it depends on,
// so an ingest change recomputes only the views it touches, and the instant it goes out of
// date by the clock alone (a new day, a rolling window's next minute).

import type { Window } from "../../config.ts";
import type { PriceTable } from "../../pricing/table.ts";
import type { UsageQueries } from "../../query/engine.ts";
import { type Period, resolvePeriod } from "../../query/periods.ts";
import type { Range, Usage } from "../../query/types.ts";
import type { Zone } from "../../query/tz.ts";
import { type AccountSources, computeAccounts } from "./accounts.ts";
import { type AccountEvent, computeHistory } from "./history.ts";
import { computeModels } from "./models.ts";
import { computeOverview } from "./overview.ts";
import type { AccountInfo, Amount, ViewId } from "./types.ts";

/** Rolling windows (1h, 5h, 24h) move with the clock; their views refresh this often. */
export const ROLLING_REFRESH_MS = 60_000;
/** Every range: a view of all-time data depends on any change. */
export const ALL_TIME: Range = { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY };

export interface ComputeContext {
  readonly q: UsageQueries;
  readonly now: number;
  readonly zone: Zone;
  /** Every account in the store, with display labels. */
  readonly accounts: readonly AccountInfo[];
  /** An account id, or null for all. */
  readonly scope: number | null;
  readonly window: Window;
  /** T8's limit events with `from <= at < to`, oldest first; none when absent. */
  readonly limitEvents?: (range: Range) => readonly AccountEvent[];
  /** The table the queries price with: the Models view's rate cards. */
  readonly prices: PriceTable;
  /**
   * Roots, limits and MCP activity, for the Accounts view and the Overview's cards and
   * agents; null where none are read (the Overview then says its limits are unknown).
   */
  readonly sources: AccountSources | null;
}

export interface Computed<V> {
  readonly vm: V;
  /** The store ranges the view reads; a change outside them leaves it as it is. */
  readonly deps: readonly Range[];
  /** When the clock alone makes it stale. */
  readonly validUntil: number;
}

export const amount = (u: Usage): Amount => ({
  cost: u.cost,
  tokens: u.tokens.total,
  pricedShare: u.coverage.pricedShare,
  estimatedCost: u.estimatedCost,
});

export function scoped(ctx: ComputeContext): { accounts?: readonly number[] } {
  return ctx.scope === null ? {} : { accounts: [ctx.scope] };
}

export function periodRange(ctx: ComputeContext, period: Period): Range {
  return period === "all" ? ALL_TIME : resolvePeriod(period, ctx.now, ctx.zone, null);
}

export const COMPUTE: { readonly [V in ViewId]: (ctx: ComputeContext) => Computed<unknown> } = {
  overview: computeOverview,
  history: computeHistory,
  models: computeModels,
  accounts: computeAccounts,
};

/** Whether two half-open ranges share an instant. */
export function overlaps(a: Range, b: Range): boolean {
  return a.from < b.to && b.from < a.to;
}

/**
 * The views a change touches: those reading a range that overlaps it, among those whose
 * scope includes one of the changed accounts (`accounts` null: unknown, so every scope).
 */
export function affectedViews(
  views: ReadonlyMap<ViewId, { readonly deps: readonly Range[] }>,
  change: Range,
  accounts: readonly number[] | null,
  scope: number | null,
): ViewId[] {
  if (accounts !== null && scope !== null && !accounts.includes(scope)) {
    // The Accounts view lists every account whatever the scope.
    return views.has("accounts") ? ["accounts"] : [];
  }
  const out: ViewId[] = [];
  for (const [id, { deps }] of views) if (deps.some((r) => overlaps(r, change))) out.push(id);
  return out;
}

/** A `changed` event's inclusive timestamp span as a half-open range. */
export function changeRange(fromTs: number, toTs: number): Range {
  return { from: fromTs, to: toTs + 1 };
}

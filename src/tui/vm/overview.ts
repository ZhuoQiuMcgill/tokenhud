// The Overview's view model ("limits first", T11): a limits card per enabled account (one per
// subscription account, for roots that share one: T16), the MCP agents, spend, activity over
// 5 h / 24 h / 7 d, the day's top models and the week's limit events. Computed in the
// view-model Worker (and by `--once`), never on the UI thread.

import { projectAtReset, type SpendSource, spendFromQueries } from "../../limits/derive.ts";
import { dedupeEvents } from "../../limits/events.ts";
import type { AccountLimits, LimitWindow } from "../../limits/index.ts";
import { windowScope } from "../../mcp/decide.ts";
import type { Range } from "../../query/types.ts";
import {
  ALL_TIME,
  amount,
  type ComputeContext,
  type Computed,
  ROLLING_REFRESH_MS,
  scoped,
  sharedGroups,
} from "./compute.ts";
import { modelName } from "./models.ts";
import type {
  AccountInfo,
  ActivitySeries,
  ActivityWindow,
  Amount,
  LimitCard,
  LimitMeter,
  OverviewEvent,
  OverviewVM,
  SpendColumn,
  TopModel,
  Verdict,
} from "./types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Each chart's span and finest bucket. The view sums neighbouring buckets into the widest
 * whole number of columns that fits (15 min on a 105-column screen, 20 min at 80), so the
 * finest bucket is the one that divides into the most useful sizes.
 */
export const ACTIVITY: Readonly<Record<ActivityWindow, { span: number; bucket: number }>> = {
  "5h": { span: 5 * HOUR, bucket: MINUTE },
  "24h": { span: DAY, bucket: 5 * MINUTE },
  "7d": { span: 7 * DAY, bucket: HOUR },
};
/** The limit windows a card shows, by length: 5 hours and a week. */
const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 24 * 3600;
const TOP_MODELS = 5;
const EVENT_SPAN = 7 * DAY;
/**
 * A weekly window projected to end at or above this share, without reaching 100 %, is
 * called out as "week ends ~N%" rather than "safe until reset". It is the threshold of
 * T8's `passed_80` event.
 */
export const WEEK_WARNING = 0.8;

/** A chart's range: whole buckets, the last one holding now. */
export function activityRange(now: number, window: ActivityWindow): Range {
  const { span, bucket } = ACTIVITY[window];
  const to = (Math.floor(now / bucket) + 1) * bucket;
  return { from: to - span, to };
}

function series(ctx: ComputeContext, window: ActivityWindow): ActivitySeries {
  const range = activityRange(ctx.now, window);
  const { span, bucket } = ACTIVITY[window];
  const activity = ctx.q.activity({ range, buckets: span / bucket, ...scoped(ctx) });
  return {
    from: range.from,
    bucketMs: bucket,
    cost: activity.buckets.map((b) => b.cost),
    tokens: activity.buckets.map((b) => b.tokens),
  };
}

/**
 * What the pace means for the account-wide windows (`Verdict`), in this order: a window at
 * 100 % now; the earliest projected to reach it; no spend at all; a weekly window projected
 * to end at `WEEK_WARNING` or more; every projection lasting to its reset; else too little
 * data to say. All but the first are T8's estimates.
 */
function verdict(
  windows: readonly LimitWindow[],
  limits: AccountLimits,
  accts: readonly number[],
  pace: number,
  spend: SpendSource,
  now: number,
): Verdict {
  const full = windows.filter((w) => w.utilization >= 1 && w.resets_at > now);
  // Work resumes only once every full window has reset.
  if (full.length > 0) return { kind: "full", until: Math.max(...full.map((w) => w.resets_at)) };
  const hits = windows
    .map((w) => w.projected_exhaustion_at)
    .filter((p): p is number => typeof p === "number");
  if (hits.length > 0) return { kind: "hits", at: Math.min(...hits) };
  if (!(pace > 0)) return { kind: "idle" };
  const week = windows.find((w) => w.window_s === WEEK_S);
  if (week !== undefined && accts.length > 0 && limits.as_of !== null) {
    const end = projectAtReset({
      utilization: week.utilization,
      capturedAt: limits.as_of,
      resetsAt: week.resets_at,
      windowMs: WEEK_S * 1000,
      costPerHour: pace,
      now,
      spent: (from, to) => spend.cost(accts, from, to),
    });
    if (end !== null && end >= WEEK_WARNING) return { kind: "week", utilization: end };
  }
  if (windows.some((w) => w.projected_exhaustion_at === "safe")) return { kind: "safe" };
  return { kind: "unknown" };
}

/**
 * A card for an account: a root's, or one for every root on a subscription account they
 * share (`limits.group`), titled with their labels joined by " + ".
 */
function card(
  limits: AccountLimits,
  byIdentity: ReadonlyMap<string, AccountInfo>,
  spend: SpendSource,
  now: number,
): LimitCard {
  // Account-wide windows only: a model's own weekly limit binds that model alone (T9).
  const windows = limits.account.signed_in
    ? limits.windows.filter((w) => windowScope(limits.account.provider, w) === null)
    : [];
  const meter = (seconds: number): LimitMeter | null => {
    const w = windows.find((x) => x.window_s === seconds);
    return w === undefined ? null : { utilization: w.utilization, resetsAt: w.resets_at };
  };
  const pace = { cost: limits.pace?.cost_per_h ?? 0, tokens: limits.pace?.tokens_per_h ?? 0 };
  const members = limits.group?.members ?? [{ id: limits.account.id, label: limits.account.label }];
  const stored = members.map((m) => byIdentity.get(m.id));
  const accts = stored.flatMap((a) => (a === undefined ? [] : [a.id]));
  return {
    account: accts[0] ?? null,
    // The labels every other view shows (a configured one, else the store's).
    label: members.map((m, i) => stored[i]?.label ?? m.label).join(" + "),
    provider: limits.account.provider,
    signedIn: limits.account.signed_in,
    fiveHour: meter(FIVE_HOURS_S),
    week: meter(WEEK_S),
    pace,
    verdict: verdict(windows, limits, accts, pace.cost, spend, now),
    capturedAt: limits.as_of,
  };
}

function topModels(ctx: ComputeContext, day: Range, dayTokens: number) {
  const models = ctx.q.byModel({ range: day, ...scoped(ctx) }).map(
    (m): TopModel => ({
      ...amount(m.usage),
      model: m.model,
      name: modelName(m.model),
      tier: m.tier,
      share: m.share,
      status: m.status,
    }),
  );
  const byTokens = [...models]
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost)
    .slice(0, TOP_MODELS)
    .map((m) => ({ ...m, share: dayTokens > 0 ? m.tokens / dayTokens : 0 }));
  return { byCost: models.slice(0, TOP_MODELS), byTokens };
}

export function computeOverview(ctx: ComputeContext): Computed<OverviewVM> {
  const { q } = ctx;
  const filter = scoped(ctx);
  const spend = {} as Record<SpendColumn, Amount>;
  let pricedShare = 1;
  for (const period of ["1h", "5h", "today", "this_week", "this_month", "all"] as const) {
    const totals = q.totals({ period, ...filter });
    spend[period] = amount(totals.usage);
    if (period === "all") pricedShare = totals.usage.coverage.pricedShare;
  }
  const activity = {
    "5h": series(ctx, "5h"),
    "24h": series(ctx, "24h"),
    "7d": series(ctx, "7d"),
  };
  const day = activityRange(ctx.now, "24h");
  const dayTokens = activity["24h"].tokens.reduce((a, b) => a + b, 0);
  const top = topModels(ctx, day, dayTokens);

  const byIdentity = new Map(ctx.accounts.map((a) => [a.identity, a]));
  const byId = new Map(ctx.accounts.map((a) => [a.id, a]));
  const scope = ctx.accounts.find((a) => a.id === ctx.scope) ?? null;
  // The one limits source the Accounts view reads too (T13's); null: not known yet.
  const limits = ctx.sources?.limits ?? null;
  let cards: LimitCard[] | null = null;
  // An MCP call names its account by the label it resolved to: the root's.
  const scopeLabels = new Set(scope === null ? [] : [scope.label]);
  if (limits !== null) {
    const source = spendFromQueries(q);
    // One card per subscription account: roots that share one show as its first member.
    const groups = new Set<string>();
    const shown = limits.getLimits().filter((l) => {
      const members = l.group?.members.map((m) => m.id) ?? [l.account.id];
      if (scope !== null && !members.includes(scope.identity)) return false;
      if (l.group === null) return true;
      if (groups.has(l.group.id)) return false;
      groups.add(l.group.id);
      return true;
    });
    if (scope !== null) {
      for (const l of shown) {
        for (const m of l.group?.members ?? [l.account]) {
          scopeLabels.add(byIdentity.get(m.id)?.label ?? m.label);
          scopeLabels.add(m.label);
        }
      }
    }
    cards = shown.map((l) => card(l, byIdentity, source, ctx.now));
  }
  // The store's limit events, read as History reads them (T12's), newest first; one per
  // window instance for roots on one account, labelled as their card is.
  const shared = sharedGroups(ctx);
  const inScope = new Set(
    scope === null ? [] : (shared.get(scope.identity)?.identities ?? [scope.identity]),
  );
  const events: OverviewEvent[] = dedupeEvents(
    ctx.limitEvents?.({ from: ctx.now - EVENT_SPAN, to: ctx.now + 1 }) ?? [],
    (identity) => shared.get(identity)?.id ?? null,
  )
    .filter((e) => scope === null || inScope.has(e.account.id))
    .reverse()
    .map((e) => ({
      at: e.at,
      account:
        shared.get(e.account.id)?.label ??
        (e.acct === null ? undefined : byId.get(e.acct)?.label) ??
        e.account.label,
      kind: e.kind,
      window: e.label,
      resetsAt: e.resets_at,
      resumedAt: e.resumed_at,
    }));
  const mcp = ctx.sources?.mcp ?? null;
  const agents =
    mcp === null || (mcp.servers === 0 && mcp.latest.length === 0)
      ? null
      : {
          servers: mcp.servers,
          calls: mcp.latest
            .filter((c) => scope === null || (c.account !== null && scopeLabels.has(c.account)))
            .map((c) => ({ tool: c.tool, account: c.account, at: c.at })),
        };

  const vm: OverviewVM = {
    asOf: ctx.now,
    cards,
    agents,
    spend,
    activity,
    topModels: top.byCost,
    topModelsByTokens: top.byTokens,
    events,
    pricedShare,
  };
  return {
    vm,
    deps: [ALL_TIME],
    // Countdowns, the pace and the rolling columns move with the clock.
    validUntil: ctx.now + ROLLING_REFRESH_MS,
  };
}

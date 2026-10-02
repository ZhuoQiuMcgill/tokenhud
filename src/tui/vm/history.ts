// History's view model (T12), computed in the view-model Worker: the heat map's days, the
// period table's weeks and months, and each day's models, accounts and limit events. The
// view only picks from it, so switching grouping, moving the selection or filtering never
// queries (ARCHITECTURE §9).
//
// Weeks start on Monday and months on the 1st, in the display zone (the user's ruling: no
// rolling 7 or 30 days), so "this week" and "this month" are the last week and month here.

import type { Database } from "bun:sqlite";
import { type LimitEvent, readLimitEvents } from "../../limits/events.ts";
import type { Range, Usage } from "../../query/types.ts";
import { addDays, firstOfMonth, formatDate, mondayOf } from "../../query/tz.ts";
import type { ComputeContext, Computed } from "./compute.ts";
import type { StoreAccount } from "./session.ts";
import type {
  HistoryDay,
  HistoryEvent,
  HistoryPeriod,
  HistoryShare,
  HistoryTotal,
  HistoryVM,
} from "./types.ts";

const HISTORY_WEEKS = 26;
/** The "vs average" baseline is the daily average over this many days before today. */
const AVERAGE_DAYS = 30;

/** A limit event with its account's store id (null when the store has no such account). */
export interface AccountEvent extends LimitEvent {
  readonly acct: number | null;
}

/** T8's limit events with `from <= at < to`, oldest first, each tied to its store account. */
export function readAccountEvents(
  db: Database,
  accounts: readonly StoreAccount[],
  range: Range,
): AccountEvent[] {
  const ids = new Map(accounts.map((a) => [`${a.provider}\0${a.identity}`, a.id]));
  return readLimitEvents(db, range).map((e) => ({
    ...e,
    acct: ids.get(`${e.account.provider}\0${e.account.id}`) ?? null,
  }));
}

function total(u: Usage): HistoryTotal {
  const t = u.tokens;
  return {
    cost: u.cost,
    tokens: t.total,
    pricedShare: u.coverage.pricedShare,
    estimatedCost: u.estimatedCost,
    input: t.input,
    output: t.output,
    cache: t.cacheRead + t.cacheWrite,
  };
}

function share(name: string, u: Usage): HistoryShare {
  return {
    name,
    cost: u.cost,
    tokens: u.tokens.total,
    pricedShare: u.coverage.pricedShare,
    estimatedCost: u.estimatedCost,
  };
}

function ranked(shares: HistoryShare[]): HistoryShare[] {
  return shares.sort(
    (a, b) =>
      b.cost - a.cost || b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** Shares summed by name (a model's tiers, a period's days), most cost first. */
function merged(lists: Iterable<readonly HistoryShare[]>): HistoryShare[] {
  const sums = new Map<
    string,
    { cost: number; tokens: number; priced: number; estimated: number }
  >();
  for (const list of lists) {
    for (const s of list) {
      const sum = sums.get(s.name) ?? { cost: 0, tokens: 0, priced: 0, estimated: 0 };
      sum.cost += s.cost;
      sum.tokens += s.tokens;
      sum.priced += s.pricedShare * s.tokens;
      sum.estimated += s.estimatedCost;
      sums.set(s.name, sum);
    }
  }
  return ranked(
    [...sums].map(([name, s]) => ({
      name,
      cost: s.cost,
      tokens: s.tokens,
      pricedShare: s.tokens > 0 ? s.priced / s.tokens : 1,
      estimatedCost: s.estimated,
    })),
  );
}

/**
 * Limit events by local day, for the accounts in scope, labelled for display. A `resumed`
 * event is left out: the hit it ends already says how long the wait was.
 */
function eventsByDay(ctx: ComputeContext, range: Range): Map<string, HistoryEvent[]> {
  const out = new Map<string, HistoryEvent[]>();
  const labels = new Map(ctx.accounts.map((a) => [a.id, a.label]));
  for (const e of ctx.limitEvents?.(range) ?? []) {
    if (e.kind === "resumed" || (ctx.scope !== null && e.acct !== ctx.scope)) continue;
    const key = formatDate(ctx.zone.dateAt(e.at));
    const list = out.get(key) ?? [];
    list.push({
      account: (e.acct === null ? undefined : labels.get(e.acct)) ?? e.account.label,
      kind: e.kind,
      window: e.label,
      at: e.at,
      resumedAt: e.resumed_at,
    });
    out.set(key, list);
  }
  return out;
}

/** A week or month: its engine total, with the models and accounts of its days. */
function period(key: string, usage: Usage, days: readonly HistoryDay[]): HistoryPeriod {
  return {
    ...total(usage),
    key,
    days: days.length,
    models: merged(days.map((d) => d.models)),
    accounts: merged(days.map((d) => d.accounts)),
  };
}

/**
 * The days run from the 1st of the heat map's first month, so the oldest month row is a
 * whole month, to today. The heat map and the Day and Week tables cover its last 26 weeks.
 */
export function computeHistory(ctx: ComputeContext): Computed<HistoryVM> {
  const { q, zone } = ctx;
  const filter = ctx.scope === null ? {} : { accounts: [ctx.scope] };
  const today = zone.dateAt(ctx.now);
  const gridFirst = addDays(mondayOf(today), -(HISTORY_WEEKS - 1) * 7);
  const end = zone.startOf(addDays(today, 1));
  const range: Range = { from: zone.startOf(firstOfMonth(gridFirst)), to: end };
  const grid: Range = { from: zone.startOf(gridFirst), to: end };

  const calendar = q.byDay({ range, ...filter });
  const perAccount = ctx.accounts
    .filter((a) => ctx.scope === null || a.id === ctx.scope)
    .map((a) => ({ name: a.label, days: q.byDay({ range, accounts: [a.id] }) }));
  const events = eventsByDay(ctx, range);
  const days: HistoryDay[] = calendar.map((d, i) => {
    const accounts: HistoryShare[] = [];
    for (const a of perAccount) {
      const u = a.days[i]?.usage;
      if (u !== undefined && u.records > 0) accounts.push(share(a.name, u));
    }
    return {
      ...total(d.usage),
      key: d.key,
      days: 1,
      models:
        d.usage.records === 0
          ? []
          : merged([q.byModel({ range: d.range, ...filter }).map((m) => share(m.model, m.usage))]),
      accounts: ranked(accounts),
      events: events.get(d.key) ?? [],
    };
  });

  const gridStart = days.findIndex((d) => d.key === formatDate(gridFirst));
  const weeks = q
    .byWeek({ range: grid, ...filter })
    .map((w, k) => period(w.key, w.usage, days.slice(gridStart + k * 7, gridStart + (k + 1) * 7)));
  const months = q.byMonth({ range, ...filter }).map((m) =>
    period(
      m.key,
      m.usage,
      days.filter((d) => d.key.startsWith(m.key)),
    ),
  );
  const before = q.totals({
    range: { from: zone.startOf(addDays(today, -AVERAGE_DAYS)), to: zone.startOf(today) },
    ...filter,
  }).usage;
  return {
    vm: {
      days,
      gridStart,
      weeks,
      months,
      weeksTotal: total(q.totals({ range: grid, ...filter }).usage),
      monthsTotal: total(q.totals({ range, ...filter }).usage),
      average: {
        cost: before.cost / AVERAGE_DAYS,
        tokens: before.tokens.total / AVERAGE_DAYS,
      },
    },
    deps: [range],
    validUntil: end,
  };
}

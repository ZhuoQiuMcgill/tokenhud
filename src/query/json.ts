// The schema-1 JSON documents of `tokenhud json` (and the MCP `usage` tool), built from
// the query layer's results. Instants are ISO-8601 in the query's zone, money is USD
// rounded to 1e-6, token counts are integers.

import type { UsageQueries } from "./engine.ts";
import type { Period } from "./periods.ts";
import {
  type AccountRef,
  type AccountUsage,
  type CalendarUsage,
  type DisplayRates,
  type GroupBy,
  JSON_SCHEMA,
  type JsonAccount,
  type JsonAccountGroup,
  type JsonAccountsDocument,
  type JsonCalendarGroup,
  type JsonDisplayRates,
  type JsonFilter,
  type JsonModelGroup,
  type JsonModelsDocument,
  type JsonPeriod,
  type JsonTotals,
  type JsonUsage,
  type JsonUsageDocument,
  type ModelUsage,
  type Range,
  type Totals,
  type Usage,
} from "./types.ts";
import { Zone } from "./tz.ts";

/** What a document is about: the same arguments every query takes. */
export interface DocumentRequest {
  readonly period: Period;
  readonly accounts?: readonly number[];
  readonly providers?: readonly string[];
  readonly tz?: string;
}

const usd = (x: number): number => Math.round(x * 1e6) / 1e6;

export function jsonUsage(usage: Usage): JsonUsage {
  const c = usage.coverage;
  return {
    tokens: {
      input: usage.tokens.input,
      output: usage.tokens.output,
      cache_read: usage.tokens.cacheRead,
      cache_write: usage.tokens.cacheWrite,
      total: usage.tokens.total,
    },
    records: usage.records,
    cost_usd: usd(usage.cost),
    estimated_cost_usd: usd(usage.estimatedCost),
    coverage: {
      priced_tokens: c.pricedTokens,
      unpriced_tokens: c.unpricedTokens,
      unpriced_tier_tokens: c.unpricedTierTokens,
      estimated_tokens: c.estimatedTokens,
      priced_pct: Math.round(c.pricedShare * 10_000) / 100,
    },
  };
}

function jsonTotals(totals: Totals): JsonTotals {
  return {
    ...jsonUsage(totals.usage),
    unpriced: totals.unpriced.map((u) => ({ ...u })),
  };
}

const jsonAccount = (a: AccountRef): JsonAccount => ({
  id: a.id,
  label: a.label,
  provider: a.provider,
});

function jsonRates(rates: DisplayRates | null): JsonDisplayRates | null {
  if (rates === null) return null;
  return {
    input: rates.input,
    output: rates.output,
    cache_read: rates.cacheRead,
    cache_write: rates.cacheWrite,
    long_context:
      rates.longContext === null
        ? null
        : {
            threshold: rates.longContext.threshold,
            input_multiplier: rates.longContext.inputMultiplier,
            output_multiplier: rates.longContext.outputMultiplier,
          },
  };
}

export function jsonModel(m: ModelUsage): JsonModelGroup {
  return {
    model: m.model,
    tier: m.tier,
    ...jsonUsage(m.usage),
    share: m.share,
    status: m.status,
    rates: jsonRates(m.rates),
  };
}

function jsonAccountGroup(a: AccountUsage): JsonAccountGroup {
  return { account: jsonAccount(a.account), ...jsonUsage(a.usage), share: a.share };
}

function jsonCalendar(c: CalendarUsage, zone: Zone): JsonCalendarGroup {
  return {
    key: c.key,
    from: zone.iso(c.range.from),
    to: zone.iso(c.range.to),
    ...jsonUsage(c.usage),
    top_model: c.topModel,
  };
}

function jsonPeriod(period: Period, range: Range, zone: Zone): JsonPeriod {
  const empty = range.to <= range.from;
  return {
    name: typeof period === "string" ? period : "custom",
    from: empty && period === "all" ? null : zone.iso(range.from),
    to: empty && period === "all" ? null : zone.iso(range.to),
    tz: zone.name,
  };
}

function jsonFilter(q: UsageQueries, req: DocumentRequest): JsonFilter {
  const ids = req.accounts === undefined ? null : new Set(req.accounts);
  return {
    accounts:
      ids === null
        ? null
        : q
            .accountList()
            .filter((a) => ids.has(a.id))
            .map(jsonAccount),
    providers: req.providers === undefined ? null : [...req.providers],
  };
}

/** When a document is made, and what went wrong on the way that didn't stop it. */
export interface DocumentContext {
  readonly now: number;
  readonly warnings: readonly string[];
}

const header = (ctx: DocumentContext) => ({
  schema: JSON_SCHEMA,
  generated_at: new Date(ctx.now).toISOString(),
  warnings: [...ctx.warnings],
});

function zoneOf(q: UsageQueries, req: DocumentRequest): Zone {
  return Zone.of(req.tz ?? q.timeZone);
}

/** `tokenhud json usage`: totals, and groups when `groupBy` is set. */
export function usageDocument(
  q: UsageQueries,
  req: DocumentRequest,
  groupBy: GroupBy | null,
  ctx: DocumentContext,
): JsonUsageDocument {
  return q.snapshot(() => {
    const zone = zoneOf(q, req);
    const totals = q.totals(req);
    let groups: JsonUsageDocument["groups"] = [];
    if (groupBy === "model") groups = q.byModel(req).map(jsonModel);
    else if (groupBy === "account") groups = q.byAccount(req).map(jsonAccountGroup);
    else if (groupBy === "day") groups = q.byDay(req).map((c) => jsonCalendar(c, zone));
    else if (groupBy === "week") groups = q.byWeek(req).map((c) => jsonCalendar(c, zone));
    else if (groupBy === "month") groups = q.byMonth(req).map((c) => jsonCalendar(c, zone));
    return {
      ...header(ctx),
      query: "usage",
      period: jsonPeriod(req.period, totals.range, zone),
      filter: jsonFilter(q, req),
      group_by: groupBy,
      totals: jsonTotals(totals),
      groups,
    };
  });
}

/** `tokenhud json models`: per model and tier, with the rates in effect now. */
export function modelsDocument(
  q: UsageQueries,
  req: DocumentRequest,
  ctx: DocumentContext,
): JsonModelsDocument {
  return q.snapshot(() => {
    const zone = zoneOf(q, req);
    const totals = q.totals(req);
    return {
      ...header(ctx),
      query: "models",
      period: jsonPeriod(req.period, totals.range, zone),
      filter: jsonFilter(q, req),
      totals: jsonTotals(totals),
      models: q.byModel(req).map(jsonModel),
    };
  });
}

/** `tokenhud json accounts`: every account with its usage in the period. */
export function accountsDocument(
  q: UsageQueries,
  req: DocumentRequest,
  ctx: DocumentContext,
): JsonAccountsDocument {
  return q.snapshot(() => {
    const zone = zoneOf(q, req);
    const seen = new Map(q.accounts().map((a) => [a.id, a]));
    const iso = (t: number | null | undefined) =>
      t === null || t === undefined ? null : zone.iso(t);
    return {
      ...header(ctx),
      query: "accounts",
      period: jsonPeriod(req.period, q.range(req), zone),
      accounts: q.byAccount(req).map((a) => ({
        ...jsonAccount(a.account),
        ...jsonUsage(a.usage),
        share: a.share,
        first_seen: iso(seen.get(a.account.id)?.firstSeen),
        last_seen: iso(seen.get(a.account.id)?.lastSeen),
      })),
    };
  });
}

// The query layer's results (camelCase, epoch ms) and the stable JSON documents built from
// them (snake_case, ISO-8601), which `tokenhud json` prints and the MCP server (T9)
// returns. docs/json.md describes the same shapes for people.

import type { Unpriced } from "../pricing/cost.ts";
import type { Tier } from "../pricing/schema.ts";

/** Epoch milliseconds, half-open: `from` inclusive, `to` exclusive. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

// ── query results ────────────────────────────────────────────────────────────────

export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Cache creation (all write buckets). */
  readonly cacheWrite: number;
  readonly total: number;
}

/** Which tokens have a price. Every token is in exactly one of the first three. */
export interface PriceCoverage {
  /** Tokens priced, estimated ones included. */
  readonly pricedTokens: number;
  /** Tokens of models the price table doesn't have. */
  readonly unpricedTokens: number;
  /** Tokens of a priced model at a tier (or long context) it has no price for. */
  readonly unpricedTierTokens: number;
  /** The part of `pricedTokens` priced from an estimated card (an alias such as codex-auto-review). */
  readonly estimatedTokens: number;
  /** pricedTokens / all tokens; 1 when there are none. */
  readonly pricedShare: number;
}

/** Tokens and cost of a set of usage rows. */
export interface Usage {
  readonly tokens: Tokens;
  /** Usage rows (API responses). */
  readonly records: number;
  /** API-equivalent USD of the priced tokens, estimated ones included. */
  readonly cost: number;
  /** The part of `cost` priced from an estimated card. */
  readonly estimatedCost: number;
  readonly coverage: PriceCoverage;
}

export interface UnpricedModel {
  /** Normalised model id; "" when the rows had none. */
  readonly model: string;
  readonly tier: Tier;
  readonly reason: Unpriced;
  readonly tokens: number;
}

export interface Totals {
  readonly range: Range;
  readonly usage: Usage;
  /** What is unpriced, most tokens first. */
  readonly unpriced: readonly UnpricedModel[];
}

export interface AccountRef {
  readonly id: number;
  readonly label: string;
  readonly provider: string;
}

/** A tier's rates in effect now, USD per 1M tokens, as billed. */
export interface DisplayRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** The card's cache-write rate, else the 5-minute write rate (1.25x input). */
  readonly cacheWrite: number;
  readonly longContext: {
    readonly threshold: number;
    readonly inputMultiplier: number;
    readonly outputMultiplier: number;
  } | null;
  /** The rates are another model's, standing in for this one (an estimated alias). */
  readonly estimated: boolean;
}

/**
 * - priced: every token has a price;
 * - unpriced: the model has no price;
 * - unpriced-tier: the model has no price at this tier;
 * - partial: priced, except long-context rows this tier has no long-context price for.
 */
export type PriceStatus = "priced" | "unpriced" | "unpriced-tier" | "partial";

export interface ModelUsage {
  readonly model: string;
  readonly tier: Tier;
  readonly usage: Usage;
  /** This row's part of the total cost (0 when nothing is priced). */
  readonly share: number;
  readonly status: PriceStatus;
  /** Null when the model has no price at this tier now. */
  readonly rates: DisplayRates | null;
}

export interface AccountUsage {
  readonly account: AccountRef;
  readonly usage: Usage;
  readonly share: number;
}

export interface CalendarUsage {
  /** YYYY-MM-DD for a day or a week (its Monday), YYYY-MM for a month. */
  readonly key: string;
  readonly range: Range;
  readonly usage: Usage;
  /** The model with the most cost (then tokens) in this group, or null if empty. */
  readonly topModel: string | null;
}

export interface ActivityBucket {
  readonly range: Range;
  readonly cost: number;
  readonly tokens: number;
}

export interface Activity {
  readonly range: Range;
  readonly buckets: readonly ActivityBucket[];
}

export interface AccountPace {
  readonly account: AccountRef;
  readonly cost: number;
  readonly tokens: number;
  readonly costPerHour: number;
  readonly tokensPerHour: number;
}

export interface Pace {
  readonly range: Range;
  readonly minutes: number;
  readonly accounts: readonly AccountPace[];
}

export interface AccountSummary extends AccountRef {
  /** Epoch ms of the account's first and last usage row; null if it has none. */
  readonly firstSeen: number | null;
  readonly lastSeen: number | null;
}

// ── JSON documents (schema 1) ────────────────────────────────────────────────────

export const JSON_SCHEMA = 1 as const;

export type GroupBy = "model" | "account" | "day" | "week" | "month";

export interface JsonTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface JsonCoverage {
  priced_tokens: number;
  unpriced_tokens: number;
  unpriced_tier_tokens: number;
  estimated_tokens: number;
  /** 0–100, two decimals. */
  priced_pct: number;
}

export interface JsonUsage {
  tokens: JsonTokens;
  records: number;
  /** USD, rounded to 1e-6. */
  cost_usd: number;
  estimated_cost_usd: number;
  coverage: JsonCoverage;
}

export interface JsonPeriod {
  /** A period name, or "custom". */
  name: string;
  /** ISO-8601 in `tz`'s offset; null for "all" over an empty store. */
  from: string | null;
  /** Exclusive. */
  to: string | null;
  tz: string;
}

export interface JsonAccount {
  id: number;
  label: string;
  provider: string;
}

export interface JsonFilter {
  /** Null: every account. */
  accounts: JsonAccount[] | null;
  /** Null: every provider. */
  providers: string[] | null;
}

export interface JsonUnpriced {
  model: string;
  tier: Tier;
  reason: Unpriced;
  tokens: number;
}

export interface JsonTotals extends JsonUsage {
  unpriced: JsonUnpriced[];
}

export interface JsonDisplayRates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  long_context: { threshold: number; input_multiplier: number; output_multiplier: number } | null;
  estimated: boolean;
}

export interface JsonModelGroup extends JsonUsage {
  model: string;
  tier: Tier;
  share: number;
  status: PriceStatus;
  rates: JsonDisplayRates | null;
}

export interface JsonAccountGroup extends JsonUsage {
  account: JsonAccount;
  share: number;
}

export interface JsonCalendarGroup extends JsonUsage {
  key: string;
  from: string;
  to: string;
  top_model: string | null;
}

export type JsonGroup = JsonModelGroup | JsonAccountGroup | JsonCalendarGroup;

/** What every document starts with; the MCP server's documents too. */
export interface JsonDocument {
  schema: typeof JSON_SCHEMA;
  /** ISO-8601 UTC. */
  generated_at: string;
  /** Problems that didn't stop the answer, such as a malformed price overrides file. */
  warnings: string[];
}

/** `tokenhud json usage` and the MCP `usage` tool. */
export interface JsonUsageDocument extends JsonDocument {
  query: "usage";
  period: JsonPeriod;
  filter: JsonFilter;
  group_by: GroupBy | null;
  totals: JsonTotals;
  /** Empty without `group_by`. Day, week and month groups are contiguous, empty ones included. */
  groups: JsonGroup[];
}

/** `tokenhud json models`. */
export interface JsonModelsDocument extends JsonDocument {
  query: "models";
  period: JsonPeriod;
  filter: JsonFilter;
  totals: JsonTotals;
  models: JsonModelGroup[];
}

export interface JsonAccountEntry extends JsonAccount, JsonUsage {
  share: number;
  first_seen: string | null;
  last_seen: string | null;
}

/** `tokenhud json accounts`. */
export interface JsonAccountsDocument extends JsonDocument {
  query: "accounts";
  period: JsonPeriod;
  accounts: JsonAccountEntry[];
}

export type JsonErrorCode = "bad_argument" | "store_error";

/** Written to stderr with a non-zero exit. */
export interface JsonError {
  schema: typeof JSON_SCHEMA;
  error: { code: JsonErrorCode; message: string };
}

// The Models view's rate board (T13): every model and tier used in the window, the rates
// it is billed at now, who used it, and what its rate card says. Computed in the
// view-model Worker; the view only formats it.

import type { Window } from "../../config.ts";
import {
  cacheReadRate,
  EPHEMERAL_1H_MULT,
  EPHEMERAL_5M_MULT,
  type Rates,
  type Unpriced,
} from "../../pricing/cost.ts";
import type { Tier } from "../../pricing/schema.ts";
import { bundledPricing, PriceTable } from "../../pricing/table.ts";
import type { Period } from "../../query/periods.ts";
import type { PriceStatus, Range } from "../../query/types.ts";
import {
  amount,
  type ComputeContext,
  type Computed,
  periodRange,
  ROLLING_REFRESH_MS,
} from "./compute.ts";
import type { Priced } from "./types.ts";

/** One account's part of a model row. */
export interface ModelUser extends Priced {
  readonly id: number;
  readonly label: string;
}

/** Input, output and cache-read rates, USD per 1M tokens. */
export interface RatePair {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/** A card change inside the window: what the row's tier was billed before and after. */
export interface PriceChange {
  readonly at: number;
  /** Null when the model had no price on that side of the change. */
  readonly before: RatePair | null;
  readonly after: RatePair | null;
}

/** A model's standard card now, as the rates card shows it. */
export interface RateCard extends RatePair {
  /** cacheRead / input: Opus 5.5 reads at 0.05×. */
  readonly cacheReadMultiplier: number;
  /** A card's own write rate (OpenAI), or Anthropic's 5-minute and 1-hour write rates. */
  readonly cacheWrite: { readonly flat: number } | { readonly m5: number; readonly h1: number };
  readonly fast: RatePair | null;
  readonly longContext: {
    readonly threshold: number;
    readonly inputMultiplier: number;
    readonly outputMultiplier: number;
  } | null;
  /** Where the rates come from: a provider's pricing page, or the user's overrides. */
  readonly source: { readonly name: string; readonly checked: string | null };
  /** For an estimated alias (codex-auto-review): the model it is priced as now. */
  readonly estimatedAs: string | null;
}

export interface ModelRow extends Priced {
  /** The normalised model id; "" for rows that had none. */
  readonly model: string;
  /** For people: `Opus 5.5`, `gpt-5.6-sol`. */
  readonly name: string;
  readonly tier: "standard" | "fast";
  /** The providers of the accounts that used it ("claude", "codex"). */
  readonly provider: string;
  readonly input: number;
  readonly output: number;
  /** Cache reads and writes. */
  readonly cache: number;
  /** Share of the window's cost. */
  readonly share: number;
  readonly status: PriceStatus;
  /** The row's tier billed now, USD per 1M tokens; null when it has no price. */
  readonly rates: RatePair | null;
  /** Usage rows (requests) in the window. */
  readonly records: number;
  /** First use of the model by the accounts in scope, any tier. */
  readonly firstSeen: number | null;
  /** The accounts that used it, most cost first. */
  readonly users: readonly ModelUser[];
  /** The model's standard card now; null when the model has none. */
  readonly card: RateCard | null;
  /** Changes of this tier's card inside the window. */
  readonly changes: readonly PriceChange[];
}

export type ModelSort = "cost" | "tokens" | "name";

export interface ModelsVM {
  readonly window: Window;
  /** Most cost first (then most tokens), as the query layer orders them. */
  readonly rows: readonly ModelRow[];
  /** Indexes into `rows` for each sort. */
  readonly order: Readonly<Record<ModelSort, readonly number[]>>;
  readonly total: Priced & {
    readonly input: number;
    readonly output: number;
    readonly cache: number;
  };
  readonly pricedShare: number;
  /** When it was computed and in which zone, for dates. */
  readonly asOf: number;
  readonly tz: string;
}

const PROVIDER_SOURCE: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai" };

let bundledTable: PriceTable | undefined;

/** The bundled table alone: a card that differs from it now is the user's override. */
function bundled(): PriceTable {
  bundledTable ??= new PriceTable(bundledPricing().models, bundledPricing().aliases);
  return bundledTable;
}

/** cc-usage's `pretty_model_name`: `claude-opus-4-8` → `Opus 4.8`; other ids as they are. */
export function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (m === null) return model === "" ? "(unknown)" : model;
  const family = `${(m[1] as string).charAt(0).toUpperCase()}${(m[1] as string).slice(1)}`;
  return m[3] === undefined ? `${family} ${m[2]}` : `${family} ${m[2]}.${m[3]}`;
}

function pair(rates: Rates | Unpriced): RatePair | null {
  if (typeof rates === "string") return null;
  return { input: rates.input, output: rates.output, cacheRead: cacheReadRate(rates) };
}

function samePair(a: RatePair | null, b: RatePair | null): boolean {
  if (a === null || b === null) return a === b;
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead;
}

function sameCard(a: Rates, b: Rates | Unpriced): boolean {
  if (typeof b === "string") return false;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cache_read === b.cache_read &&
    a.cache_write === b.cache_write &&
    a.long_context_threshold === b.long_context_threshold &&
    a.long_context_input_multiplier === b.long_context_input_multiplier &&
    a.long_context_output_multiplier === b.long_context_output_multiplier
  );
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The model's standard card in effect at `now`, or null when it has none. */
export function rateCard(
  prices: PriceTable,
  model: string,
  provider: string,
  now: number,
): RateCard | null {
  const card = prices.rates(model, "standard", now);
  if (typeof card === "string") return null;
  const fast = prices.rates(model, "fast", now);
  const file = bundledPricing();
  let estimatedAs: string | null = null;
  let source: RateCard["source"];
  const alias = file.aliases[model];
  if (card.estimated && alias !== undefined) {
    const period = alias.periods.findLast((p) => p.from === null || Date.parse(p.from) <= now);
    estimatedAs = period?.model ?? null;
    source = { name: host(alias.source), checked: null };
  } else if (!sameCard(card, bundled().rates(model, "standard", now))) {
    source = { name: "pricing.overrides.json", checked: null };
  } else {
    const s = file.sources[PROVIDER_SOURCE[provider.split("/")[0] as string] ?? ""];
    source =
      s === undefined
        ? { name: "pricing.json", checked: null }
        : { name: host(s.url), checked: s.checked };
  }
  const read = cacheReadRate(card);
  return {
    input: card.input,
    output: card.output,
    cacheRead: read,
    cacheReadMultiplier: card.input > 0 ? read / card.input : 0,
    cacheWrite:
      card.cache_write !== undefined
        ? { flat: card.cache_write }
        : { m5: card.input * EPHEMERAL_5M_MULT, h1: card.input * EPHEMERAL_1H_MULT },
    fast: pair(fast),
    longContext:
      card.long_context_threshold === undefined
        ? null
        : {
            threshold: card.long_context_threshold,
            inputMultiplier: card.long_context_input_multiplier ?? 1,
            outputMultiplier: card.long_context_output_multiplier ?? 1,
          },
    source,
    estimatedAs,
  };
}

/** Where `tier`'s card for `model` changes inside `range` (and before `now`). */
export function priceChanges(
  prices: PriceTable,
  model: string,
  tier: Tier,
  range: Range,
  now: number,
): PriceChange[] {
  const end = Math.min(range.to, now + 1);
  const out: PriceChange[] = [];
  for (const at of prices.boundaries()) {
    if (at <= range.from || at >= end) continue;
    const before = pair(prices.rates(model, tier, at - 1));
    const after = pair(prices.rates(model, tier, at));
    if (!samePair(before, after)) out.push({ at, before, after });
  }
  return out;
}

const key = (model: string, tier: string) => `${model}\0${tier}`;

export function computeModels(ctx: ComputeContext): Computed<ModelsVM> {
  const { q } = ctx;
  const period = ctx.window as Period;
  const shown = ctx.accounts.filter((a) => ctx.scope === null || a.id === ctx.scope);
  const filter = ctx.scope === null ? { period } : { period, accounts: [ctx.scope] };
  const models = q.byModel(filter);
  const totals = q.totals(filter);
  const range = q.range(filter);
  const firstSeen = q.modelsFirstSeen(ctx.scope === null ? {} : { accounts: [ctx.scope] });
  const users = new Map<string, ModelUser[]>();
  for (const a of shown) {
    for (const m of q.byModel({ period, accounts: [a.id] })) {
      const k = key(m.model, m.tier);
      const list = users.get(k) ?? [];
      list.push({ id: a.id, label: a.label, ...amount(m.usage) });
      users.set(k, list);
    }
  }
  const providers = new Map(ctx.accounts.map((a) => [a.id, a.provider]));
  const rows = models.map((m): ModelRow => {
    const t = m.usage.tokens;
    const who = (users.get(key(m.model, m.tier)) ?? []).sort(
      (x, y) => y.cost - x.cost || y.tokens - x.tokens || x.id - y.id,
    );
    const provider = [...new Set(who.map((u) => providers.get(u.id) ?? ""))].join("/");
    return {
      ...amount(m.usage),
      model: m.model,
      name: modelName(m.model),
      tier: m.tier,
      provider,
      input: t.input,
      output: t.output,
      cache: t.cacheRead + t.cacheWrite,
      share: m.share,
      status: m.status,
      rates:
        m.rates === null
          ? null
          : { input: m.rates.input, output: m.rates.output, cacheRead: m.rates.cacheRead },
      records: m.usage.records,
      firstSeen: firstSeen.get(m.model) ?? null,
      users: who,
      card: rateCard(ctx.prices, m.model, provider, ctx.now),
      changes: priceChanges(ctx.prices, m.model, m.tier, range, ctx.now),
    };
  });
  const indexes = rows.map((_, i) => i);
  const label = (r: ModelRow) => `${r.name}${r.tier === "fast" ? " (fast)" : ""}`;
  const order: Record<ModelSort, number[]> = {
    cost: indexes,
    tokens: [...indexes].sort(
      (a, b) => (rows[b] as ModelRow).tokens - (rows[a] as ModelRow).tokens || a - b,
    ),
    name: [...indexes].sort((a, b) =>
      label(rows[a] as ModelRow).localeCompare(label(rows[b] as ModelRow), "en"),
    ),
  };
  const t = totals.usage.tokens;
  const rolling = ctx.window === "1h" || ctx.window === "5h" || ctx.window === "24h";
  const window = periodRange(ctx, period);
  // The rates shown are those in effect now: the next card change dates them.
  const repriced = ctx.prices.boundaries().find((b) => b > ctx.now) ?? Number.POSITIVE_INFINITY;
  return {
    vm: {
      window: ctx.window,
      rows,
      order,
      total: {
        ...amount(totals.usage),
        input: t.input,
        output: t.output,
        cache: t.cacheRead + t.cacheWrite,
      },
      pricedShare: totals.usage.coverage.pricedShare,
      asOf: ctx.now,
      tz: ctx.zone.name,
    },
    deps: [window],
    validUntil: Math.min(rolling ? ctx.now + ROLLING_REFRESH_MS : window.to, repriced),
  };
}

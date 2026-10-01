// The price table format (v2) shared by the bundled `pricing.json` and the user's
// `pricing.overrides.json`, with its runtime validator. Rates are USD per 1M tokens.

import type { Rates } from "./cost.ts";
import { normalizeModel } from "./normalize.ts";

export type Tier = "standard" | "fast";

/**
 * Fast (Anthropic) or priority/fast (OpenAI) rates. A missing `cache_read` derives from
 * the fast input at the standard card's own cache-read ratio (see table.ts).
 *
 * Long context is never inherited, so no long-context fast price is ever extrapolated:
 * - the threshold is always the standard card's;
 * - a fast card has a long-context price only if it states both multipliers, which apply
 *   to its own rates above that threshold;
 * - without them, a fast record above the threshold is "unpriced-tier";
 * - a model with no threshold (every Claude model) has no long-context tier at all, so its
 *   fast card covers the whole context window.
 */
export interface FastCard {
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly long_context_input_multiplier?: number;
  readonly long_context_output_multiplier?: number;
}

export interface RateCard extends Omit<Rates, "long_context_unpriced" | "estimated"> {
  readonly fast?: FastCard;
}

/** A card in effect from `from` (ISO-8601 UTC) until the next period; null = since always. */
export interface Period {
  readonly from: string | null;
  readonly card: RateCard;
}

export interface DatedPricing {
  readonly periods: readonly Period[];
}

/** A model maps to one card valid for all time, or to dated periods. */
export type ModelPricing = RateCard | DatedPricing;

export interface Source {
  readonly url: string;
  /** YYYY-MM-DD */
  readonly checked: string;
}

/** One period of an alias: from `from` (ISO-8601 UTC; null = since always), it is priced as `model`. */
export interface AliasPeriod {
  readonly from: string | null;
  readonly model: string;
}

/**
 * A model id whose provider does not say which model serves it, priced as an *estimate*
 * from a published statement of what it ran on, period by period. Every rate it resolves
 * to carries `estimated: true`.
 */
export interface EstimatedAlias {
  readonly estimated: true;
  /** The official statement the timeline rests on (https). */
  readonly source: string;
  readonly periods: readonly AliasPeriod[];
}

export interface PriceTableFile {
  readonly version: 2;
  readonly sources: Readonly<Record<string, Source>>;
  readonly models: Readonly<Record<string, ModelPricing>>;
  /** Bundled only; absent means none. */
  readonly aliases: Readonly<Record<string, EstimatedAlias>>;
}

export class PricingSchemaError extends Error {
  override name = "PricingSchemaError";
}

export function isDated(pricing: ModelPricing): pricing is DatedPricing {
  return "periods" in pricing;
}

interface ParseOptions {
  /**
   * Accept numeric strings such as "2.5", as cc-usage's `_coerce` did for its editable
   * pricing.json. Only user-edited files get this; the bundled table must hold numbers.
   */
  readonly coerce: boolean;
}

/** A standard card's optional fields: cc-usage's `_OPTIONAL_RATE_FIELDS`. */
export const OPTIONAL_RATE_FIELDS = [
  "cache_read",
  "cache_write",
  "long_context_threshold",
  "long_context_input_multiplier",
  "long_context_output_multiplier",
] as const;
const CARD_KEYS: ReadonlySet<string> = new Set([
  "input",
  "output",
  ...OPTIONAL_RATE_FIELDS,
  "fast",
]);
const FAST_OPTIONAL_FIELDS = [
  "cache_read",
  "cache_write",
  "long_context_input_multiplier",
  "long_context_output_multiplier",
] as const;
const FAST_KEYS: ReadonlySet<string> = new Set(["input", "output", ...FAST_OPTIONAL_FIELDS]);

// Python's float() decimal syntax, minus the inf/nan spellings and digit underscores. JS
// Number() alone would also take hex, octal and binary literals.
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(path: string, message: string): never {
  throw new PricingSchemaError(`${path}: ${message}`);
}

/**
 * A short description of a bad value for an error message. It never recurses: a user file
 * can nest a value deeper than JSON.stringify's stack allows, and must still only warn.
 */
export function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
  }
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keys starting with "_" are comments, as in cc-usage's `_comment`. Any other unknown key
// is an error rather than silently ignored, so a typo such as "cache_reads" can't quietly
// fall back to a derived rate.
function checkKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, path: string) {
  for (const key of Object.keys(obj)) {
    if (!key.startsWith("_") && !allowed.has(key)) fail(path, `unknown field "${key}"`);
  }
}

/**
 * A rate as a non-negative finite number, or undefined if `value` isn't one. With
 * `coerce`, numeric strings count too.
 */
export function toRate(value: unknown, coerce: boolean): number | undefined {
  let n: number | undefined;
  if (typeof value === "number") n = value;
  else if (coerce && typeof value === "string" && DECIMAL.test(value.trim())) {
    n = Number(value.trim());
  }
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function rate(value: unknown, path: string, opts: ParseOptions): number {
  const n = toRate(value, opts.coerce);
  if (n === undefined) fail(path, `expected a non-negative number, got ${describeValue(value)}`);
  return n;
}

function parseFastCard(raw: unknown, path: string, opts: ParseOptions): FastCard {
  if (!isRecord(raw)) fail(path, "expected an object");
  checkKeys(raw, FAST_KEYS, path);
  const card: { -readonly [K in keyof FastCard]: FastCard[K] } = {
    input: rate(raw.input, `${path}.input`, opts),
    output: rate(raw.output, `${path}.output`, opts),
  };
  for (const key of FAST_OPTIONAL_FIELDS) {
    if (raw[key] !== undefined) card[key] = rate(raw[key], `${path}.${key}`, opts);
  }
  if (
    (card.long_context_input_multiplier === undefined) !==
    (card.long_context_output_multiplier === undefined)
  ) {
    fail(path, "state both long-context multipliers, or neither (no long-context price)");
  }
  return card;
}

export function parseRateCard(raw: unknown, path: string, opts: ParseOptions): RateCard {
  if (!isRecord(raw)) fail(path, "expected an object");
  checkKeys(raw, CARD_KEYS, path);
  const card: { -readonly [K in keyof RateCard]: RateCard[K] } = {
    input: rate(raw.input, `${path}.input`, opts),
    output: rate(raw.output, `${path}.output`, opts),
  };
  for (const key of OPTIONAL_RATE_FIELDS) {
    if (raw[key] !== undefined) card[key] = rate(raw[key], `${path}.${key}`, opts);
  }
  if (raw.fast !== undefined) card.fast = parseFastCard(raw.fast, `${path}.fast`, opts);
  if (
    card.fast?.long_context_input_multiplier !== undefined &&
    card.long_context_threshold === undefined
  ) {
    fail(
      `${path}.fast`,
      "long-context multipliers need a long_context_threshold on the standard card",
    );
  }
  return card;
}

/**
 * Epoch ms for `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.sss]]Z`, both UTC; undefined for
 * anything else, including impossible dates such as 2026-02-30.
 */
export function parseIsoUtc(text: string): number | undefined {
  const m = ISO_UTC.exec(text);
  if (!m) return undefined;
  const part = (i: number) => Number(m[i] ?? 0);
  const [y, mo, d, h, mi, s] = [part(1), part(2), part(3), part(4), part(5), part(6)];
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  const at = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(at);
  const same =
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    back.getUTCHours() === h &&
    back.getUTCMinutes() === mi &&
    back.getUTCSeconds() === s;
  return same ? at : undefined;
}

function parseDated(raw: Record<string, unknown>, path: string, opts: ParseOptions): DatedPricing {
  checkKeys(raw, new Set(["periods"]), path);
  const list = raw.periods;
  if (!Array.isArray(list) || list.length === 0) {
    fail(`${path}.periods`, "expected a non-empty array");
  }
  let previous = Number.NEGATIVE_INFINITY;
  const periods = list.map((item, i): Period => {
    const at = `${path}.periods[${i}]`;
    if (!isRecord(item)) fail(at, "expected an object");
    checkKeys(item, new Set(["from", "card"]), at);
    const rawFrom = item.from;
    let from: string | null = null;
    let fromMs = Number.NEGATIVE_INFINITY;
    if (typeof rawFrom === "string") {
      const parsed = parseIsoUtc(rawFrom);
      if (parsed === undefined) {
        fail(`${at}.from`, `expected an ISO-8601 UTC time, got ${describeValue(rawFrom)}`);
      }
      from = rawFrom;
      fromMs = parsed;
    } else if (rawFrom !== null) {
      fail(`${at}.from`, `expected null or an ISO-8601 UTC time, got ${describeValue(rawFrom)}`);
    } else if (i !== 0) {
      // "Since always" only makes sense before every dated period.
      fail(`${at}.from`, "only the first period may have a null 'from'");
    }
    if (i > 0 && fromMs <= previous) {
      fail(`${at}.from`, "periods must be sorted by 'from', strictly");
    }
    previous = fromMs;
    return { from, card: parseRateCard(item.card, `${at}.card`, opts) };
  });
  return { periods };
}

export function parseModelPricing(raw: unknown, path: string, opts: ParseOptions): ModelPricing {
  if (isRecord(raw) && "periods" in raw) return parseDated(raw, path, opts);
  return parseRateCard(raw, path, opts);
}

/**
 * Validates `raw` as the estimated alias `id`: periods sorted strictly by `from`, each
 * naming a model of `models` that has a card in effect when the period starts.
 */
function parseAlias(
  raw: unknown,
  id: string,
  models: Readonly<Record<string, ModelPricing>>,
): EstimatedAlias {
  const path = `pricing.json.aliases.${id}`;
  if (id === "" || normalizeModel(id) !== id) fail(path, "alias keys must be normalised ids");
  if (models[id] !== undefined) fail(path, "a model with its own prices cannot be an alias");
  if (!isRecord(raw)) fail(path, "expected an object");
  checkKeys(raw, new Set(["estimated", "source", "periods"]), path);
  if (raw.estimated !== true)
    fail(`${path}.estimated`, "only estimated aliases exist: expected true");
  if (typeof raw.source !== "string" || !raw.source.startsWith("https://")) {
    fail(`${path}.source`, "expected an https URL");
  }
  const list = raw.periods;
  if (!Array.isArray(list) || list.length === 0)
    fail(`${path}.periods`, "expected a non-empty array");
  let previous = Number.NEGATIVE_INFINITY;
  const periods = list.map((item, i): AliasPeriod => {
    const at = `${path}.periods[${i}]`;
    if (!isRecord(item)) fail(at, "expected an object");
    checkKeys(item, new Set(["from", "model"]), at);
    let fromMs = Number.NEGATIVE_INFINITY;
    if (typeof item.from === "string") {
      const parsed = parseIsoUtc(item.from);
      if (parsed === undefined) fail(`${at}.from`, "expected an ISO-8601 UTC time");
      fromMs = parsed;
    } else if (item.from !== null || i !== 0) {
      fail(`${at}.from`, "expected an ISO-8601 UTC time (only the first period may be null)");
    }
    if (i > 0 && fromMs <= previous)
      fail(`${at}.from`, "periods must be sorted by 'from', strictly");
    previous = fromMs;
    const target = typeof item.model === "string" ? models[item.model] : undefined;
    if (target === undefined) fail(`${at}.model`, "expected a model of this table");
    const firstFrom = isDated(target) ? target.periods[0]?.from : null;
    const startsMs =
      firstFrom === null || firstFrom === undefined
        ? Number.NEGATIVE_INFINITY
        : (parseIsoUtc(firstFrom) as number);
    if (startsMs > fromMs) fail(`${at}.model`, "the model has no card when this period starts");
    return { from: item.from as string | null, model: item.model as string };
  });
  return { estimated: true, source: raw.source, periods };
}

/** Validates the bundled table. Strict: numbers only, and keys already normalised. */
export function parsePriceTableFile(raw: unknown): PriceTableFile {
  const opts = { coerce: false };
  if (!isRecord(raw)) fail("pricing.json", "expected an object");
  checkKeys(raw, new Set(["version", "sources", "models", "aliases"]), "pricing.json");
  if (raw.version !== 2) fail("pricing.json.version", "expected 2");

  if (!isRecord(raw.sources)) fail("pricing.json.sources", "expected an object");
  const sources: Record<string, Source> = {};
  for (const [provider, source] of Object.entries(raw.sources)) {
    const path = `pricing.json.sources.${provider}`;
    if (!isRecord(source)) fail(path, "expected an object");
    checkKeys(source, new Set(["url", "checked"]), path);
    if (typeof source.url !== "string" || !source.url.startsWith("https://")) {
      fail(`${path}.url`, "expected an https URL");
    }
    const checked = source.checked;
    if (typeof checked !== "string" || !DAY.test(checked) || parseIsoUtc(checked) === undefined) {
      fail(`${path}.checked`, "expected a YYYY-MM-DD date");
    }
    sources[provider] = { url: source.url, checked };
  }

  if (!isRecord(raw.models)) fail("pricing.json.models", "expected an object");
  const models: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(raw.models)) {
    const path = `pricing.json.models.${key}`;
    if (key === "" || normalizeModel(key) !== key) fail(path, "model keys must be normalised ids");
    models[key] = parseModelPricing(value, path, opts);
  }

  const aliases: Record<string, EstimatedAlias> = {};
  if (raw.aliases !== undefined) {
    if (!isRecord(raw.aliases)) fail("pricing.json.aliases", "expected an object");
    for (const [id, value] of Object.entries(raw.aliases)) {
      if (!id.startsWith("_")) aliases[id] = parseAlias(value, id, models);
    }
  }
  return { version: 2, sources, models, aliases };
}

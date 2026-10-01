// The price table format (v2) shared by the bundled `pricing.json` and the user's
// `pricing.overrides.json`, with its runtime validator. Rates are USD per 1M tokens.

import type { Rates } from "./cost.ts";
import { normalizeModel } from "./normalize.ts";

export type Tier = "standard" | "fast";

/**
 * Fast (Anthropic) or priority/fast (OpenAI) rates. Long-context settings are not stated
 * here: the standard card's apply. A missing `cache_read` derives from the fast input at
 * the standard card's own cache-read ratio (see table.ts).
 */
export interface FastCard {
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
}

export interface RateCard extends Rates {
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

export interface PriceTableFile {
  readonly version: 2;
  readonly sources: Readonly<Record<string, Source>>;
  readonly models: Readonly<Record<string, ModelPricing>>;
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
const FAST_KEYS: ReadonlySet<string> = new Set(["input", "output", "cache_read", "cache_write"]);

// Python's float() decimal syntax, minus the inf/nan spellings and digit underscores. JS
// Number() alone would also take hex, octal and binary literals.
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(path: string, message: string): never {
  throw new PricingSchemaError(`${path}: ${message}`);
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
  if (n === undefined) fail(path, `expected a non-negative number, got ${JSON.stringify(value)}`);
  return n;
}

function parseFastCard(raw: unknown, path: string, opts: ParseOptions): FastCard {
  if (!isRecord(raw)) fail(path, "expected an object");
  checkKeys(raw, FAST_KEYS, path);
  const card: { -readonly [K in keyof FastCard]: FastCard[K] } = {
    input: rate(raw.input, `${path}.input`, opts),
    output: rate(raw.output, `${path}.output`, opts),
  };
  if (raw.cache_read !== undefined) {
    card.cache_read = rate(raw.cache_read, `${path}.cache_read`, opts);
  }
  if (raw.cache_write !== undefined) {
    card.cache_write = rate(raw.cache_write, `${path}.cache_write`, opts);
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
        fail(`${at}.from`, `expected an ISO-8601 UTC time, got "${rawFrom}"`);
      }
      from = rawFrom;
      fromMs = parsed;
    } else if (rawFrom !== null) {
      fail(`${at}.from`, `expected null or an ISO-8601 UTC time, got ${JSON.stringify(rawFrom)}`);
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

/** Validates the bundled table. Strict: numbers only, and keys already normalised. */
export function parsePriceTableFile(raw: unknown): PriceTableFile {
  const opts = { coerce: false };
  if (!isRecord(raw)) fail("pricing.json", "expected an object");
  checkKeys(raw, new Set(["version", "sources", "models"]), "pricing.json");
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
  return { version: 2, sources, models };
}

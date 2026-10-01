// User price overrides (`~/.config/tokenhud/pricing.overrides.json`) and their import
// from cc-usage.
//
// The overrides file holds only the user's own entries, in the bundled table's per-model
// format, under "models". An entry replaces that model's whole bundled definition: its
// dated periods and its fast card included. Because the file never holds a full copy of
// the bundled table, a later bundled correction still reaches every model the user didn't
// touch. cc-usage seeded a full copy into the user's pricing.json, which then shadowed
// every bundled fix (its T15 problem).

import { readFileSync } from "node:fs";
import { pricingOverridesPath } from "../paths.ts";
import type { Rates } from "./cost.ts";
import { normalizeModel } from "./normalize.ts";
import {
  isRecord,
  type ModelPricing,
  OPTIONAL_RATE_FIELDS,
  PricingSchemaError,
  parseModelPricing,
  toRate,
} from "./schema.ts";
import { bundledPricing, PriceTable } from "./table.ts";

export interface OverridesFile {
  readonly models: Readonly<Record<string, ModelPricing>>;
}

export interface LoadedOverrides extends OverridesFile {
  /** Human-readable problems: never thrown, for the caller to show. */
  readonly warnings: readonly string[];
}

// Keys are normalised so "Claude-Opus-4-8" overrides claude-opus-4-8. When two keys
// normalise to the same id, the one already in normal form wins (it is the one cc-usage
// matched), else the first one. Returns the chosen entries and the keys left out.
function byNormalisedId<T>(entries: Iterable<[string, T]>): {
  chosen: Map<string, { key: string; value: T }>;
  dropped: Array<{ key: string; reason: string }>;
} {
  const chosen = new Map<string, { key: string; value: T }>();
  const dropped: Array<{ key: string; reason: string }> = [];
  for (const [key, value] of entries) {
    const id = normalizeModel(key);
    const held = chosen.get(id);
    if (id === "") {
      dropped.push({ key, reason: "not a model id" });
    } else if (held === undefined) {
      chosen.set(id, { key, value });
    } else if (key === id && held.key !== id) {
      dropped.push({ key: held.key, reason: `duplicates "${key}"` });
      chosen.set(id, { key, value });
    } else {
      dropped.push({ key, reason: `duplicates "${held.key}"` });
    }
  }
  return { chosen, dropped };
}

/**
 * Parses an overrides file's text. It never throws. A file that isn't JSON, or has no
 * "models" object, yields no overrides and a warning. An invalid entry is skipped with a
 * warning, and the bundled definition stays in force for that model; valid entries still
 * apply, as with cc-usage's editable pricing.json. Numeric strings such as "2.5" are
 * accepted, and so is a leading byte-order mark (Windows editors write one).
 */
export function parseOverrides(text: string, source: string): LoadedOverrides {
  let raw: unknown;
  try {
    raw = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      models: {},
      warnings: [`${source} is not valid JSON (${reason}); using bundled prices`],
    };
  }
  if (!isRecord(raw) || !isRecord(raw.models)) {
    return {
      models: {},
      warnings: [`${source} has no "models" object; using bundled prices`],
    };
  }
  const { chosen, dropped } = byNormalisedId(Object.entries(raw.models));
  const warnings = dropped.map(({ key, reason }) => `${source}: skipped "${key}": ${reason}`);
  const models: Record<string, ModelPricing> = {};
  for (const [id, { key, value }] of chosen) {
    try {
      models[id] = parseModelPricing(value, `models.${key}`, { coerce: true });
    } catch (error) {
      // The validator throws PricingSchemaError. Anything else (none is known) still only
      // skips the entry: a user's file must never stop tokenhud from starting.
      const reason =
        error instanceof PricingSchemaError
          ? error.message
          : `invalid (${error instanceof Error ? error.name : "unexpected error"})`;
      warnings.push(`${source}: skipped "${key}": ${reason}`);
    }
  }
  return { models, warnings };
}

/** Reads the overrides file. A missing file means no overrides and no warning. */
export function readOverrides(path: string = pricingOverridesPath()): LoadedOverrides {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { models: {}, warnings: [] };
    const reason = error instanceof Error ? error.message : String(error);
    return { models: {}, warnings: [`could not read ${path} (${reason}); using bundled prices`] };
  }
  return parseOverrides(text, path);
}

/** bundled ⊕ overrides, by model key: an override replaces the whole bundled entry. */
export function mergePricing(
  bundled: Readonly<Record<string, ModelPricing>>,
  overrides: Readonly<Record<string, ModelPricing>>,
): Record<string, ModelPricing> {
  return { ...bundled, ...overrides };
}

/** The effective price table: the bundled table with the user's overrides on top. */
export function loadPriceTable(overridesPath: string = pricingOverridesPath()): {
  table: PriceTable;
  warnings: readonly string[];
} {
  const overrides = readOverrides(overridesPath);
  const bundled = bundledPricing();
  const models = mergePricing(bundled.models, overrides.models);
  return { table: new PriceTable(models, bundled.aliases), warnings: overrides.warnings };
}

// cc-usage's `_coerce` (cc_usage/pricing.py): a row needs a numeric input and output, and
// an optional field that doesn't parse is dropped while the row is kept. That is how
// cc-usage priced a hand-edited file, so the import reads it the same way. One deliberate
// difference: Python's float() also took booleans, "nan", "inf" and negative numbers; no
// real price is any of those, so they count as unparseable here.
function ccUsageRows(models: unknown): Map<string, Rates> {
  const valid: Array<[string, Rates]> = [];
  for (const [key, row] of isRecord(models) ? Object.entries(models) : []) {
    if (!isRecord(row)) continue;
    const input = toRate(row.input, true);
    const output = toRate(row.output, true);
    if (input === undefined || output === undefined) continue;
    const card: { -readonly [K in keyof Rates]: Rates[K] } = { input, output };
    for (const field of OPTIONAL_RATE_FIELDS) {
      const value = toRate(row[field], true);
      if (value !== undefined) card[field] = value;
    }
    valid.push([key, card]);
  }
  const rows = new Map<string, Rates>();
  for (const [id, { value }] of byNormalisedId(valid).chosen) rows.set(id, value);
  return rows;
}

function sameRates(a: Rates, b: Rates): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    OPTIONAL_RATE_FIELDS.every((field) => a[field] === b[field])
  );
}

/**
 * The entries a cc-usage user actually changed, ready to save as tokenhud overrides.
 *
 * `userPricingJson` is the parsed `~/.config/cc-usage/pricing.json` and
 * `ccUsageBundledJson` the parsed bundled table of cc-usage v2.6.1; both use cc-usage's
 * `{"models": {id: row}}` shape. A user row is kept when its normalised id isn't in the
 * bundled table, or when any rate differs from the bundled row. Rows equal to the bundled
 * ones are dropped, so they can't shadow tokenhud's own (possibly dated, possibly
 * corrected) prices.
 */
export function overridesFromCcUsage(
  userPricingJson: unknown,
  ccUsageBundledJson: unknown,
): { models: Record<string, Rates> } {
  const user = ccUsageRows(isRecord(userPricingJson) ? userPricingJson.models : undefined);
  const bundled = ccUsageRows(isRecord(ccUsageBundledJson) ? ccUsageBundledJson.models : undefined);
  const models: Record<string, Rates> = {};
  for (const [id, card] of user) {
    const original = bundled.get(id);
    if (original === undefined || !sameRates(card, original)) models[id] = card;
  }
  return { models };
}

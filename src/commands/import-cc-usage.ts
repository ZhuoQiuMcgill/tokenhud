// `tokenhud import-cc-usage`: brings a cc-usage user's history and price edits over.
//
// - The usage ledger, through T3's snapshot import (keys dedupe, so it is idempotent).
// - Price overrides: only the rows of cc-usage's pricing.json that differ from cc-usage
//   v2.6.1's bundled table, added to tokenhud's overrides file for models it doesn't
//   override yet. An existing tokenhud override always wins, so a second run adds nothing.
//   An edit to a model that tokenhud prices with dated periods or a fast card is skipped
//   with a warning: an override replaces the whole entry, so cc-usage's one flat card would
//   reprice all of that model's history and drop its fast price.
// - Config (labels, roots, theme) needs tokenhud's config file, which a later task adds.
//
// cc-usage's files are only read: the ledger through a private snapshot copy, pricing.json
// with one read.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ccUsageDir, pricingOverridesPath, storePath } from "../paths.ts";
import ccUsageBundled from "../pricing/cc-usage-v2.6.1-pricing.json";
import { normalizeModel, OFFICIAL_ALIASES } from "../pricing/normalize.ts";
import { overridesFromCcUsage } from "../pricing/overrides.ts";
import { isDated, isRecord, type ModelPricing } from "../pricing/schema.ts";
import { bundledPricing } from "../pricing/table.ts";
import { StoreError } from "../store/errors.ts";
import { ImportSourceError, importCcUsage } from "../store/import-cc-usage.ts";
import { openStore } from "../store/store.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const IMPORT_HELP = `Usage:
  tokenhud import-cc-usage [--from DIR]

Imports cc-usage's usage history and price edits into tokenhud. Safe to run again: rows
already imported are skipped, and existing tokenhud price overrides are kept. An edit to a
model tokenhud prices with dated or fast prices is skipped, with a warning.

Options:
  --from DIR   cc-usage's config directory (default: $XDG_CONFIG_HOME/cc-usage or
               ~/.config/cc-usage)`;

/** `path` with the home directory shown as ~. */
export function shortPath(path: string, home: string = homedir()): string {
  return home !== "" &&
    (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
    ? `~${path.slice(home.length)}`
    : path;
}

export interface PricingImport {
  /** Model ids added to the overrides file. */
  added: string[];
  /** Model ids cc-usage overrides that tokenhud's overrides file already has. */
  kept: string[];
  /** Edits not imported because tokenhud prices the model with more than one flat card. */
  skipped: Array<{ model: string; because: string }>;
  /** Why nothing could be imported, if so. */
  problem: string | null;
}

function readJson(path: string): { value: unknown } | "missing" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  return { value: JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text) };
}

/**
 * Why a flat card can't stand in for `id`'s bundled pricing (dated periods, a fast card),
 * or null when it can. An alias counts as the model it names: the table resolves it so.
 */
function notFlat(id: string): string | null {
  const models: Readonly<Record<string, ModelPricing>> = bundledPricing().models;
  const pricing = models[id] ?? models[OFFICIAL_ALIASES.get(id) ?? ""];
  if (pricing === undefined) return null;
  const dated = isDated(pricing) && pricing.periods.length > 1;
  const cards = isDated(pricing) ? pricing.periods.map((p) => p.card) : [pricing];
  const fast = cards.some((card) => card.fast !== undefined);
  if (dated && fast) return "dated prices and a fast price";
  if (dated) return "dated prices";
  if (fast) return "a fast price";
  return null;
}

/**
 * Adds cc-usage's own price edits to tokenhud's overrides file. Writes the file (atomically)
 * only when something is added; leaves a malformed file alone.
 */
export function importPricing(ccPricingPath: string, overridesPath: string): PricingImport {
  let user: unknown;
  try {
    const read = readJson(ccPricingPath);
    if (read === "missing") return { added: [], kept: [], skipped: [], problem: null };
    user = read.value;
  } catch (error) {
    return {
      added: [],
      kept: [],
      skipped: [],
      problem: `cc-usage's pricing.json is unreadable (${(error as Error).message})`,
    };
  }
  const { models: found } = overridesFromCcUsage(user, ccUsageBundled);
  const skipped: PricingImport["skipped"] = [];
  const edits = Object.entries(found).filter(([id]) => {
    const because = notFlat(id);
    if (because !== null) skipped.push({ model: id, because });
    return because === null;
  });
  if (edits.length === 0) return { added: [], kept: [], skipped, problem: null };

  let existing: Record<string, unknown>;
  try {
    const read = readJson(overridesPath);
    if (read === "missing") {
      existing = {
        _comment:
          "Your price overrides, USD per 1M tokens. " +
          "Each entry replaces that model's bundled prices.",
        models: {},
      };
    } else if (isRecord(read.value) && isRecord(read.value.models)) {
      existing = read.value;
    } else {
      return {
        added: [],
        kept: [],
        skipped,
        problem: `${overridesPath} has no "models" object; left as it is`,
      };
    }
  } catch (error) {
    return {
      added: [],
      kept: [],
      skipped,
      problem: `${overridesPath} is unreadable (${(error as Error).message}); left as it is`,
    };
  }
  const models = { ...(existing.models as Record<string, unknown>) };
  const present = new Set(Object.keys(models).map(normalizeModel));
  const added: string[] = [];
  const kept: string[] = [];
  for (const [id, card] of edits) {
    if (present.has(id)) {
      kept.push(id);
    } else {
      models[id] = card;
      added.push(id);
    }
  }
  if (added.length > 0) {
    mkdirSync(dirname(overridesPath), { recursive: true });
    const tmp = `${overridesPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ ...existing, models }, null, 2)}\n`);
      renameSync(tmp, overridesPath);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  return { added, kept, skipped, problem: null };
}

export function runImportCcUsage(args: readonly string[], env: Env = process.env): number {
  let from: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { from: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      process.stdout.write(`${IMPORT_HELP}\n`);
      return 0;
    }
    if (positionals.length > 0) throw new Error(`unexpected argument '${positionals[0]}'`);
    from = values.from;
  } catch (error) {
    process.stderr.write(`tokenhud import-cc-usage: ${(error as Error).message}\n`);
    return 2;
  }

  const dir = from ?? ccUsageDir(env);
  const say = (line = "") => process.stdout.write(`${line}\n`);
  say(`Importing from ${shortPath(dir)}`);
  let code = 0;

  let store: ReturnType<typeof openStore> | undefined;
  try {
    store = openStore(storePath(env));
    const outcome = importCcUsage(store, join(dir, "ledger.sqlite3"));
    if (outcome.status === "deferred") {
      say(`  usage       not imported: ${outcome.warning}`);
      code = 1;
    } else {
      const n = (x: number) => x.toLocaleString("en-US");
      const counts = [
        `${n(outcome.inserted)} new`,
        `${n(outcome.merged)} updated`,
        `${n(outcome.unchanged)} already here`,
        `${n(outcome.skipped)} skipped`,
      ];
      say(`  usage       ${n(outcome.read)} rows read: ${counts.join(", ")}`);
      say(`              ${n(outcome.accounts)} accounts, ${n(outcome.models)} models`);
    }
  } catch (error) {
    if (error instanceof ImportSourceError && error.reason === "missing") {
      say("  usage       no cc-usage ledger found; nothing to import");
    } else if (error instanceof StoreError) {
      say(`  usage       not imported: ${error.message}`);
      code = 1;
    } else {
      throw error;
    }
  } finally {
    store?.close();
  }

  try {
    const overridesPath = pricingOverridesPath(env);
    const pricing = importPricing(join(dir, "pricing.json"), overridesPath);
    for (const { model, because } of pricing.skipped) {
      say(`  pricing     warning: skipped your cc-usage price for ${model}`);
      say(`              tokenhud prices it with ${because}; one flat price would replace`);
      say("              them for all of its history");
    }
    if (pricing.skipped.length > 0) {
      say("              to use your price anyway, add a dated entry by hand to");
      say(`              ${shortPath(overridesPath)}`);
    }
    if (pricing.problem !== null) {
      say(`  pricing     not imported: ${pricing.problem}`);
      code = 1;
    } else if (pricing.added.length === 0 && pricing.kept.length === 0) {
      if (pricing.skipped.length === 0) {
        say("  pricing     no edited prices in cc-usage; nothing to import");
      }
    } else {
      if (pricing.added.length > 0)
        say(`  pricing     added overrides for ${pricing.added.join(", ")}`);
      if (pricing.kept.length > 0) {
        say(`  pricing     already overridden in tokenhud: ${pricing.kept.join(", ")}`);
      }
    }
  } catch (error) {
    say(`  pricing     not imported: ${(error as Error).message}`);
    code = 1;
  }
  say("  config      not imported: tokenhud has no config file yet");
  return code;
}

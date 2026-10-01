// Builds the OpenAI entries of src/pricing/pricing.json from archived copies of OpenAI's
// pricing page, and prints the evidence for each dated boundary for src/pricing/SOURCES.md.
//
//   bun scripts/extract-openai-pricing.ts <evidence-dir>           # report only
//   bun scripts/extract-openai-pricing.ts <evidence-dir> --write   # also rewrite pricing.json
//
// <evidence-dir> is docs/pricing-history/ in the main checkout. It is evidence, never
// committed. File names carry the capture time in UTC as 14 digits:
//   s_YYYYMMDDhhmmss, wb_YYYYMMDDhhmmss.html   rendered HTML of
//       https://developers.openai.com/api/docs/pricing (gzip or plain)
//   live_YYYYMMDDhhmmss.md        https://developers.openai.com/api/docs/pricing.md
//   changelog_YYYYMMDDhhmmss.md   https://developers.openai.com/api/docs/changelog.md
//
// Rules (docs/tasks/T2-pricing.md §3):
// - a price seen to change between two captures takes effect at the earliest capture that
//   shows the new price, unless an official announcement gives the date (ANNOUNCEMENTS);
// - the first known card also applies to everything before the first capture;
// - "Priority" is the fast tier: the page renamed it "Fast" on 2026-07-30.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isRecord, parsePriceTableFile } from "../src/pricing/schema.ts";

// Every OpenAI model in cc-usage v2.6.1's table, in its order. The task also names
// gpt-6-sol, gpt-5.3-codex and gpt-5.2, which that table already has.
const MODELS = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
];

// Official announcements that date a price change more precisely than the captures do.
// Each quote must appear verbatim in the changelog capture under the given date. The
// changelog gives a date but no time or zone; it is taken as 00:00 UTC (an assumption,
// recorded in SOURCES.md).
const ANNOUNCEMENTS = [
  {
    models: ["gpt-5.6-terra", "gpt-5.6-luna"],
    date: "2026-07-30",
    quote: "Starting July 30, GPT-5.6 Luna costs 80% less, while GPT-5.6 Terra costs 20% less.",
  },
  {
    models: ["gpt-5.6-sol"],
    date: "2026-08-21",
    quote: "GPT-5.6 Sol now costs $4 per million input tokens and $20 per million output tokens",
  },
];

const PRICING_JSON = join(import.meta.dir, "..", "src", "pricing", "pricing.json");
const LIVE_URL = "https://developers.openai.com/api/docs/pricing.md";
const CHANGELOG_URL = "https://developers.openai.com/api/docs/changelog";

type Tier = "standard" | "fast";
interface Prices {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}
type TierPrices = Partial<Record<Tier, Prices>>;
interface Capture {
  file: string;
  at: string; // ISO-8601 UTC
  models: Map<string, TierPrices>;
}
interface LongContext {
  long_context_threshold: number;
  long_context_input_multiplier: number;
  long_context_output_multiplier: number;
}

const TIERS: Record<string, Tier | undefined> = {
  standard: "standard",
  priority: "fast",
  fast: "fast",
};
const TIER_LABELS = new Set(["standard", "batch", "flex", "priority", "fast", "ultrafast"]);

function captureTime(file: string): string {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(file);
  if (!m) throw new Error(`${file}: no YYYYMMDDhhmmss capture time in the name`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

function readText(path: string): string {
  const bytes = readFileSync(path);
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return new TextDecoder().decode(gzip ? Bun.gunzipSync(bytes) : bytes);
}

// "gpt-5.5 (<272K context length)" -> "gpt-5.5"
function modelName(cell: unknown): string | undefined {
  return typeof cell === "string" ? cell.split(" (")[0]?.trim() : undefined;
}

function addPrices(
  into: Map<string, TierPrices>,
  model: string,
  tier: Tier,
  prices: Prices,
  where: string,
) {
  const held = into.get(model) ?? {};
  const before = held[tier];
  if (before !== undefined && !samePrices(before, prices)) {
    throw new Error(`${where}: ${model} ${tier} listed twice with different prices`);
  }
  held[tier] = prices;
  into.set(model, held);
}

function samePrices(a: Prices | undefined, b: Prices | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cache_read === b.cache_read &&
    a.cache_write === b.cache_write
  );
}

function prices(
  input: unknown,
  cached: unknown,
  write: unknown,
  output: unknown,
  where: string,
): Prices {
  const value = (cell: unknown, what: string, required: boolean): number | undefined => {
    if (typeof cell === "number" && Number.isFinite(cell) && cell >= 0) return cell;
    if (typeof cell === "string" && /^\$\d+(\.\d+)?$/.test(cell)) return Number(cell.slice(1));
    if (!required && (cell === "-" || cell === null || cell === undefined)) return undefined;
    throw new Error(`${where}: unexpected ${what} cell ${JSON.stringify(cell)}`);
  };
  const p: Prices = {
    input: value(input, "input", true) as number,
    output: value(output, "output", true) as number,
  };
  const cacheRead = value(cached, "cached input", false);
  const cacheWrite = value(write, "cache write", false);
  if (cacheRead !== undefined) p.cache_read = cacheRead;
  if (cacheWrite !== undefined) p.cache_write = cacheWrite;
  return p;
}

// ---- HTML captures: the tables are Astro islands whose props carry the price rows ----

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" }[lower] ?? "";
  });
}

// Astro serialises island props as [type, payload]: 0 is a plain value (an object's own
// values serialised again), 1 an array of serialised values. The pricing islands use no
// other types.
function astro(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== "number") return value;
  const [type, payload] = value as [number, unknown];
  if (type === 1 && Array.isArray(payload)) return payload.map(astro);
  if (type === 0 && isRecord(payload)) {
    return Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, astro(v)]));
  }
  return payload;
}

function headingLabel(heading: unknown): string | undefined {
  if (typeof heading === "string") return heading;
  if (isRecord(heading)) {
    for (const inner of Object.values(heading)) if (isRecord(inner)) return String(inner.label);
  }
  return undefined;
}

function parseHtml(file: string, text: string): Map<string, TierPrices> {
  const models = new Map<string, TierPrices>();
  const panes = [...text.matchAll(/data-content-switcher-pane="true" data-value="([^"]+)"/g)];
  for (const island of text.matchAll(/<astro-island\b([^>]*)>/g)) {
    const attr = / props="([^"]*)"/.exec(island[1] ?? "");
    if (!attr) continue;
    const props = astro([0, JSON.parse(decodeEntities(attr[1] ?? ""))]);
    if (!isRecord(props)) continue;
    const where = `${file} @${island.index}`;

    // The flagship table, one island per tier tab. A row is [model, input, cached input,
    // cache writes, output], or [model, input, cached input, output] for models without
    // cache writes.
    if (typeof props.tier === "string" && Array.isArray(props.rows)) {
      const tier = TIERS[props.tier];
      if (tier === undefined) continue;
      for (const row of props.rows) {
        const model = Array.isArray(row) ? modelName(row[0]) : undefined;
        if (model === undefined || !MODELS.includes(model)) continue;
        const cells = (row as unknown[]).slice(1);
        const [input, cached, a, b] = cells;
        const p =
          cells.length === 4
            ? prices(input, cached, a, b, `${where} ${model}`)
            : cells.length === 3
              ? prices(input, cached, undefined, a, `${where} ${model}`)
              : undefined;
        if (p === undefined) throw new Error(`${where}: ${model} row has ${cells.length} cells`);
        addPrices(models, model, tier, p, where);
      }
      continue;
    }

    // "Specialized models" (gpt-5.3-codex): grouped by category, columns named by the
    // headings, tier taken from the tab pane the island sits in. Grouped tables without a
    // Category column, such as the Cyber models table, repeat flagship rows and are
    // skipped.
    const headings = Array.isArray(props.headings) ? props.headings.map(headingLabel) : [];
    if (headings[0] !== "Category" || headings[1] !== "Model" || !Array.isArray(props.groups)) {
      continue;
    }
    const pane = panes.filter((p) => (p.index ?? 0) < (island.index ?? 0)).at(-1)?.[1];
    const tier = pane === undefined ? undefined : TIERS[pane];
    if (tier === undefined) continue;
    const column = (name: string) => headings.indexOf(name) - 1;
    for (const group of props.groups) {
      if (!isRecord(group) || !Array.isArray(group.rows)) continue;
      for (const row of group.rows) {
        if (!Array.isArray(row)) continue;
        const model = modelName(row[column("Model")]);
        if (model === undefined || !MODELS.includes(model)) continue;
        const cell = (name: string) => (column(name) < 0 ? undefined : row[column(name)]);
        const p = prices(
          cell("Input"),
          cell("Cached input"),
          cell("Cache writes"),
          cell("Output"),
          `${where} ${model}`,
        );
        addPrices(models, model, tier, p, where);
      }
    }
  }
  return models;
}

// ---- Markdown capture (the live page) ----

function tableRows(lines: string[], start: number): { rows: string[][]; end: number } {
  const rows: string[][] = [];
  let i = start;
  for (; i < lines.length && lines[i]?.trim().startsWith("|"); i++) {
    const cells = (lines[i] as string).trim().slice(1, -1).split("|");
    rows.push(cells.map((c) => c.trim()));
  }
  return { rows, end: i };
}

function parseMarkdown(file: string, text: string) {
  const models = new Map<string, TierPrices>();
  const longContext = new Map<string, Partial<Record<Tier, Prices>>>();
  const lines = text.split("\n");
  let heading = "";
  let label: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.startsWith("### ")) heading = line.slice(4);
    if (TIER_LABELS.has(line.toLowerCase())) label = line.toLowerCase();
    if (!line.startsWith("|")) continue;

    const { rows, end } = tableRows(lines, i);
    i = end - 1;
    const [header = [], , ...body] = rows;
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const main = /^(\w+) pricing data$/.exec(heading);
    let tier: Tier | undefined;
    if (main && header[0] === "Model") tier = TIERS[(main[1] as string).toLowerCase()];
    else if (header[0] === "Category" && header[1] === "Model" && label) tier = TIERS[label];
    if (tier === undefined) continue;

    for (const row of body) {
      const model = modelName(row[col("Model")]);
      if (model === undefined || !MODELS.includes(model)) continue;
      const where = `${file} ${heading} ${model}`;
      const cell = (...names: string[]) => (col(...names) < 0 ? undefined : row[col(...names)]);
      const short = prices(
        cell("Short context input", "Input"),
        cell("Short context cached input", "Cached input"),
        cell("Short context cache writes", "Cache writes"),
        cell("Short context output", "Output"),
        where,
      );
      addPrices(models, model, tier, short, file);
      const longInput = cell("Long context input");
      if (longInput !== undefined && longInput !== "-") {
        const long = prices(
          longInput,
          cell("Long context cached input"),
          cell("Long context cache writes"),
          cell("Long context output"),
          where,
        );
        longContext.set(model, { ...longContext.get(model), [tier]: long });
      }
    }
  }
  const threshold = /Long context: >(\d+)K input tokens/.exec(text);
  if (!threshold) throw new Error(`${file}: no long-context threshold note`);
  return { models, longContext, threshold: Number(threshold[1]) * 1000 };
}

// Long-context settings come from the live page, the only capture with machine-readable
// long-context columns. A multiplier is the long price over the short one, which must
// agree for every column it applies to.
function longContextSettings(
  model: string,
  short: TierPrices,
  long: Partial<Record<Tier, Prices>> | undefined,
  threshold: number,
): { settings?: LongContext; note?: string } {
  if (long?.standard === undefined || short.standard === undefined) return {};
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const inMult = round(long.standard.input / short.standard.input);
  const outMult = round(long.standard.output / short.standard.output);
  const close = (a: number | undefined, b: number | undefined) =>
    a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(1, a));
  for (const tier of ["standard", "fast"] as const) {
    const s = short[tier];
    const l = long[tier];
    if (s === undefined || l === undefined) continue;
    const scale = (x: number | undefined) => (x === undefined ? undefined : x * inMult);
    if (
      !close(l.input, s.input * inMult) ||
      !close(l.cache_read, scale(s.cache_read)) ||
      !close(l.cache_write, scale(s.cache_write)) ||
      !close(l.output, s.output * outMult)
    ) {
      throw new Error(`${model} ${tier}: long-context prices don't follow one multiplier pair`);
    }
  }
  const settings = {
    long_context_threshold: threshold,
    long_context_input_multiplier: inMult,
    long_context_output_multiplier: outMult,
  };
  const note =
    short.fast !== undefined && long.fast === undefined
      ? `${model}: the page lists no long-context Fast price; the standard multipliers are applied`
      : undefined;
  return note === undefined ? { settings } : { settings, note };
}

// ---- changelog ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function announcementDate(changelog: string, quote: string): string | undefined {
  const at = changelog.indexOf(quote);
  if (at < 0) return undefined;
  const before = changelog.slice(0, at);
  const year = [...before.matchAll(/^## \w+, (\d{4})$/gm)].at(-1)?.[1];
  const day = [...before.matchAll(/^### (\w{3}) (\d{1,2})$/gm)].at(-1);
  if (year === undefined || day === undefined) return undefined;
  const month = MONTHS.indexOf(day[1] as string) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${(day[2] as string).padStart(2, "0")}`;
}

// ---- periods ----

interface Period {
  from: string | null;
  prices: TierPrices;
  first: Capture;
  last: Capture;
  evidence?: string;
}

function periodsFor(model: string, captures: Capture[], changelog: string): Period[] {
  const periods: Period[] = [];
  for (const capture of captures) {
    const found = capture.models.get(model);
    if (found === undefined) {
      if (periods.length > 0) throw new Error(`${capture.file}: ${model} disappeared`);
      continue;
    }
    if (found.standard === undefined) {
      throw new Error(`${capture.file}: ${model} has no standard price`);
    }
    const current = periods.at(-1);
    if (current === undefined) {
      periods.push({ from: null, prices: found, first: capture, last: capture });
      continue;
    }
    if ((current.prices.fast === undefined) !== (found.fast === undefined)) {
      throw new Error(`${capture.file}: ${model}'s fast price appeared or disappeared`);
    }
    if (
      samePrices(current.prices.standard, found.standard) &&
      samePrices(current.prices.fast, found.fast)
    ) {
      current.last = capture;
      continue;
    }
    const lastOld = current.last;
    const matches = ANNOUNCEMENTS.filter(
      (a) =>
        a.models.includes(model) &&
        a.date >= lastOld.at.slice(0, 10) &&
        `${a.date}T00:00:00Z` <= capture.at,
    );
    if (matches.length > 1) throw new Error(`${model}: several announcements match ${capture.at}`);
    const announcement = matches[0];
    let from = capture.at;
    let evidence = `price first shown by ${capture.file} (${capture.at}); previous capture ${lastOld.file} (${lastOld.at}) shows the old price`;
    if (announcement !== undefined) {
      const dated = announcementDate(changelog, announcement.quote);
      if (dated !== announcement.date) {
        throw new Error(`changelog: "${announcement.quote}" not found under ${announcement.date}`);
      }
      from = `${announcement.date}T00:00:00Z`;
      evidence = `${CHANGELOG_URL} (${announcement.date}): "${announcement.quote}"; ${evidence}`;
    }
    periods.push({ from, prices: found, first: capture, last: capture, evidence });
  }
  if (periods.length === 0) throw new Error(`${model}: in no capture`);
  return periods;
}

// ---- output ----

function card(found: TierPrices, longContext: LongContext | undefined) {
  const { standard, fast } = found;
  if (standard === undefined) throw new Error("unreachable: periods always have a standard price");
  return {
    input: standard.input,
    output: standard.output,
    ...(standard.cache_read === undefined ? {} : { cache_read: standard.cache_read }),
    ...(standard.cache_write === undefined ? {} : { cache_write: standard.cache_write }),
    ...longContext,
    ...(fast === undefined ? {} : { fast }),
  };
}

// JSON as Biome formats it at lineWidth 100: a container stays on one line when it fits,
// else it opens one entry per line. Biome keeps both forms as they are.
function formatJson(value: unknown, indent = "", prefix = "", suffix = ""): string {
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
    if (isRecord(v)) {
      const entries = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
      return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
    }
    return JSON.stringify(v);
  };
  const flat = inline(value);
  const isContainer = Array.isArray(value) || isRecord(value);
  if (!isContainer || `${indent}${prefix}${flat}${suffix}`.length <= 100) {
    return `${indent}${prefix}${flat}${suffix}`;
  }
  const inner = `${indent}  `;
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v) => ["", v])
    : Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        `${JSON.stringify(k)}: `,
        v,
      ]);
  const body = entries.map(([p, v], i) =>
    formatJson(v, inner, p, i < entries.length - 1 ? "," : ""),
  );
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return [`${indent}${prefix}${open}`, ...body, `${indent}${close}${suffix}`].join("\n");
}

function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { write: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const dir = positionals[0];
  if (dir === undefined) {
    throw new Error("usage: extract-openai-pricing.ts <evidence-dir> [--write]");
  }

  const files = readdirSync(dir).sort((a, b) => captureTime(a).localeCompare(captureTime(b)));
  const captures: Capture[] = [];
  let live: ReturnType<typeof parseMarkdown> | undefined;
  let liveAt = "";
  let changelog = "";
  for (const file of files) {
    const text = readText(join(dir, file));
    if (/^(s|wb)_\d{14}(\.html)?$/.test(file)) {
      captures.push({ file, at: captureTime(file), models: parseHtml(file, text) });
    } else if (/^live_\d{14}\.md$/.test(file)) {
      live = parseMarkdown(file, text);
      liveAt = captureTime(file);
      captures.push({ file, at: liveAt, models: live.models });
    } else if (/^changelog_\d{14}\.md$/.test(file)) {
      changelog = text;
    }
  }
  if (live === undefined) throw new Error(`${dir}: no live_*.md capture`);
  if (changelog === "") throw new Error(`${dir}: no changelog_*.md capture`);
  const latest = live;

  const out = [`OpenAI captures: ${captures.length}, ${captures[0]?.at} to ${liveAt}`, ""];
  const boundaries = [
    "| Model | Effective from | Change (standard; fast) | Evidence |",
    "| --- | --- | --- | --- |",
  ];
  const entries: Record<string, unknown> = {};
  const show = (p: Prices | undefined) =>
    p === undefined
      ? "none"
      : `$${p.input}/$${p.output} (cached $${p.cache_read ?? "-"}, writes $${p.cache_write ?? "-"})`;
  for (const model of MODELS) {
    const periods = periodsFor(model, captures, changelog);
    const lastPrices = periods.at(-1)?.prices ?? {};
    const lc = longContextSettings(
      model,
      lastPrices,
      latest.longContext.get(model),
      latest.threshold,
    );
    if (lc.note) out.push(`note: ${lc.note}`);
    for (const [i, p] of periods.entries()) {
      out.push(
        `${model} from ${p.from ?? "the start"}: standard ${show(p.prices.standard)}; fast ${show(p.prices.fast)}; ` +
          `seen ${p.first.file} .. ${p.last.file}`,
      );
      const previous = periods[i - 1];
      if (previous !== undefined) {
        boundaries.push(
          `| ${model} | ${p.from} | ${show(previous.prices.standard)} -> ${show(p.prices.standard)}; ` +
            `${show(previous.prices.fast)} -> ${show(p.prices.fast)} | ${p.evidence} |`,
        );
      }
    }
    const cards = periods.map((p) => ({ from: p.from, card: card(p.prices, lc.settings) }));
    entries[model] = cards.length === 1 ? cards[0]?.card : { periods: cards };
  }
  console.log([...out, "", ...boundaries].join("\n"));

  if (values.write) {
    const table = JSON.parse(readFileSync(PRICING_JSON, "utf8")) as Record<string, unknown>;
    const models = { ...(table.models as Record<string, unknown>), ...entries };
    const sources = table.sources as Record<string, unknown>;
    const next = {
      ...table,
      sources: { ...sources, openai: { url: LIVE_URL, checked: liveAt.slice(0, 10) } },
      models,
    };
    parsePriceTableFile(next); // never write a table the app would reject
    writeFileSync(PRICING_JSON, `${formatJson(next)}\n`);
    console.log(`\nwrote ${PRICING_JSON}`);
  }
}

main();

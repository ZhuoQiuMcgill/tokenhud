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
// Rules (docs/tasks/T2-pricing.md §3, and the T2 review rulings):
// - a change seen between two captures takes effect at the earliest capture that shows it,
//   unless an official announcement gives the date (ANNOUNCEMENTS);
// - the first known card also applies to everything before the first capture;
// - "Priority" is the fast tier: the page renamed it "Fast" on 2026-07-30;
// - a long-context price is only ever read off the page, per tier, per capture. A tier
//   whose table shows no long-context price for a model gets none.
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

type Change = "price" | "fast-long-context" | "standard-long-context";

// Official announcements that date a change more precisely than the captures do. Each
// quote must appear verbatim in the changelog capture under the given date, and must match
// the kind of change the captures show. The changelog gives a date but no time or zone; it
// is read as 00:00 America/Los_Angeles, where OpenAI is based (see SOURCES.md).
const ANNOUNCEMENTS: ReadonlyArray<{
  models: readonly string[];
  date: string;
  change: Change;
  quote: string;
}> = [
  {
    models: ["gpt-5.6-terra", "gpt-5.6-luna"],
    date: "2026-07-30",
    change: "price",
    quote: "Starting July 30, GPT-5.6 Luna costs 80% less, while GPT-5.6 Terra costs 20% less.",
  },
  {
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    date: "2026-08-05",
    change: "fast-long-context",
    quote:
      "Fast mode now supports long-context requests for GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna.",
  },
  {
    models: ["gpt-5.6-sol"],
    date: "2026-08-21",
    change: "price",
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
// What one capture shows for one model and tier. `long` is the long-context prices, null
// when the table shows none for the model, and undefined when this capture doesn't show
// the row at all (later captures collapse all but the newest models).
interface Observed {
  short: Prices;
  long?: Prices | null;
}
type TierObservations = Partial<Record<Tier, Observed>>;
interface Capture {
  file: string;
  at: string; // ISO-8601 UTC
  models: Map<string, TierObservations>;
}
interface Multipliers {
  input: number;
  output: number;
}
interface State {
  standard: Prices;
  fast: Prices | undefined;
  standardLong: Multipliers | null;
  fastLong: Multipliers | null;
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

// 00:00 in Los Angeles on `day`, as an ISO-8601 UTC time: 07:00Z in summer, 08:00Z in
// winter.
function pacificMidnight(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const hour of [7, 8]) {
    const at = new Date(Date.UTC(y, m - 1, d, hour));
    if (local.format(at) === `${day}, 00:00`) return at.toISOString().replace(".000Z", "Z");
  }
  throw new Error(`${day}: no Pacific midnight found`);
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

function samePrices(a: Prices | undefined, b: Prices | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cache_read === b.cache_read &&
    a.cache_write === b.cache_write
  );
}

function sameMultipliers(a: Multipliers | null, b: Multipliers | null): boolean {
  if (a === null || b === null) return a === b;
  return a.input === b.input && a.output === b.output;
}

function observe(
  into: Map<string, TierObservations>,
  model: string,
  tier: Tier,
  seen: Observed,
  where: string,
) {
  const held = into.get(model) ?? {};
  const before = held[tier];
  if (before !== undefined) {
    const longDiffers =
      before.long !== undefined &&
      seen.long !== undefined &&
      !(before.long === seen.long || samePrices(before.long ?? undefined, seen.long ?? undefined));
    if (!samePrices(before.short, seen.short) || longDiffers) {
      throw new Error(`${where}: ${model} ${tier} listed twice with different prices`);
    }
  }
  // null ("no long-context price") is an observation; only undefined means "not shown".
  const long = seen.long !== undefined ? seen.long : before?.long;
  held[tier] = long === undefined ? { short: seen.short } : { short: seen.short, long };
  into.set(model, held);
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

// Long-context prices from four cells, or null when the page shows "-" for all of them.
function longPrices(cells: readonly unknown[], where: string): Prices | null {
  if (cells.every((c) => c === "-")) return null;
  const [input, cached, write, output] = cells;
  return prices(input, cached, write, output, where);
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

const cellText = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

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

// The flagship island's server-rendered table, which holds what its props don't: the
// long-context columns. Rows are [model, 4 short-context cells] when the table has no
// long-context columns (Priority/Fast until 2026-08-05), else [model, 4 short, 4 long].
// Later captures render only the newest few rows; the rest appear after hydration.
function renderedRows(text: string, from: number): Map<string, string[]> {
  const start = text.indexOf("<table", from);
  const table = text.slice(start, text.indexOf("</table>", start));
  const rows = new Map<string, string[]>();
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      cellText(m[1] ?? ""),
    );
    const model = modelName(cells[0]);
    if (model !== undefined && MODELS.includes(model)) rows.set(model, cells.slice(1));
  }
  return rows;
}

function parseHtml(file: string, text: string): Map<string, TierObservations> {
  const models = new Map<string, TierObservations>();
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
      const rendered = renderedRows(text, island.index ?? 0);
      for (const row of props.rows) {
        const model = Array.isArray(row) ? modelName(row[0]) : undefined;
        if (model === undefined || !MODELS.includes(model)) continue;
        const at = `${where} ${model}`;
        const cells = (row as unknown[]).slice(1);
        const [input, cached, a, b] = cells;
        const short =
          cells.length === 4
            ? prices(input, cached, a, b, at)
            : cells.length === 3
              ? prices(input, cached, undefined, a, at)
              : undefined;
        if (short === undefined) throw new Error(`${at}: row has ${cells.length} cells`);

        let long: Prices | null | undefined;
        const shown = rendered.get(model);
        if (shown !== undefined) {
          const [ri, rc, rw, ro] = shown;
          if (!samePrices(prices(ri, rc, rw, ro, at), short)) {
            throw new Error(`${at}: rendered row disagrees with the island's props`);
          }
          if (shown.length === 4) long = null;
          else if (shown.length === 8) long = longPrices(shown.slice(4), at);
          else throw new Error(`${at}: rendered row has ${shown.length} cells`);
        }
        observe(models, model, tier, long === undefined ? { short } : { short, long }, where);
      }
      continue;
    }

    // "Specialized models" (gpt-5.3-codex): grouped by category, columns named by the
    // headings, tier taken from the tab pane the island sits in. It has no long-context
    // columns. Grouped tables without a Category column, such as the Cyber models table,
    // repeat flagship rows and are skipped.
    const headings = Array.isArray(props.headings) ? props.headings.map(headingLabel) : [];
    if (headings[0] !== "Category" || headings[1] !== "Model" || !Array.isArray(props.groups)) {
      continue;
    }
    if (headings.some((h) => h?.startsWith("Long context"))) {
      throw new Error(`${where}: a specialized table with long-context columns`);
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
        const short = prices(
          cell("Input"),
          cell("Cached input"),
          cell("Cache writes"),
          cell("Output"),
          `${where} ${model}`,
        );
        observe(models, model, tier, { short, long: null }, where);
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
  const models = new Map<string, TierObservations>();
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
      const long =
        col("Long context input") < 0
          ? null
          : longPrices(
              [
                cell("Long context input"),
                cell("Long context cached input"),
                cell("Long context cache writes"),
                cell("Long context output"),
              ],
              where,
            );
      observe(models, model, tier, { short, long }, file);
    }
  }
  const threshold = /Long context: >(\d+)K input tokens/.exec(text);
  if (!threshold) throw new Error(`${file}: no long-context threshold note`);
  return { models, threshold: Number(threshold[1]) * 1000 };
}

// A long-context multiplier is the long price over the short one. It must be the same for
// input, cached input and cache writes, so a pair of multipliers reproduces every column.
function multipliers(short: Prices, long: Prices | null, where: string): Multipliers | null {
  if (long === null) return null;
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const m = { input: round(long.input / short.input), output: round(long.output / short.output) };
  const close = (a: number | undefined, b: number | undefined) =>
    a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(1, a));
  const scale = (x: number | undefined) => (x === undefined ? undefined : x * m.input);
  if (
    !close(long.input, short.input * m.input) ||
    !close(long.cache_read, scale(short.cache_read)) ||
    !close(long.cache_write, scale(short.cache_write)) ||
    !close(long.output, short.output * m.output)
  ) {
    throw new Error(`${where}: long-context prices don't follow one multiplier pair`);
  }
  return m;
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
  state: State;
  first: Capture;
  last: Capture;
  change?: Change;
  evidence?: string;
}

// Per capture, the model's state. A long-context observation a capture doesn't show is
// carried forward from the previous capture, or back from the first that shows one.
function statesFor(model: string, captures: Capture[]): Array<[Capture, State]> {
  const seen = captures.filter((c) => c.models.has(model));
  if (seen.length === 0) throw new Error(`${model}: in no capture`);
  const longFor = (tier: Tier): Array<Prices | null | undefined> => {
    const list = seen.map((c) => c.models.get(model)?.[tier]?.long);
    for (let i = 1; i < list.length; i++) if (list[i] === undefined) list[i] = list[i - 1];
    for (let i = list.length - 2; i >= 0; i--) if (list[i] === undefined) list[i] = list[i + 1];
    return list;
  };
  const standardLong = longFor("standard");
  const fastLong = longFor("fast");
  return seen.map((capture, i) => {
    const found = capture.models.get(model) as TierObservations;
    const where = `${capture.file} ${model}`;
    if (found.standard === undefined) throw new Error(`${where}: no standard price`);
    const sLong = standardLong[i];
    const fLong = fastLong[i];
    if (sLong === undefined)
      throw new Error(`${model}: no capture shows its standard long context`);
    if (found.fast !== undefined && fLong === undefined) {
      throw new Error(`${model}: no capture shows its fast long context`);
    }
    return [
      capture,
      {
        standard: found.standard.short,
        fast: found.fast?.short,
        standardLong: multipliers(found.standard.short, sLong, `${where} standard`),
        fastLong:
          found.fast === undefined
            ? null
            : multipliers(found.fast.short, fLong ?? null, `${where} fast`),
      },
    ];
  });
}

function changeOf(a: State, b: State): Change[] {
  const changes: Change[] = [];
  if (!samePrices(a.standard, b.standard) || !samePrices(a.fast, b.fast)) changes.push("price");
  if (!sameMultipliers(a.fastLong, b.fastLong)) changes.push("fast-long-context");
  if (!sameMultipliers(a.standardLong, b.standardLong)) changes.push("standard-long-context");
  return changes;
}

function periodsFor(model: string, captures: Capture[], changelog: string): Period[] {
  const periods: Period[] = [];
  for (const [capture, state] of statesFor(model, captures)) {
    const current = periods.at(-1);
    if (current === undefined) {
      periods.push({ from: null, state, first: capture, last: capture });
      continue;
    }
    if ((current.state.fast === undefined) !== (state.fast === undefined)) {
      throw new Error(`${capture.file}: ${model}'s fast price appeared or disappeared`);
    }
    const changes = changeOf(current.state, state);
    if (changes.length === 0) {
      current.last = capture;
      continue;
    }
    if (changes.length > 1) {
      throw new Error(`${capture.file}: ${model} changed ${changes.join(" and ")} at once`);
    }
    const change = changes[0] as Change;
    const lastOld = current.last;
    const matches = ANNOUNCEMENTS.filter(
      (a) =>
        a.models.includes(model) &&
        a.change === change &&
        a.date >= lastOld.at.slice(0, 10) &&
        pacificMidnight(a.date) <= capture.at,
    );
    if (matches.length > 1) throw new Error(`${model}: several announcements match ${capture.at}`);
    const announcement = matches[0];
    let from = capture.at;
    let evidence = `first shown by ${capture.file} (${capture.at}); previous capture ${lastOld.file} (${lastOld.at}) shows the old state`;
    if (announcement !== undefined) {
      const dated = announcementDate(changelog, announcement.quote);
      if (dated !== announcement.date) {
        throw new Error(`changelog: "${announcement.quote}" not found under ${announcement.date}`);
      }
      from = pacificMidnight(announcement.date);
      evidence = `${CHANGELOG_URL} (${announcement.date}): "${announcement.quote}"; ${evidence}`;
    }
    periods.push({ from, state, first: capture, last: capture, change, evidence });
  }
  return periods;
}

// ---- output ----

function card(state: State, threshold: number) {
  const { standard, fast, standardLong, fastLong } = state;
  if (fastLong !== null && standardLong === null) {
    throw new Error("a long-context fast price needs a long-context standard price");
  }
  const cache = (p: Prices) => ({
    ...(p.cache_read === undefined ? {} : { cache_read: p.cache_read }),
    ...(p.cache_write === undefined ? {} : { cache_write: p.cache_write }),
  });
  return {
    input: standard.input,
    output: standard.output,
    ...cache(standard),
    ...(standardLong === null
      ? {}
      : {
          long_context_threshold: threshold,
          long_context_input_multiplier: standardLong.input,
          long_context_output_multiplier: standardLong.output,
        }),
    ...(fast === undefined
      ? {}
      : {
          fast: {
            input: fast.input,
            output: fast.output,
            ...cache(fast),
            ...(fastLong === null
              ? {}
              : {
                  long_context_input_multiplier: fastLong.input,
                  long_context_output_multiplier: fastLong.output,
                }),
          },
        }),
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

const showPrices = (p: Prices | undefined) =>
  p === undefined
    ? "none"
    : `$${p.input}/$${p.output} (cached $${p.cache_read ?? "-"}, writes $${p.cache_write ?? "-"})`;
const showLong = (m: Multipliers | null) =>
  m === null ? "no long-context price" : `long context ${m.input}x/${m.output}x`;

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
  let threshold: number | undefined;
  let liveAt = "";
  let changelog = "";
  for (const file of files) {
    const text = readText(join(dir, file));
    if (/^(s|wb)_\d{14}(\.html)?$/.test(file)) {
      captures.push({ file, at: captureTime(file), models: parseHtml(file, text) });
    } else if (/^live_\d{14}\.md$/.test(file)) {
      const live = parseMarkdown(file, text);
      threshold = live.threshold;
      liveAt = captureTime(file);
      captures.push({ file, at: liveAt, models: live.models });
    } else if (/^changelog_\d{14}\.md$/.test(file)) {
      changelog = text;
    }
  }
  if (threshold === undefined) throw new Error(`${dir}: no live_*.md capture`);
  if (changelog === "") throw new Error(`${dir}: no changelog_*.md capture`);

  const out = [`OpenAI captures: ${captures.length}, ${captures[0]?.at} to ${liveAt}`, ""];
  const boundaries = [
    "| Model | Effective from | Change | Evidence |",
    "| --- | --- | --- | --- |",
  ];
  const entries: Record<string, unknown> = {};
  for (const model of MODELS) {
    const periods = periodsFor(model, captures, changelog);
    for (const [i, p] of periods.entries()) {
      const { standard, fast, standardLong, fastLong } = p.state;
      out.push(
        `${model} from ${p.from ?? "the start"}: standard ${showPrices(standard)}, ${showLong(standardLong)}; ` +
          `fast ${showPrices(fast)}, ${showLong(fastLong)}; seen ${p.first.file} .. ${p.last.file}`,
      );
      const previous = periods[i - 1];
      if (previous === undefined) continue;
      const what =
        p.change === "price"
          ? `${showPrices(previous.state.standard)} -> ${showPrices(standard)}; ` +
            `fast ${showPrices(previous.state.fast)} -> ${showPrices(fast)}`
          : p.change === "fast-long-context"
            ? `fast: ${showLong(previous.state.fastLong)} -> ${showLong(fastLong)}`
            : `standard: ${showLong(previous.state.standardLong)} -> ${showLong(standardLong)}`;
      boundaries.push(`| ${model} | ${p.from} | ${what} | ${p.evidence} |`);
    }
    const cards = periods.map((p) => ({ from: p.from, card: card(p.state, threshold) }));
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

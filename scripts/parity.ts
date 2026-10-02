// `bun run parity [--json] [--python PATH] [--tz ZONE]`: the M1 exit gate
// (docs/ARCHITECTURE.md §12). It compares tokenhud with cc-usage v2.6.1 on this machine's
// real data, per local day × account × model × speed tier, in tokens by type and in cost,
// and requires every difference to be one of the known fixes (§6.4), each checked row by
// row against an independent derivation (scripts/parity/classify.ts), or it fails.
//
// What it runs, all in a temp dir that is removed at the end:
// 1. A snapshot copy of cc-usage's ledger, taken as `tokenhud import-cc-usage` takes it.
// 2. A tokenhud store built as a cc-usage user's first run builds it: config and price
//    edits imported from cc-usage's files, the ledger copy imported, then one full ingest
//    pass over every real root, Claude and Codex.
// 3. cc-usage's side (scripts/parity_cc_usage.py, under cc-usage's interpreter): the ledger
//    copy priced with cc-usage's own compute_cost and pricing, and cc-usage's own parser
//    run over the Codex rollouts, with each record's tier and replay status read from its
//    rollout's structure by the script's own code.
// 4. tokenhud's numbers: T6's queries over the temp store.
//
// "Now" is pinned to the ledger copy's newest row: tokenhud rows after it are counted, not
// compared. Read-only on the user's data: provider dirs are only read, and cc-usage's files
// only through the import's reads. Output is content-free: account labels, model ids, dates
// and numbers. Exits 1 if anything is unexplained or out of bounds, 2 if it could not run.
// Not a CI test: it needs the real data.

import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { importPricing } from "../src/commands/import-cc-usage.ts";
import { ccUsageDir, ensureConfig } from "../src/config.ts";
import { IngestEngine, transcriptDirs } from "../src/ingest/engine.ts";
import { walk } from "../src/ingest/files.ts";
import { mergePricing, readOverrides } from "../src/pricing/overrides.ts";
import bundledJson from "../src/pricing/pricing.json";
import { isDated, type ModelPricing, parseModelPricing } from "../src/pricing/schema.ts";
import { bundledPricing, PriceTable } from "../src/pricing/table.ts";
import { UsageQueries } from "../src/query/engine.ts";
import { addDays, type LocalDate, Zone } from "../src/query/tz.ts";
import { snapshotLedger } from "../src/store/import-cc-usage.ts";
import { openStoreReader } from "../src/store/store.ts";
import {
  CATEGORIES,
  type Cells,
  type CodexRecord,
  judge,
  type Row,
  type Verdict,
} from "./parity/classify.ts";
import { type Card, IndependentPrices } from "./parity/independent.ts";

const CC_USAGE_VERSION = "2.6.1";

type RawPricing = ConstructorParameters<typeof IndependentPrices>[0];
type RawOverrides = ConstructorParameters<typeof IndependentPrices>[1];

function readRows(db: Database, withTier: boolean): Row[] {
  const tier = withTier ? "u.tier" : "0";
  return db
    .query<Record<string, unknown>, []>(
      `SELECT u.key AS key, a.identity AS identity, a.provider AS provider, u.ts AS ts,
              m.name AS model, u.inp AS inp, u.outp AS outp, u.cr AS cr, u.cc AS cc,
              u.e5 AS e5, u.e1 AS e1, ${tier} AS tier
       FROM usage u JOIN accounts a ON a.id = u.acct JOIN models m ON m.id = u.model`,
    )
    .all()
    .map((r) => ({
      key: r.key as bigint,
      identity: String(r.identity),
      provider: String(r.provider),
      ts: Number(r.ts),
      model: String(r.model),
      inp: Number(r.inp),
      outp: Number(r.outp),
      cr: Number(r.cr),
      cc: Number(r.cc),
      e5: r.e5 === null ? null : Number(r.e5),
      e1: r.e1 === null ? null : Number(r.e1),
      tier: Number(r.tier),
    }));
}

/** tokenhud's answer through T6's queries: per (account, local day), by model and tier. */
function queryCells(
  storePath: string,
  table: PriceTable,
  zone: Zone,
  now: number,
  wanted: Array<[identity: string, day: string]>,
): Cells {
  const db = openStoreReader(storePath);
  if (db === null) throw new Error("the temp store was not created");
  try {
    const q = new UsageQueries(db, table, { tz: zone.name, now: () => now });
    const ids = new Map(
      db
        .query<{ id: bigint; identity: string }, []>("SELECT id, identity FROM accounts")
        .all()
        .map((a) => [a.identity, Number(a.id)]),
    );
    const cells: Cells = new Map();
    for (const [identity, day] of wanted) {
      const id = ids.get(identity);
      if (id === undefined) continue;
      const [y, m, d] = day.split("-").map(Number) as [number, number, number];
      const date: LocalDate = { year: y, month: m, day: d };
      const from = zone.startOf(date);
      const to = Math.min(zone.startOf(addDays(date, 1)), now + 1);
      for (const g of q.byModel({ range: { from, to }, accounts: [id] })) {
        cells.set(`${day}|${identity}|${g.model}|${g.tier}`, {
          inp: g.usage.tokens.input,
          outp: g.usage.tokens.output,
          cr: g.usage.tokens.cacheRead,
          cc: g.usage.tokens.cacheWrite,
          cost: g.usage.cost,
          rows: g.usage.records,
        });
      }
    }
    return cells;
  } finally {
    db.close();
  }
}

/** cc-usage's interpreter: --python, $CC_USAGE_PYTHON, or the one the `ccusage` launcher names. */
function findPython(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const env = process.env.CC_USAGE_PYTHON;
  if (env) return env;
  const launcher = Bun.which("ccusage");
  if (launcher !== null) {
    const first = readFileSync(launcher, "utf8").split("\n", 1)[0] ?? "";
    if (first.startsWith("#!")) return first.slice(2).trim();
  }
  throw new Error("cannot find cc-usage's Python: pass --python or set CC_USAGE_PYTHON");
}

interface PythonSide {
  version: string;
  pricing: Record<string, Card>;
  cells: [string, string, string, number, number, number, number, number, number][];
  codex: [string, number, string, number, number, number, number, number][];
}

interface Report extends Verdict {
  cc_usage_version: string;
  time_zone: string;
  pinned_now: string;
  ingest: { imported: number | null; logs: string[]; wall_ms: number; rollouts: number };
}

async function run(options: {
  python: string | undefined;
  tz: string | undefined;
}): Promise<Report> {
  const python = findPython(options.python);
  const zone = options.tz === undefined ? Zone.system() : Zone.of(options.tz);
  const ccDir = ccUsageDir();
  const tmp = mkdtempSync(join(tmpdir(), "tokenhud-parity-"));
  try {
    // 1. The ledger copy both sides read.
    const scratch = join(tmp, "ledger");
    mkdirSync(scratch);
    const ledger = snapshotLedger(join(ccDir, "ledger.sqlite3"), scratch);
    if (ledger === null) throw new Error("cc-usage kept writing its ledger; run parity again");

    // 2. tokenhud as a cc-usage user's first run builds it, in the temp dir.
    const overridesPath = join(tmp, "pricing.overrides.json");
    const edits = importPricing(join(ccDir, "pricing.json"), overridesPath);
    if (edits.problem !== null) throw new Error(`price edits: ${edits.problem}`);
    const config = ensureConfig(join(tmp, "config.json"), join(ccDir, "config.json")).config;
    const storePath = join(tmp, "tokenhud.db");
    const logs: string[] = [];
    const t0 = performance.now();
    const engine = IngestEngine.open({
      storePath,
      cachePath: join(tmp, "cache.db"),
      config,
      discover: { home: homedir(), env: { ...process.env } },
      importLedger: ledger,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
    let imported: number | null = null;
    let rollouts: string[];
    try {
      engine.recover();
      const outcome = engine.importIfFirstRun();
      imported = outcome?.status === "imported" ? outcome.inserted : null;
      const pass = await engine.fullPass();
      if (pass === null || pass.storeError !== null) throw new Error("the ingest pass failed");
      rollouts = engine.roots
        .filter((root) => root.provider === "codex")
        .flatMap((root) => transcriptDirs(root).flatMap((dir) => walk(dir).files));
    } finally {
      engine.close();
    }
    const wallMs = performance.now() - t0;

    // 3. cc-usage's side, from the same ledger copy and the same rollouts.
    const pyXdg = join(tmp, "py-xdg");
    mkdirSync(join(pyXdg, "cc-usage"), { recursive: true });
    if (existsSync(join(ccDir, "pricing.json"))) {
      copyFileSync(join(ccDir, "pricing.json"), join(pyXdg, "cc-usage", "pricing.json"));
    }
    const rolloutList = join(tmp, "rollouts.txt");
    writeFileSync(rolloutList, rollouts.join("\n"));
    const out = join(tmp, "cc-usage.json");
    const proc = Bun.spawnSync(
      [python, join(import.meta.dir, "parity_cc_usage.py"), ledger, zone.name, out, rolloutList],
      { env: { ...process.env, XDG_CONFIG_HOME: pyXdg }, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(
        `cc-usage's side failed (exit ${proc.exitCode}): ${proc.stderr.toString().slice(-500)}`,
      );
    }
    const py = JSON.parse(readFileSync(out, "utf8")) as PythonSide;
    if (py.version !== CC_USAGE_VERSION) {
      throw new Error(`expected cc-usage ${CC_USAGE_VERSION}, found ${py.version}`);
    }

    // The rows on both sides.
    const ledgerDb = new Database(ledger, { readwrite: true, safeIntegers: true });
    const ledgerRows = readRows(ledgerDb, false);
    ledgerDb.close();
    const storeDb = openStoreReader(storePath) as Database;
    const ours = readRows(storeDb, true);
    const tombstones = new Map(
      storeDb
        .query<{ key: bigint; reason: string }, []>("SELECT key, reason FROM dropped_keys")
        .all()
        .map((t) => [t.key, t.reason]),
    );
    const labels = new Map(
      storeDb
        .query<{ identity: string; label: string }, []>("SELECT identity, label FROM accounts")
        .all()
        .map((a) => [a.identity, a.label]),
    );
    storeDb.close();
    const now = ledgerRows.reduce((m, r) => Math.max(m, r.ts), 0);

    // tokenhud's price tables for the walk: cc-usage's flat cards in place of the dated
    // models, then tokenhud's periods, then its estimated aliases too.
    const bundled = bundledPricing();
    const models = mergePricing(bundled.models, readOverrides(overridesPath).models);
    const flat: Record<string, ModelPricing> = { ...models };
    for (const [id, entry] of Object.entries(models)) {
      if (!isDated(entry)) continue;
      const card = py.pricing[id];
      if (card === undefined) delete flat[id];
      else flat[id] = parseModelPricing(card, `cc-usage pricing ${id}`, { coerce: false });
    }
    const tables = {
      flat: new PriceTable(flat),
      dated: new PriceTable(models),
      full: new PriceTable(models, bundled.aliases),
    };
    // The independent reading takes the raw files, not tokenhud's parsed table.
    const independent = new IndependentPrices(
      bundledJson as RawPricing,
      existsSync(overridesPath)
        ? (JSON.parse(readFileSync(overridesPath, "utf8")) as RawOverrides)
        : {},
      py.pricing,
    );
    const codex = new Map<bigint, CodexRecord>(
      py.codex.map(([key, ts, model, inp, outp, cr, tier, replay]) => [
        BigInt(key),
        { ts, model, inp, outp, cr, tier, replay: replay === 1 },
      ]),
    );
    const theirs: Cells = new Map(
      py.cells.map(([day, identity, model, inp, outp, cr, cc, cost, rows]) => [
        `${day}|${identity}|${model}|standard`,
        { inp, outp, cr, cc, cost, rows },
      ]),
    );

    const verdict = judge({
      zone,
      now,
      ledger: ledgerRows,
      ours,
      tombstones,
      codex,
      tables,
      independent,
      theirs,
      query: (wanted) => queryCells(storePath, tables.full, zone, now, wanted),
      labels,
    });
    return {
      ...verdict,
      cc_usage_version: py.version,
      time_zone: zone.name,
      pinned_now: zone.iso(now),
      ingest: { imported, logs, wall_ms: Math.round(wallMs), rollouts: rollouts.length },
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ── output ───────────────────────────────────────────────────────────────────────

const n = (x: number) => x.toLocaleString("en-US");
const usd = (x: number) =>
  `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function render(r: Report): string {
  const out: string[] = [];
  out.push(
    `tokenhud vs cc-usage ${r.cc_usage_version}: ${n(r.cells)} cells (local day × account × model × tier)`,
    `time zone ${r.time_zone}; now pinned to the ledger copy's newest row, ${r.pinned_now.slice(0, 16).replace("T", " ")}`,
    "",
  );
  const rows = [
    ["category", "cells", "rows", "Δ tokens", "Δ $"],
    ...[...CATEGORIES, "unexplained" as const].map((name) => {
      const c = r.categories[name];
      return [name, n(c.cells), n(c.rows), n(c.tokens), usd(c.usd)];
    }),
  ];
  const widths = (rows[0] as string[]).map((_, i) =>
    Math.max(...rows.map((row) => (row[i] as string).length)),
  );
  for (const row of rows) {
    out.push(
      row
        .map((cell, i) =>
          i === 0 ? cell.padEnd(widths[i] as number) : cell.padStart(widths[i] as number),
        )
        .join("   "),
    );
  }
  out.push(
    "",
    `cc-usage   ${n(r.totals.cc_usage.rows)} rows, ${n(r.totals.cc_usage.tokens)} tokens, ${usd(r.totals.cc_usage.usd)}`,
    `tokenhud   ${n(r.totals.tokenhud.rows)} rows, ${n(r.totals.tokenhud.tokens)} tokens, ${usd(r.totals.tokenhud.usd)}`,
    `after the pinned now (new-data, not compared): ${n(r.after_now.rows)} rows, ${n(r.after_now.tokens)} tokens`,
    `ingest: ${r.ingest.imported === null ? "nothing" : n(r.ingest.imported)} ledger rows imported, full pass ${n(r.ingest.wall_ms)} ms; cc-usage's parser read ${n(r.ingest.rollouts)} Codex rollouts`,
  );
  if (r.unexplained.cells.length > 0) {
    out.push("", "unexplained cells (first 20):");
    for (const c of r.unexplained.cells.slice(0, 20)) {
      out.push(
        `  ${c.day} ${c.account} ${c.model} ${c.tier}: ${n(c.tokens)} tokens, ${usd(c.usd)} (${c.at})`,
      );
    }
  }
  for (const [kind, count] of Object.entries(r.unexplained.rows)) {
    out.push(`unexplained rows: ${n(count)} × ${kind}`);
  }
  for (const b of r.bounds_failed) out.push(`out of bounds: ${b}`);
  out.push("", r.passed ? "PASS" : "FAIL");
  return out.join("\n");
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    json: { type: "boolean" },
    python: { type: "string" },
    tz: { type: "string" },
  },
  strict: true,
});
try {
  const report = await run({ python: values.python, tz: values.tz });
  process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : render(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`parity: ${(error as Error).message}\n`);
  process.exitCode = 2;
}

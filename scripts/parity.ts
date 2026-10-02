// `bun run parity [--json] [--python PATH] [--tz ZONE]`: the M1 exit gate
// (docs/ARCHITECTURE.md §12). It compares tokenhud with cc-usage v2.6.1 on this machine's
// real data, per local day × account × model × speed tier, in tokens by type and in cost,
// and explains every difference by one of the known fixes (§6.4), or fails.
//
// What it runs, all in a temp dir that is removed at the end:
// 1. A snapshot copy of cc-usage's ledger, taken as `tokenhud import-cc-usage` takes it.
// 2. A tokenhud store built as a cc-usage user's first run builds it: config and price
//    edits imported from cc-usage's files, the ledger copy imported, then one full ingest
//    pass over every real root, Claude and Codex.
// 3. cc-usage's own numbers: scripts/parity_cc_usage.py prices the ledger copy with
//    cc-usage's compute_cost and pricing, under cc-usage's interpreter.
// 4. tokenhud's numbers: T6's queries over the temp store.
//
// Between them it walks cc-usage's rows to tokenhud's one fix at a time and attributes each
// step's change to its category:
//   base -> replay (Codex scheme-2 removal) -> dated-price (GPT-5.6 periods) -> tier
//   (priority/fast) -> estimated (codex-auto-review) -> new-data (written after cc-usage's
//   last sync) -> tokenhud's queries.
// Whatever is left (cc-usage's own numbers against the base, tokenhud's queries against
// the last step, and any row no fix accounts for) is `unexplained`. It exits 1 if anything
// is unexplained or a category leaves its expected bounds, 2 if it could not run.
//
// "Now" is pinned to the ledger copy's newest row: tokenhud rows after it are new-data,
// counted but not compared. Read-only on the user's data: provider dirs are only read, and
// cc-usage's files only through the import's reads. Output is content-free: account
// labels, model ids, dates and numbers. Not a CI test: it needs the real data.

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { importPricing } from "../src/commands/import-cc-usage.ts";
import { ccUsageDir, ensureConfig } from "../src/config.ts";
import { IngestEngine } from "../src/ingest/engine.ts";
import { normalizeModel } from "../src/pricing/normalize.ts";
import { mergePricing, readOverrides } from "../src/pricing/overrides.ts";
import { isDated, type ModelPricing, parseModelPricing } from "../src/pricing/schema.ts";
import { bundledPricing, PriceTable } from "../src/pricing/table.ts";
import { UsageQueries } from "../src/query/engine.ts";
import { addDays, formatDate, type LocalDate, Zone } from "../src/query/tz.ts";
import { snapshotLedger } from "../src/store/import-cc-usage.ts";
import { openStoreReader, UNATTRIBUTED } from "../src/store/store.ts";

const CC_USAGE_VERSION = "2.6.1";
/** A cell's cost may differ by float rounding (sums vs rows, Python vs TS order), never by a cent. */
const CENT = 0.005;
/** Lines written this long before cc-usage's last sync may not be in its ledger yet. */
const SYNC_WINDOW_MS = 5 * 60_000;
const CATEGORIES = ["replay", "dated-price", "tier", "estimated", "new-data"] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * What each explained category may do, from the architecture and the T5 measurements on
 * this machine. A category outside its bounds fails the gate as surely as an unexplained
 * cell: it means a fix did more (or other) than it should. Each one may also change only
 * its own cells (see `footprint`): replay Codex accounts, dated-price the dated models,
 * tier the models with fast rows, estimated the aliased models.
 */
const BOUNDS: Record<Category, { tokens: [number, number]; usd: [number, number]; why: string }> = {
  replay: {
    tokens: [-2.0e9, 0],
    usd: [-1500, 0],
    why: "removes Codex replay only: up to ~1.73B tokens / ~$1.17K (ARCHITECTURE §6.4)",
  },
  "dated-price": {
    tokens: [0, 0],
    usd: [-250, 250],
    why: "reprices GPT-5.6 Terra/Luna/Sol by date (launch prices up, Sol's promotion down); never changes tokens",
  },
  tier: {
    tokens: [0, 0],
    usd: [0, 300],
    why: "prices priority/fast rows at their tier (about +$102, T5); moves no tokens",
  },
  estimated: {
    tokens: [0, 0],
    usd: [0, 20],
    why: "prices codex-auto-review from its estimated card (about +$3-4, T5); no tokens",
  },
  "new-data": {
    tokens: [0, 2.0e8],
    usd: [0, 500],
    why: `adds only lines from the last ${SYNC_WINDOW_MS / 60_000} minutes before cc-usage's last sync`,
  },
};

// ── rows and cells ───────────────────────────────────────────────────────────────

interface Row {
  key: bigint;
  identity: string;
  provider: string;
  ts: number;
  model: string;
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  e5: number | null;
  e1: number | null;
  tier: number;
}

interface Cell {
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  cost: number;
  rows: number;
}

/** day|identity|model|tier -> cell. */
type Cells = Map<string, Cell>;

const COUNTS = ["inp", "outp", "cr", "cc", "e5", "e1"] as const;
const tokensOf = (c: { inp: number; outp: number; cr: number; cc: number }) =>
  c.inp + c.outp + c.cr + c.cc;
const tierName = (tier: number) => (tier === 0 ? "standard" : "fast");

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

function emptyCell(): Cell {
  return { inp: 0, outp: 0, cr: 0, cc: 0, cost: 0, rows: 0 };
}

/** One row's cost at `tier` from `table`; 0 when it has no price, as in cc-usage's views. */
function costOf(r: Row, table: PriceTable, tier: number): number {
  const cost = table.cost({
    model: r.model,
    tier: tierName(tier),
    atMs: r.ts,
    input: r.inp,
    output: r.outp,
    cacheRead: r.cr,
    cacheCreation: r.cc,
    ephemeral5m: r.e5,
    ephemeral1h: r.e1,
  });
  return typeof cost === "number" ? cost : 0;
}

/** Prices every row on its own with `table` (at tier 0 unless `tiers`) and sums per cell. */
function cellsOf(rows: Iterable<Row>, table: PriceTable, zone: Zone, tiers: boolean): Cells {
  const cells: Cells = new Map();
  for (const r of rows) {
    const day = formatDate(zone.dateAt(r.ts));
    const tier = tiers ? r.tier : 0;
    const key = `${day}|${r.identity}|${normalizeModel(r.model)}|${tierName(tier)}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = emptyCell();
      cells.set(key, cell);
    }
    cell.inp += r.inp;
    cell.outp += r.outp;
    cell.cr += r.cr;
    cell.cc += r.cc;
    cell.cost += costOf(r, table, tier);
    cell.rows++;
  }
  return cells;
}

interface CellDiff {
  key: string;
  before: Cell;
  after: Cell;
}

/** Cells that differ between two steps; `tolerance` is the cost difference ignored. */
function diff(before: Cells, after: Cells, tolerance: number): CellDiff[] {
  const out: CellDiff[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key) ?? emptyCell();
    const b = after.get(key) ?? emptyCell();
    const tokens = a.inp !== b.inp || a.outp !== b.outp || a.cr !== b.cr || a.cc !== b.cc;
    if (tokens || Math.abs(b.cost - a.cost) > tolerance) out.push({ key, before: a, after: b });
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : 1));
}

function total(cells: Cells): { tokens: number; usd: number; rows: number } {
  let tokens = 0;
  let usd = 0;
  let rows = 0;
  for (const c of cells.values()) {
    tokens += tokensOf(c);
    usd += c.cost;
    rows += c.rows;
  }
  return { tokens, usd, rows };
}

// ── tokenhud's answer, through T6's queries ──────────────────────────────────────

function queriedCells(
  storePath: string,
  table: PriceTable,
  zone: Zone,
  now: number,
  wanted: Iterable<[identity: string, day: string]>,
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

// ── the run ──────────────────────────────────────────────────────────────────────

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
  warnings: string[];
  pricing: Record<string, Record<string, number>>;
  cells: [string, string, string, number, number, number, number, number, number][];
}

interface Report {
  cc_usage_version: string;
  time_zone: string;
  pinned_now: string;
  cells: number;
  categories: Record<string, { cells: number; rows: number; tokens: number; usd: number }>;
  totals: {
    cc_usage: { tokens: number; usd: number; rows: number };
    tokenhud: { tokens: number; usd: number; rows: number };
  };
  after_now: { rows: number; tokens: number };
  unexplained: {
    cells: Array<{
      day: string;
      account: string;
      model: string;
      tier: string;
      tokens: number;
      usd: number;
      at: string;
    }>;
    rows: Record<string, number>;
  };
  bounds_failed: string[];
  ingest: { imported: number | null; logs: string[]; wall_ms: number };
  passed: boolean;
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
    const pricing = importPricing(join(ccDir, "pricing.json"), overridesPath);
    if (pricing.problem !== null) throw new Error(`price edits: ${pricing.problem}`);
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
    try {
      engine.recover();
      const outcome = engine.importIfFirstRun();
      imported = outcome?.status === "imported" ? outcome.inserted : null;
      const pass = await engine.fullPass();
      if (pass === null || pass.storeError !== null) throw new Error("the ingest pass failed");
    } finally {
      engine.close();
    }
    const wallMs = performance.now() - t0;

    // 3. cc-usage's own numbers, from the same ledger copy, priced by cc-usage itself.
    const pyXdg = join(tmp, "py-xdg");
    mkdirSync(join(pyXdg, "cc-usage"), { recursive: true });
    if (existsSync(join(ccDir, "pricing.json"))) {
      copyFileSync(join(ccDir, "pricing.json"), join(pyXdg, "cc-usage", "pricing.json"));
    }
    const out = join(tmp, "cc-usage.json");
    const proc = Bun.spawnSync(
      [python, join(import.meta.dir, "parity_cc_usage.py"), ledger, zone.name, out],
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
    const ours = new Map(readRows(storeDb, true).map((r) => [r.key, r]));
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
    const rekeyed = new Set<string>(
      (
        (
          JSON.parse(
            storeDb
              .query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'migration_report'")
              .get()?.v ?? "null",
          ) as { accounts?: { identity: string }[] } | null
        )?.accounts ?? []
      ).map((a) => a.identity),
    );
    storeDb.close();

    // "Now" is the ledger copy's newest row.
    const now = ledgerRows.reduce((m, r) => Math.max(m, r.ts), 0);
    const inLedger = new Set(ledgerRows.map((r) => r.key));
    const windowStart = now - SYNC_WINDOW_MS;

    // The price tables of each step.
    const bundled = bundledPricing();
    const models = mergePricing(bundled.models, readOverrides(overridesPath).models);
    const flat: Record<string, ModelPricing> = { ...models };
    for (const [id, entry] of Object.entries(models)) {
      if (!isDated(entry)) continue;
      const card = py.pricing[id];
      if (card === undefined) delete flat[id];
      else flat[id] = parseModelPricing(card, `cc-usage pricing ${id}`, { coerce: false });
    }
    const flatTable = new PriceTable(flat); // cc-usage's flat cards for the dated models, no aliases
    const datedTable = new PriceTable(models); // tokenhud's periods, no aliases
    const fullTable = new PriceTable(models, bundled.aliases); // tokenhud's table

    // Row by row, which fix makes tokenhud's row differ from cc-usage's.
    const anomalies = new Map<string, number>();
    const anomaly = (kind: string) => anomalies.set(kind, (anomalies.get(kind) ?? 0) + 1);
    const rowsOf: Record<Category, number> = {
      replay: 0,
      "dated-price": 0,
      tier: 0,
      estimated: 0,
      "new-data": 0,
    };
    const afterReplay = new Map<bigint, Row>();
    const later = new Map<bigint, Row>(); // new-data versions of rows, applied at the end
    for (const c of ledgerRows) {
      const t = ours.get(c.key);
      if (t === undefined) {
        if (tombstones.get(c.key) === "codex-replay" && c.provider === "codex") rowsOf.replay++;
        else {
          anomaly("a cc-usage row tokenhud does not have");
          afterReplay.set(c.key, c);
        }
        continue;
      }
      if (t.identity !== c.identity || t.ts !== c.ts) {
        anomaly("a row whose account or timestamp differs");
        afterReplay.set(c.key, c);
        continue;
      }
      const lower = COUNTS.some((f) => (t[f] ?? -1) < (c[f] ?? -1));
      const higher = COUNTS.some((f) => (t[f] ?? -1) > (c[f] ?? -1));
      const recent = c.ts > windowStart;
      const modelDiffers = normalizeModel(t.model) !== normalizeModel(c.model);
      if ((lower || higher) && c.provider === "codex" && rekeyed.has(c.identity)) {
        // The scheme-2 re-key replaced this row's counts (a child rollout's replayed share).
        rowsOf.replay++;
        if (modelDiffers && c.model !== UNATTRIBUTED) anomaly("a re-keyed row whose model changed");
        afterReplay.set(c.key, { ...t, tier: 0 });
        continue;
      }
      afterReplay.set(c.key, c);
      if (lower || (modelDiffers && c.model !== UNATTRIBUTED)) {
        anomaly("a row tokenhud holds lower, or under another model");
      } else if (higher || modelDiffers) {
        // Higher counts (a streamed reply's last lines) or a model resolved (a rollout's
        // turn_context) that cc-usage had not read by its last sync.
        if (recent) {
          later.set(c.key, t);
          rowsOf["new-data"]++;
        } else anomaly("a row tokenhud holds higher or resolved, from before cc-usage's last sync");
      }
    }
    const afterNow = { rows: 0, tokens: 0 };
    for (const t of ours.values()) {
      if (inLedger.has(t.key)) continue; // compared above
      if (t.ts > now) {
        afterNow.rows++;
        afterNow.tokens += tokensOf(t);
        continue;
      }
      if (t.ts > windowStart) {
        later.set(t.key, t);
        rowsOf["new-data"]++;
      } else if (t.provider === "codex" && rekeyed.has(t.identity)) {
        afterReplay.set(t.key, { ...t, tier: 0 }); // a row the re-key wrote where scheme 1 had none
        rowsOf.replay++;
      } else anomaly("a tokenhud row from before cc-usage's last sync that cc-usage lacks");
    }
    const tiered = [...afterReplay.values()].map((r) => ({
      ...r,
      tier: ours.get(r.key)?.tier ?? 0,
    }));
    rowsOf.tier = tiered.filter((r) => r.tier !== 0).length;
    rowsOf["dated-price"] = [...afterReplay.values()].filter(
      (r) => costOf(r, flatTable, 0) !== costOf(r, datedTable, 0),
    ).length;
    rowsOf.estimated = tiered.filter(
      (r) => costOf(r, datedTable, r.tier) !== costOf(r, fullTable, r.tier),
    ).length;
    const final = new Map(tiered.map((r) => [r.key, r]));
    for (const [key, t] of later) final.set(key, t);

    // The steps, cell by cell.
    const theirs: Cells = new Map(
      py.cells.map(([day, identity, model, inp, outp, cr, cc, cost, rows]) => [
        `${day}|${identity}|${model}|standard`,
        { inp, outp, cr, cc, cost, rows },
      ]),
    );
    const steps: Cells[] = [
      cellsOf(ledgerRows, flatTable, zone, false), // base: cc-usage's rows at its own flat prices
      cellsOf(afterReplay.values(), flatTable, zone, false), // replay
      cellsOf(afterReplay.values(), datedTable, zone, false), // dated-price
      cellsOf(tiered, datedTable, zone, true), // tier
      cellsOf(tiered, fullTable, zone, true), // estimated
      cellsOf(final.values(), fullTable, zone, true), // new-data
    ];
    // tokenhud's queries, for every (account, day) either side has rows on.
    const wanted = new Set<string>();
    for (const key of (steps[5] as Cells).keys()) wanted.add(key.split("|").slice(0, 2).join("|"));
    for (const t of ours.values()) {
      if (t.ts <= now) wanted.add(`${formatDate(zone.dateAt(t.ts))}|${t.identity}`);
    }
    const queried = queriedCells(
      storePath,
      fullTable,
      zone,
      now,
      [...wanted].map((w) => {
        const [day, identity] = w.split("|") as [string, string];
        return [identity, day];
      }),
    );

    // Where each fix may change anything: its footprint, by cell.
    const codexAccounts = new Set(
      [...ledgerRows, ...ours.values()]
        .filter((r) => r.provider === "codex")
        .map((r) => r.identity),
    );
    const datedModels = new Set(
      Object.entries(models)
        .filter(([, p]) => isDated(p))
        .map(([id]) => id),
    );
    const fastModels = new Set(
      tiered.filter((r) => r.tier !== 0).map((r) => normalizeModel(r.model)),
    );
    const footprint: Record<Category, (model: string, identity: string) => boolean> = {
      replay: (_model, identity) => codexAccounts.has(identity),
      "dated-price": (model) => datedModels.has(model),
      tier: (model) => fastModels.has(model),
      estimated: (model) => model in bundled.aliases,
      "new-data": () => true,
    };
    const outside: string[] = [];
    const categories: Report["categories"] = {};
    CATEGORIES.forEach((name, i) => {
      const before = steps[i] as Cells;
      const after = steps[i + 1] as Cells;
      const changed = diff(before, after, 1e-9);
      for (const d of changed) {
        const [day, identity, model, tier] = d.key.split("|") as [string, string, string, string];
        if (!footprint[name](model, identity)) {
          outside.push(`${name} changed ${day} ${labels.get(identity) ?? "?"} ${model} ${tier}`);
        }
      }
      const a = total(before);
      const b = total(after);
      categories[name] = {
        cells: changed.length,
        rows: rowsOf[name],
        tokens: b.tokens - a.tokens,
        usd: b.usd - a.usd,
      };
    });

    // Unexplained: cc-usage's numbers against the base, tokenhud's queries against the last step.
    const atBase = diff(theirs, steps[0] as Cells, CENT).map((d) => ({ ...d, at: "base" }));
    const atQueries = diff(steps[5] as Cells, queried, CENT).map((d) => ({ ...d, at: "queries" }));
    const residue = [...atBase, ...atQueries];
    const unexplainedCells = residue.map((d) => {
      const [day, identity, model, tier] = d.key.split("|") as [string, string, string, string];
      return {
        day,
        account: labels.get(identity) ?? "?",
        model: model || "(none)",
        tier,
        tokens: tokensOf(d.after) - tokensOf(d.before),
        usd: d.after.cost - d.before.cost,
        at: d.at,
      };
    });
    categories.unexplained = {
      cells: residue.length,
      rows: [...anomalies.values()].reduce((a, b) => a + b, 0),
      tokens: residue.reduce((s, d) => s + tokensOf(d.after) - tokensOf(d.before), 0),
      usd: residue.reduce((s, d) => s + d.after.cost - d.before.cost, 0),
    };

    const boundsFailed: string[] = [...outside];
    for (const name of CATEGORIES) {
      const c = categories[name] as Report["categories"][string];
      const b = BOUNDS[name];
      const inside = (v: number, [lo, hi]: [number, number], slack: number) =>
        v >= lo - slack && v <= hi + slack;
      if (!inside(c.tokens, b.tokens, 0) || !inside(c.usd, b.usd, CENT)) {
        boundsFailed.push(`${name}: ${c.tokens} tokens, $${c.usd.toFixed(2)} (${b.why})`);
      }
    }

    const ccTotal = total(theirs);
    const thTotal = total(queried);
    return {
      cc_usage_version: py.version,
      time_zone: zone.name,
      pinned_now: zone.iso(now),
      cells: new Set([...theirs.keys(), ...queried.keys()]).size,
      categories,
      totals: { cc_usage: ccTotal, tokenhud: thTotal },
      after_now: afterNow,
      unexplained: { cells: unexplainedCells, rows: Object.fromEntries(anomalies) },
      bounds_failed: boundsFailed,
      ingest: { imported, logs, wall_ms: Math.round(wallMs) },
      passed: residue.length === 0 && anomalies.size === 0 && boundsFailed.length === 0,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ── output ───────────────────────────────────────────────────────────────────────

const n = (x: number) => x.toLocaleString("en-US");
const usd = (x: number) =>
  `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function render(r: Report): string {
  const out: string[] = [];
  out.push(
    `tokenhud vs cc-usage ${r.cc_usage_version}: ${n(r.cells)} cells (local day × account × model × tier)`,
    `time zone ${r.time_zone}; now pinned to the ledger copy's newest row, ${r.pinned_now.slice(0, 16).replace("T", " ")}`,
    "",
  );
  const rows = [
    ["category", "cells", "rows", "Δ tokens", "Δ $"],
    ...[...CATEGORIES, "unexplained"].map((name) => {
      const c = r.categories[name] as Report["categories"][string];
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
    `ingest: ${r.ingest.imported === null ? "nothing" : n(r.ingest.imported)} ledger rows imported, full pass ${n(r.ingest.wall_ms)} ms`,
  );
  if (r.unexplained.cells.length > 0) {
    out.push("", "unexplained cells (first 20):");
    for (const c of r.unexplained.cells.slice(0, 20)) {
      out.push(
        `  ${c.day} ${c.account} ${c.model} ${c.tier}: ${n(c.tokens)} tokens, ${usd(c.usd)} (${c.at})`,
      );
    }
  }
  for (const [kind, count] of Object.entries(r.unexplained.rows))
    out.push(`unexplained rows: ${n(count)} × ${kind}`);
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

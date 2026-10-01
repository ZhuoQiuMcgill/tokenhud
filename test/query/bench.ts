// Query benchmark (T6 acceptance criterion 3) on 1M-row synthetic stores.
// Usage: bun run bench:query   (exits 1 if a budget is missed)
//
// Two stores, in the OS temp dir (TMPDIR; on this WSL machine /tmp is tmpfs, so set TMPDIR
// to a directory on ext4 to measure there), never under the repo:
// - "sessions": a year of session-shaped use (synthetic.ts), what a heavy user produces;
// - "uniform": a row every 30 s for the 347 days up to now, every account and model in
//   every hour. Real use never looks like this; it is the worst case for the hour cache.
//
// For each, every query a view makes is timed:
// - cold: a fresh engine, so the hours it touches are read and priced first;
// - warm: the engine's cached hours, which is what a view-model recompute costs;
// - tick: after invalidating the latest hour (an ingest wrote to it), the Overview again.
// Then `tokenhud json usage` by day over the stores' last month, end to end, process start
// included: a custom period, since `--period this_month` follows the real clock and would
// measure an empty month once the fixed data is in the past. Budgets: warm queries and the
// tick 5 ms, the json command 300 ms.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { type QueryArgs, UsageQueries } from "../../src/query/engine.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { ACCOUNTS, syntheticRows } from "./synthetic.ts";

const ROWS = 1_000_000;
const END = Date.parse("2026-09-30T18:00:00Z");
const START = END - 365 * 86_400_000;
const NOW = END + 30 * 60_000;
const TZ = "America/Toronto";
const VIEW_BUDGET_MS = 5;
const JSON_BUDGET_MS = 300;
let failed = false;

function uniformRows(): UsageRow[] {
  const models = [
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "gpt-5.6-sol",
    "codex-unattributed",
    "claude-haiku-4-5",
  ];
  return Array.from({ length: ROWS }, (_, i) => {
    const account = ACCOUNTS[i % ACCOUNTS.length] as (typeof ACCOUNTS)[number];
    return {
      key: BigInt.asIntN(64, BigInt(i + 1) * 0x9e3779b97f4a7c15n),
      ...account,
      ts: END - (ROWS - 1 - i) * 30_000,
      model: models[i % models.length] as string,
      inp: i % 997,
      outp: i % 4999,
      cr: (i * 7) % 150_000,
      cc: i % 7000,
      e5: i % 20 ? i % 5000 : null,
      e1: i % 20 ? i % 2000 : null,
      tier: i % 50 === 0 ? 1 : 0,
    };
  });
}

function build(dir: string, rows: UsageRow[]): string {
  const path = join(dir, "tokenhud.db");
  const store = openStore(path);
  for (let i = 0; i < rows.length; i += 100_000) store.upsert(rows.slice(i, i + 100_000));
  store.close();
  return path;
}

const n = (x: number) => x.toLocaleString("en-US");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

function report(label: string, ms: number, budget?: number): void {
  const over = budget !== undefined && ms > budget;
  if (over) failed = true;
  const verdict = budget === undefined ? "" : `  (budget ${budget} ms: ${over ? "MISSED" : "ok"})`;
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(3).padStart(9)} ms${verdict}`);
}

function views(q: UsageQueries, accountId: number): Array<[string, () => unknown]> {
  const all: QueryArgs = { period: "all" };
  return [
    ["spend: totals today", () => q.totals({ period: "today" })],
    ["spend: totals this_week", () => q.totals({ period: "this_week" })],
    ["spend: totals this_month", () => q.totals({ period: "this_month" })],
    ["spend: totals all", () => q.totals(all)],
    ["activity: 24 h × 72 buckets", () => q.activity({ period: "24h", buckets: 72 })],
    ["pace: 30 min per account", () => q.pace({ minutes: 30 })],
    ["top models: byModel this_week", () => q.byModel({ period: "this_week" })],
    [
      "history: 26-week heat map (byDay)",
      () => q.byDay({ range: { from: NOW - 182 * 86_400_000, to: NOW } }),
    ],
    ["history: byDay all", () => q.byDay(all)],
    ["history: byWeek all", () => q.byWeek(all)],
    ["history: byMonth all", () => q.byMonth(all)],
    ["models: byModel all", () => q.byModel(all)],
    ["accounts: byAccount all", () => q.byAccount(all)],
    [
      "accounts: 30-day sparkline (byDay, 1 account)",
      () => q.byDay({ range: { from: NOW - 30 * 86_400_000, to: NOW }, accounts: [accountId] }),
    ],
    ["accounts: byModel all, 1 account", () => q.byModel({ ...all, accounts: [accountId] })],
  ];
}

function bench(name: string, path: string): void {
  const db = openStoreReader(path);
  if (db === null) throw new Error("no store");
  const prices = new PriceTable(bundledPricing().models);
  const buckets = Number(
    db.query<{ n: bigint }, []>("SELECT count(*) AS n FROM roll_hour").get()?.n,
  );
  console.log(`\n${name}: ${n(ROWS)} rows, ${n(buckets)} hour buckets`);
  const accountId =
    new UsageQueries(db, prices, { tz: TZ, now: () => NOW }).accountList()[0]?.id ?? 1;

  console.log(" cold (fresh engine; hours read and priced on first use)");
  for (const [label] of views(
    new UsageQueries(db, prices, { tz: TZ, now: () => NOW }),
    accountId,
  )) {
    const fresh = new UsageQueries(db, prices, { tz: TZ, now: () => NOW });
    const query = views(fresh, accountId).find(([l]) => l === label)?.[1] as () => unknown;
    const t0 = performance.now();
    query();
    report(label, performance.now() - t0);
  }
  const all = new UsageQueries(db, prices, { tz: TZ, now: () => NOW });
  let t0 = performance.now();
  all.byDay({ period: "all" });
  report("load and price every hour (cold byDay all)", performance.now() - t0);

  console.log(" warm (cached hours: a view-model recompute), median of 50");
  const q = new UsageQueries(db, prices, { tz: TZ, now: () => NOW, autoInvalidate: false });
  for (const [label, query] of views(q, accountId)) {
    query();
    const times = Array.from({ length: 50 }, () => {
      const t = performance.now();
      query();
      return performance.now() - t;
    });
    report(label, median(times), VIEW_BUDGET_MS);
  }

  console.log(" refresh tick: invalidate the last hour, recompute the Overview, median of 50");
  const overview = views(q, accountId).slice(0, 7);
  const ticks = Array.from({ length: 50 }, () => {
    const t = performance.now();
    q.invalidate({ from: NOW - 3_600_000, to: NOW + 1 });
    for (const [, query] of overview) query();
    return performance.now() - t;
  });
  report("Overview (7 queries) after an ingest", median(ticks), VIEW_BUDGET_MS);
  t0 = performance.now();
  q.invalidate({ from: NOW - 3_600_000, to: NOW + 1 });
  q.totals({ period: "all" });
  report("one query after an ingest (totals all)", performance.now() - t0, VIEW_BUDGET_MS);
  db.close();
}

function jsonEndToEnd(dir: string): void {
  // The command reads <XDG_CONFIG_HOME>/tokenhud/tokenhud.db.
  const env = { ...process.env, XDG_CONFIG_HOME: dir, TZ };
  const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
  // September 2026 in TZ: the month that holds END, as `this_month` would have on END.
  const args = [
    process.execPath,
    cli,
    "json",
    "usage",
    "--since",
    "2026-09-01",
    "--until",
    "2026-09-30",
    "--group-by",
    "day",
  ];
  const times: number[] = [];
  for (let i = 0; i < 11; i++) {
    const t = performance.now();
    const proc = Bun.spawnSync(args, { env, stdout: "pipe", stderr: "pipe" });
    times.push(performance.now() - t);
    if (proc.exitCode !== 0) throw new Error(`json failed: ${proc.stderr.toString()}`);
    const records = JSON.parse(proc.stdout.toString()).totals.records;
    if (records === 0) throw new Error("the json run measured an empty month");
  }
  times.shift(); // the first run warms the OS file cache
  console.log("\n tokenhud json usage, September by day (spawned, median of 10)");
  report("end to end, process start included", median(times), JSON_BUDGET_MS);
  report("(slowest run)", Math.max(...times));
}

const root = mkdtempSync(join(tmpdir(), "tokenhud-query-bench-"));
console.log(`stores in ${root}`);
try {
  const sessionsDir = join(root, "sessions", "tokenhud");
  let t0 = performance.now();
  const sessionsPath = build(
    sessionsDir,
    syntheticRows({ rows: ROWS, from: START, to: END, seed: 3, longContext: 0.001 }),
  );
  console.log(`built the sessions store in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  t0 = performance.now();
  const uniformPath = build(join(root, "uniform", "tokenhud"), uniformRows());
  console.log(`built the uniform store in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  bench("sessions", sessionsPath);
  bench("uniform (worst case)", uniformPath);
  jsonEndToEnd(join(root, "sessions"));
  jsonEndToEnd(join(root, "uniform"));
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

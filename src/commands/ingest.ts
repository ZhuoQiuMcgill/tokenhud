import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ccUsageDir, configPath, ensureConfig } from "../config.ts";
import { startIngestWorker, type WorkerOptions } from "../ingest/client.ts";
import { cachePath } from "../ingest/cursors.ts";
import { IngestEngine } from "../ingest/engine.ts";
import type { ChangedEvent, PassReport, RootStats } from "../ingest/pass.ts";
import { ccUsageLimitsPath } from "../limits/cache.ts";
import { Limits, manualLinks } from "../limits/index.ts";
import { storePath } from "../paths.ts";
import { discoverClaudeRoots, discoverCodexRoots } from "../sources/roots.ts";
import { StoreError } from "../store/errors.ts";

// `tokenhud ingest`: a developer command, deliberately left out of --help. It runs the
// ingest engine against the real roots, writing only the store and cache it is given.
// Output is content-free: account labels and counts, never paths or transcript text.

const USAGE = `usage: tokenhud ingest [--db <path>] [--cache <path>] [--config <path>]
                       [--once] [--stats] [--no-import] [--limits <path>]

  --db <path>      usage store (default: ~/.config/tokenhud/tokenhud.db)
  --cache <path>   read-position cache (default: ~/.config/tokenhud/cache.db)
  --config <path>  tokenhud's config; created from cc-usage's on the first run
                   (default: ~/.config/tokenhud/config.json)
  --once           run one pass, print its stats and exit (else: watch, print each change)
  --stats          per-account stats (with --once), or a line per pass (watching)
  --no-import      skip the first-run import of cc-usage's history (and limits)
  --limits <path>  watching: also fetch subscription limits into this limits.json and
                   print each account's windows (utilisation and source only)`;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

function engineOptions(values: {
  db?: string;
  cache?: string;
  config?: string;
  "no-import"?: boolean;
  limits?: string;
}): WorkerOptions {
  const env = process.env;
  const home = homedir();
  const start = ensureConfig(
    values.config ?? configPath(env, home),
    join(ccUsageDir(env, home), "config.json"),
  );
  if (start.imported) {
    process.stderr.write(
      start.saveError === null
        ? "info: created tokenhud's config from cc-usage's\n"
        : `warn: cc-usage's config was imported but not saved: ${start.saveError}\n`,
    );
  }
  const options: WorkerOptions = {
    storePath: values.db ?? storePath(env, home),
    cachePath: values.cache ?? cachePath(env, home),
    config: start.config,
    discover: { home, env: { ...env } },
    importLedger: values["no-import"] ? null : join(ccUsageDir(env, home), "ledger.sqlite3"),
  };
  if (values.limits !== undefined) {
    options.limits = {
      limitsPath: values.limits,
      ccUsageLimits: values["no-import"] ? null : ccUsageLimitsPath(env, home),
      configPath: values.config ?? configPath(env, home),
    };
  }
  return options;
}

/** One account's limits as a content-free line: label, windows, source. */
function limitsLine(limits: Limits, account: string): string {
  const a = limits.getLimits(account);
  if (a === null) return `limits ? (${account.slice(0, 8)})`;
  const windows = a.windows
    .map((w) => `${w.label} ${Math.round(w.utilization * 100)}%`)
    .join(" · ");
  const state = a.account.signed_in ? "" : " · not signed in here";
  const error = a.error === null ? "" : ` · ${a.error}`;
  return `limits ${a.account.label} (${a.account.provider}): ${windows || "no windows"} [${a.source ?? "none"}]${state}${error}`;
}

const MB = 1024 * 1024;

function totals(roots: readonly RootStats[]) {
  const sum = (f: (r: RootStats) => number) => roots.reduce((a, r) => a + f(r), 0);
  return {
    files: sum((r) => r.files),
    read: sum((r) => r.read),
    bytes: sum((r) => r.bytes),
    lines: sum((r) => r.lines),
    candidates: sum((r) => r.candidates),
    records: sum((r) => r.records),
    inserted: sum((r) => r.inserted),
    changed: sum((r) => r.changed),
  };
}

function summary(report: PassReport): string {
  const t = totals(report.roots);
  return (
    `read ${t.read} of ${t.files} files (${(t.bytes / MB).toFixed(1)} MB), ` +
    `${t.records} records: ${t.inserted} new, ${t.changed} changed, in ${report.wallMs.toFixed(0)} ms`
  );
}

function table(report: PassReport): string {
  const header = [
    "account",
    "files",
    "read",
    "MB",
    "lines",
    "candidates",
    "records",
    "new",
    "changed",
    "read ms",
  ];
  const rows = report.roots.map((r) => [
    `${r.label} (${r.provider})`,
    String(r.files),
    String(r.read),
    (r.bytes / MB).toFixed(1),
    String(r.lines),
    String(r.candidates),
    String(r.records),
    String(r.inserted),
    String(r.changed),
    r.readMs.toFixed(0),
  ]);
  const t = totals(report.roots);
  rows.push([
    "total",
    String(t.files),
    String(t.read),
    (t.bytes / MB).toFixed(1),
    String(t.lines),
    String(t.candidates),
    String(t.records),
    String(t.inserted),
    String(t.changed),
    "",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] as string).length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i] as number) : c.padStart(widths[i] as number)))
      .join("  ");
  const extra = report.roots
    .filter((r) => r.malformed + r.unkeyed + r.unstorable + r.errors > 0)
    .map(
      (r) =>
        `  ${r.label}: ${r.malformed} malformed, ${r.unkeyed} without a key, ${r.unstorable} unstorable, ${r.errors} unreadable`,
    );
  const codex = report.roots
    .filter((r) => r.provider === "codex" && r.records + r.inherited + r.tombstoned > 0)
    .map(
      (r) =>
        `  ${r.label}: ${r.inherited} inherited (replayed) events skipped, ${r.removed} stored rows removed, ${r.tombstoned} rows of removed keys not written; ${r.fast} fast-tier records`,
    );
  const labelOf = (identity: string) =>
    report.roots.find((r) => r.provider === "codex" && r.identity === identity)?.label ?? "?";
  const rekey = (report.rekey?.accounts ?? []).map(
    (a) =>
      `  ${labelOf(a.identity)}: re-keyed to scheme ${report.rekey?.scheme}: ${a.rollouts} rollouts, ${a.deleted} rows deleted, ${a.changed} changed, ${a.inserted} inserted, ${a.unchanged} unchanged, ${a.untouched} kept from deleted rollouts`,
  );
  return [
    line(header),
    ...rows.map(line),
    `wall ${report.wallMs.toFixed(0)} ms`,
    ...extra,
    ...codex,
    ...rekey,
  ].join("\n");
}

function describe(event: ChangedEvent, labels: ReadonlyMap<string, string>): string {
  const names = event.accounts.map((id) => labels.get(id) ?? "?").join(", ");
  return `changed ${names} ${new Date(event.fromTs).toISOString()} .. ${new Date(event.toTs).toISOString()}`;
}

async function once(options: WorkerOptions, stats: boolean): Promise<number> {
  let engine: IngestEngine;
  try {
    engine = IngestEngine.open({
      ...options,
      log: (level, message) => process.stderr.write(`${level}: ${message}\n`),
    });
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    process.stderr.write(`tokenhud: cannot open the store: ${error.message}\n`);
    return EXIT_FAIL;
  }
  try {
    engine.recover();
    const imported = engine.importIfFirstRun();
    if (imported?.status === "imported")
      process.stdout.write(`imported ${imported.inserted} rows from cc-usage\n`);
    const report = await engine.fullPass();
    if (report === null) return EXIT_FAIL;
    process.stdout.write(`${stats ? table(report) : summary(report)}\n`);
    return report.storeError === null ? EXIT_OK : EXIT_FAIL;
  } finally {
    engine.close();
  }
}

async function watchMode(options: WorkerOptions, stats: boolean): Promise<number> {
  const labels = new Map<string, string>();
  const limits =
    options.limits === undefined
      ? null
      : new Limits({
          limitsPath: options.limits.limitsPath,
          roots: () => {
            const claude = discoverClaudeRoots(options.config, options.discover);
            return [...claude, ...discoverCodexRoots(options.config, options.discover, claude)];
          },
          db: null,
          spend: null,
          links: () => manualLinks(options.config),
        });
  const worker = startIngestWorker(options, (message) => {
    switch (message.type) {
      case "limits":
        for (const id of message.accounts) {
          if (limits !== null) process.stdout.write(`${limitsLine(limits, id)}\n`);
        }
        break;
      case "changed":
        process.stdout.write(`${describe(message, labels)}\n`);
        break;
      case "ready":
        process.stdout.write(`watching ${message.roots.join(", ")}\n`);
        break;
      case "pass":
        for (const r of message.report.roots) labels.set(r.identity, r.label);
        if (stats && message.report.roots.some((r) => r.read > 0)) {
          process.stdout.write(`${summary(message.report)}\n`);
        }
        break;
      case "imported":
        process.stdout.write(`imported ${message.rows} rows from cc-usage\n`);
        break;
      case "log":
        process.stderr.write(`${message.level}: ${message.message}\n`);
        break;
    }
  });
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
  await worker.stop();
  return EXIT_OK;
}

export async function runIngest(args: readonly string[]): Promise<number> {
  let values: {
    db?: string;
    cache?: string;
    config?: string;
    once?: boolean;
    stats?: boolean;
    "no-import"?: boolean;
    limits?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        db: { type: "string" },
        cache: { type: "string" },
        config: { type: "string" },
        once: { type: "boolean" },
        stats: { type: "boolean" },
        "no-import": { type: "boolean" },
        limits: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`tokenhud ingest: ${(error as Error).message}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  const options = engineOptions(values);
  return values.once
    ? once(options, values.stats ?? false)
    : watchMode(options, values.stats ?? false);
}

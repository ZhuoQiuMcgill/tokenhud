// `tokenhud doctor [--json]`: what the store holds, whether it is backed up and recovered,
// how much of it is priced, what is still only in cc-usage, and which transcript roots
// tokenhud follows. Read-only throughout: the store through a read-only connection, the
// cursor cache likewise, cc-usage's ledger through a private snapshot copy. It prints
// config paths (the store, its backup, the overrides file, the cache, cc-usage's
// directory), never a transcript, prompt or credential path; roots go by their labels.

import type { Database } from "bun:sqlite";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Config, configPath, loadConfig } from "../config.ts";
import { cachePath, readCacheSummary } from "../ingest/cursors.ts";
import { transcriptDirs } from "../ingest/engine.ts";
import { detectInstall } from "../mcp/install.ts";
import { ccUsageDir, pricingOverridesPath, storePath } from "../paths.ts";
import { loadPriceTable, readOverrides } from "../pricing/overrides.ts";
import type { Tier } from "../pricing/schema.ts";
import { bundledPricing } from "../pricing/table.ts";
import { UsageQueries } from "../query/engine.ts";
import { JSON_SCHEMA, type Totals } from "../query/types.ts";
import { Zone } from "../query/tz.ts";
import {
  discoverClaudeRoots,
  discoverCodexRoots,
  isWsl,
  onWindowsDrive,
  type RootSource,
} from "../sources/roots.ts";
import { backupPaths } from "../store/durability.ts";
import { StoreCorrupt, StoreError } from "../store/errors.ts";
import { ImportSourceError, readCcUsageKeys } from "../store/import-cc-usage.ts";
import { rollupCountsAgree, rollupSchemaIntact } from "../store/schema.ts";
import { emptyStoreDatabase, type ImportRecord, openStoreReader } from "../store/store.ts";
import { shortPath } from "./import-cc-usage.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const DOCTOR_HELP = `Usage:
  tokenhud doctor [--json]

Reports on the store (rows, accounts, imports, rollup health, backup age, recovery),
pricing (overrides, unpriced models, priced coverage), cc-usage (rows not imported yet),
the transcript roots tokenhud follows and, per Claude account, whether the tokenhud plugin
or MCP server is installed. Read-only.`;

export interface DoctorAccount {
  id: number;
  label: string;
  provider: string;
  rows: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface DoctorReport {
  schema: typeof JSON_SCHEMA;
  generated_at: string;
  store: {
    path: string;
    exists: boolean;
    /** Why the store could not be read, if it couldn't. */
    error: string | null;
    /** The store is damaged: the next ingest moves it aside and recovers it. */
    damaged: boolean;
    /** The database plus its WAL. */
    size_bytes: number | null;
    schema_version: number | null;
    key_scheme: number | null;
    created_at: string | null;
    rows: number;
    rows_by_provider: Record<string, number>;
    accounts: DoctorAccount[];
    /** Distinct models with usage. */
    models: number;
    first_seen: string | null;
    last_seen: string | null;
    imports: ImportRecord[];
    /** meta.migration_report, written by key-scheme migrations (T5); null if none ran. */
    migration_report: unknown;
    /** The quick check: triggers as defined and row counts agree. Null without a store. */
    rollups: { triggers_intact: boolean; counts_agree: boolean } | null;
    long_context_index: boolean;
    /** The daily backup (`<store>.bak`) and the one before it; times in the report's zone. */
    backup: {
      path: string;
      at: string | null;
      age_hours: number | null;
      previous_at: string | null;
    };
    /** Recovery (src/store/durability.ts): files still to merge, lineages merged, the last report. */
    recovery: {
      pending: Array<{ file: string; why: string }>;
      merged_lineages: number;
      last_report: { at: string; summary: string; still_pending: string[] } | null;
    };
  };
  pricing: {
    /** The bundled table's sources and the date each was last checked. */
    bundled: Record<string, { url: string; checked: string }>;
    overrides: { path: string; exists: boolean; models: number; warnings: string[] };
    priced_pct: number;
    priced_tokens: number;
    unpriced_tokens: number;
    unpriced_tier_tokens: number;
    estimated_tokens: number;
    estimated_cost_usd: number;
    unpriced: Array<{ model: string; tier: Tier; tokens: number }>;
    unpriced_tier: Array<{ model: string; tier: Tier; tokens: number }>;
  };
  cc_usage: {
    dir: string;
    ledger: boolean;
    last_import: ImportRecord | null;
    /** Ledger rows the store doesn't have; null when it couldn't be counted (see note). */
    rows_only_in_cc_usage: number | null;
    note: string | null;
  };
  /**
   * Whether Claude Code can start `tokenhud mcp`, and per enabled Claude account (by label;
   * paths stay out of the report) the tokenhud plugin ("enabled", "installed" but switched
   * off, or null) and a user-scope MCP server running `tokenhud mcp`, read from that config
   * dir's settings files.
   */
  /**
   * Every discovered transcript root (each is one account) and how tokenhud follows it:
   * watched (fs.watch), polled (a Windows drive seen from WSL) or off (disabled); how many
   * of its transcripts the cursor cache tracks, and when an ingest pass last covered it.
   */
  sources: {
    cache: { path: string; exists: boolean };
    roots: Array<{
      label: string;
      provider: string;
      found_by: RootSource;
      enabled: boolean;
      history_only: boolean;
      mode: "watched" | "polled" | "off";
      transcripts: number | null;
      last_ingest: string | null;
    }>;
  };
  claude_code: {
    /** `tokenhud` resolves on PATH: the plugin and `claude mcp add` start it from there. */
    tokenhud_on_path: boolean;
    /** Native Windows found an npm `.cmd` shim, which Claude Code can't start directly. */
    npm_shim: boolean;
    accounts: Array<{ label: string; plugin: "enabled" | "installed" | null; mcp: boolean }>;
  };
}

const IN_BATCH = 500;
// doctor's private copies of cc-usage's ledger, in the OS temp dir. A copy is removed when
// doctor finishes; one left by a killed doctor is swept by a later run once this old.
const SCRATCH_PREFIX = "tokenhud-doctor-";
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;

/** Removes stale ledger copies: only real directories named like ours. Best effort. */
function sweepScratch(dir: string, now: number): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Dirent types come from lstat, so a symlink is never followed.
    if (!entry.name.startsWith(SCRATCH_PREFIX) || !entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    try {
      if (lstatSync(path).mtimeMs < now - SCRATCH_MAX_AGE_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // in use or already gone
    }
  }
}

function storeFacts(
  db: Database,
  path: string,
  zone: Zone,
): Omit<
  DoctorReport["store"],
  "accounts" | "first_seen" | "last_seen" | "error" | "damaged" | "backup"
> {
  const count = (sql: string) => Number(db.query<{ n: bigint }, []>(sql).get()?.n ?? 0n);
  const meta = new Map(
    db
      .query<{ k: string; v: string | null }, []>("SELECT k, v FROM meta")
      .all()
      .map((m) => [m.k, m.v]),
  );
  const rowsByProvider: Record<string, number> = {};
  for (const r of db
    .query<{ provider: string; n: bigint }, []>(
      `SELECT a.provider AS provider, count(*) AS n FROM usage u JOIN accounts a ON a.id = u.acct
       GROUP BY a.provider ORDER BY a.provider`,
    )
    .all()) {
    rowsByProvider[r.provider] = Number(r.n);
  }
  const scheme = meta.get("key_scheme");
  return {
    path,
    exists: true,
    size_bytes: fileSize(path) + fileSize(`${path}-wal`),
    schema_version: count("SELECT user_version AS n FROM pragma_user_version"),
    key_scheme:
      scheme !== undefined && scheme !== null && /^\d+$/.test(scheme) ? Number(scheme) : null,
    created_at: meta.get("created_at") ?? null,
    rows: count("SELECT count(*) AS n FROM usage"),
    rows_by_provider: rowsByProvider,
    models: count("SELECT count(DISTINCT model) AS n FROM usage"),
    imports: parseJsonList(meta.get("imports")) as ImportRecord[],
    migration_report: parseJsonValue(meta.get("migration_report")),
    rollups: { triggers_intact: rollupSchemaIntact(db), counts_agree: rollupCountsAgree(db) },
    long_context_index:
      count(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'usage_long'",
      ) > 0,
    recovery: {
      pending: parseJsonList(meta.get("pending")).flatMap((e) =>
        isRecord(e) && typeof e.file === "string"
          ? [{ file: e.file, why: typeof e.why === "string" ? e.why : "held" }]
          : [],
      ),
      merged_lineages: parseJsonList(meta.get("merged")).length,
      last_report: lastRecovery(parseJsonValue(meta.get("recovery_report")), zone),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parts of a stored `RecoveryReport` the doctor shows, or null. */
function lastRecovery(raw: unknown, zone: Zone): DoctorReport["store"]["recovery"]["last_report"] {
  if (!isRecord(raw) || typeof raw.at !== "number" || typeof raw.summary !== "string") return null;
  const pending = Array.isArray(raw.stillPending) ? raw.stillPending.map(String) : [];
  return { at: zone.iso(raw.at), summary: raw.summary, still_pending: pending };
}

/** The backup slots beside the store, by their modification times. */
function backupFacts(path: string, now: number, zone: Zone): DoctorReport["store"]["backup"] {
  const { bak, prev } = backupPaths(path);
  const mtime = (file: string) => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  const at = mtime(bak);
  const previous = mtime(prev);
  return {
    path: bak,
    at: at === null ? null : zone.iso(at),
    age_hours: at === null ? null : Math.round((now - at) / 360_000) / 10,
    previous_at: previous === null ? null : zone.iso(previous),
  };
}

/** Every discovered root, with what the cursor cache knows of it. Reads the cache read-only. */
function sourcesSection(
  env: Env,
  home: string,
  config: Config,
  zone: Zone,
): DoctorReport["sources"] {
  const discover = { home, env };
  const claude = discoverClaudeRoots(config, discover);
  const roots = [...claude, ...discoverCodexRoots(config, discover, claude)];
  const cache = cachePath(env, home);
  const summary = readCacheSummary(
    cache,
    roots.map((r) => ({ identity: r.identity, dirs: transcriptDirs(r) })),
  );
  const wsl = isWsl();
  return {
    cache: { path: cache, exists: existsSync(cache) },
    roots: roots.map((r) => {
      const last = summary?.lastPass.get(r.identity);
      return {
        label: r.label,
        provider: r.provider,
        found_by: r.source,
        enabled: r.enabled,
        history_only: r.historyOnly,
        mode: !r.enabled ? "off" : wsl && onWindowsDrive(r) ? "polled" : "watched",
        transcripts: summary?.cursors.get(r.identity) ?? null,
        last_ingest: last === undefined ? null : zone.iso(last),
      };
    }),
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function parseJsonValue(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseJsonList(raw: string | null | undefined): unknown[] {
  const value = parseJsonValue(raw);
  return Array.isArray(value) ? value : [];
}

/** How many of `keys` the store lacks. */
function missingFrom(db: Database | null, keys: readonly bigint[]): number {
  if (db === null) return keys.length;
  let found = 0;
  for (let start = 0; start < keys.length; start += IN_BATCH) {
    const batch = keys.slice(start, start + IN_BATCH);
    // Every full batch shares one cached statement; the last may add a second.
    const row = db
      .query<{ n: bigint }, bigint[]>(
        `SELECT count(*) AS n FROM usage WHERE key IN (${batch.map(() => "?").join(", ")})`,
      )
      .get(...batch);
    found += Number(row?.n ?? 0n);
  }
  return keys.length - found;
}

function ccUsageSection(
  env: Env,
  db: Database | null,
  imports: readonly ImportRecord[],
): DoctorReport["cc_usage"] {
  const dir = ccUsageDir(env);
  const ledgerPath = join(dir, "ledger.sqlite3");
  const ledger = existsSync(ledgerPath);
  const fromCcUsage = imports.filter((i) => i?.source === "cc-usage");
  const section: DoctorReport["cc_usage"] = {
    dir,
    ledger,
    last_import: fromCcUsage[fromCcUsage.length - 1] ?? null,
    rows_only_in_cc_usage: null,
    note: null,
  };
  if (!ledger) {
    section.note = "no cc-usage ledger";
    return section;
  }
  try {
    sweepScratch(tmpdir(), Date.now());
    const keys = readCcUsageKeys(ledgerPath, mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)));
    if (keys === null) section.note = "cc-usage was writing its ledger; run doctor again";
    else section.rows_only_in_cc_usage = missingFrom(db, keys);
  } catch (error) {
    if (!(error instanceof ImportSourceError) && !(error instanceof StoreError)) throw error;
    section.note = error.message;
  }
  return section;
}

interface Gathered {
  totals: Totals;
  facts: ReturnType<typeof storeFacts> | null;
  accounts: DoctorAccount[];
  extent: { first: number | null; last: number | null };
}

/** What the store says, all from the caller's one snapshot; `db` is null without a store. */
function gather(q: UsageQueries, db: Database | null, path: string, zone: Zone): Gathered {
  const totals = q.totals({ period: "all" });
  if (db === null)
    return { totals, facts: null, accounts: [], extent: { first: null, last: null } };
  const rows = new Map(
    db
      .query<{ acct: bigint; n: bigint }, []>("SELECT acct, count(*) AS n FROM usage GROUP BY acct")
      .all()
      .map((r) => [Number(r.acct), Number(r.n)]),
  );
  const accounts = q.accounts().map((a) => ({
    id: a.id,
    label: a.label,
    provider: a.provider,
    rows: rows.get(a.id) ?? 0,
    first_seen: a.firstSeen === null ? null : zone.iso(a.firstSeen),
    last_seen: a.lastSeen === null ? null : zone.iso(a.lastSeen),
  }));
  const empty = totals.range.to <= totals.range.from;
  return {
    totals,
    facts: storeFacts(db, path, zone),
    accounts,
    extent: empty
      ? { first: null, last: null }
      : { first: totals.range.from, last: totals.range.to - 1 },
  };
}

/** Each enabled Claude account's tokenhud install. Reads settings files only. */
function claudeCodeSection(env: Env, home: string, config: Config): DoctorReport["claude_code"] {
  const roots = discoverClaudeRoots(config, { home, env });
  const path = env.PATH ?? env.Path;
  const found = Bun.which("tokenhud", path === undefined ? {} : { PATH: path });
  return {
    tokenhud_on_path: found !== null,
    npm_shim: process.platform === "win32" && found !== null && !/\.exe$/i.test(found),
    accounts: roots
      .filter((root) => root.enabled)
      .map((root) => ({ label: root.label, ...detectInstall(root) })),
  };
}

/** Gathers the report. Never throws for a missing or unreadable store: that is reported. */
export function doctorReport(
  env: Env = process.env,
  now: number = Date.now(),
  home: string = homedir(),
): DoctorReport {
  const path = storePath(env, home);
  const config = loadConfig(configPath(env, home));
  const zone = Zone.configured(config.time_zone);
  const overridesPath = pricingOverridesPath(env, home);
  const { table, warnings } = loadPriceTable(overridesPath);
  let db: Database | null = null;
  let error: string | null = null;
  let damaged = false;
  try {
    db = openStoreReader(path);
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
    error = e.message;
    damaged = e instanceof StoreCorrupt;
  }
  try {
    const queryDb = db ?? emptyStoreDatabase();
    let gathered: Gathered;
    try {
      const q = new UsageQueries(queryDb, table, { tz: zone.name, now: () => now });
      // One snapshot, so the counts agree with each other while the TUI writes.
      gathered = q.snapshot(() => gather(q, db, path, zone));
    } finally {
      if (db === null) queryDb.close();
    }
    const { totals, facts, accounts, extent } = gathered;
    const imports = facts?.imports ?? [];
    const overrides = readOverrides(overridesPath);
    const c = totals.usage.coverage;
    const pick = (reason: "unpriced" | "unpriced-tier") =>
      totals.unpriced
        .filter((u) => u.reason === reason)
        .map((u) => ({ model: u.model, tier: u.tier, tokens: u.tokens }));
    return {
      schema: JSON_SCHEMA,
      generated_at: new Date(now).toISOString(),
      store: {
        path,
        exists: facts !== null || error !== null,
        error,
        damaged,
        size_bytes: facts?.size_bytes ?? null,
        schema_version: facts?.schema_version ?? null,
        key_scheme: facts?.key_scheme ?? null,
        created_at: facts?.created_at ?? null,
        rows: facts?.rows ?? 0,
        rows_by_provider: facts?.rows_by_provider ?? {},
        accounts,
        models: facts?.models ?? 0,
        first_seen: extent.first === null ? null : zone.iso(extent.first),
        last_seen: extent.last === null ? null : zone.iso(extent.last),
        imports,
        migration_report: facts?.migration_report ?? null,
        rollups: facts?.rollups ?? null,
        long_context_index: facts?.long_context_index ?? false,
        backup: backupFacts(path, now, zone),
        recovery: facts?.recovery ?? { pending: [], merged_lineages: 0, last_report: null },
      },
      pricing: {
        bundled: { ...bundledPricing().sources },
        overrides: {
          path: overridesPath,
          exists: existsSync(overridesPath),
          models: Object.keys(overrides.models).length,
          warnings: [...warnings],
        },
        priced_pct: Math.round(c.pricedShare * 10_000) / 100,
        priced_tokens: c.pricedTokens,
        unpriced_tokens: c.unpricedTokens,
        unpriced_tier_tokens: c.unpricedTierTokens,
        estimated_tokens: c.estimatedTokens,
        estimated_cost_usd: totals.usage.estimatedCost,
        unpriced: pick("unpriced"),
        unpriced_tier: pick("unpriced-tier"),
      },
      cc_usage: ccUsageSection(env, db, imports),
      sources: sourcesSection(env, home, config, zone),
      claude_code: claudeCodeSection(env, home, config),
    };
  } finally {
    db?.close();
  }
}

// ── the human report ─────────────────────────────────────────────────────────────

const n = (x: number) => x.toLocaleString("en-US");

function tokens(x: number): string {
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
  return String(x);
}

function bytes(x: number): string {
  if (x >= 1024 ** 3) return `${(x / 1024 ** 3).toFixed(1)} GB`;
  if (x >= 1024 ** 2) return `${(x / 1024 ** 2).toFixed(1)} MB`;
  if (x >= 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${x} B`;
}

const day = (iso: string | null) => (iso === null ? "?" : iso.slice(0, 10));
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export function renderDoctor(r: DoctorReport): string {
  const out: string[] = [];
  const line = (label: string, value: string) => out.push(`  ${label.padEnd(13)} ${value}`);
  const more = (value: string) => out.push(`  ${"".padEnd(13)} ${value}`);
  const s = r.store;

  out.push("Store");
  line("path", shortPath(s.path));
  if (s.error !== null) {
    line("status", `unreadable: ${s.error}`);
    if (s.damaged) {
      more("the next tokenhud start moves it aside (never deletes it) and recovers it");
      more("from the backups and the transcripts");
    }
    renderBackup(s.backup, line, more);
  } else if (!s.exists) {
    line("status", "no store yet: run tokenhud, or tokenhud import-cc-usage");
  } else {
    line("size", `${bytes(s.size_bytes ?? 0)} (with its WAL)`);
    line("schema", `v${s.schema_version ?? "?"} · key scheme ${s.key_scheme ?? "unknown"}`);
    const providers = Object.entries(s.rows_by_provider).map(([p, x]) => `${p} ${n(x)}`);
    line("rows", `${n(s.rows)}${providers.length > 0 ? `  (${providers.join(" · ")})` : ""}`);
    if (s.accounts.length === 0) line("accounts", "none");
    s.accounts.forEach((a, i) => {
      const seen = a.rows > 0 ? `, ${day(a.first_seen)} → ${day(a.last_seen)}` : "";
      (i === 0 ? (v: string) => line("accounts", v) : more)(
        `${a.label} (${a.provider}) ${n(a.rows)} rows${seen}`,
      );
    });
    line("models", `${n(s.models)} with usage`);
    if (s.first_seen !== null)
      line("covers", `${day(s.first_seen)} → ${day(s.last_seen)} (local dates)`);
    // Every import appends a record; the latest few say what matters.
    const recent = s.imports.slice(-3);
    if (recent.length === 0) line("imports", "none");
    recent.forEach((i, k) => {
      (k === 0 ? (v: string) => line("imports", v) : more)(
        `${i.source} at ${when(i.at)}: ${n(i.rows)} rows, ${n(i.accounts)} accounts`,
      );
    });
    if (s.imports.length > recent.length) {
      more(`(and ${n(s.imports.length - recent.length)} earlier)`);
    }
    line(
      "migrations",
      s.migration_report === null ? "none recorded" : JSON.stringify(s.migration_report),
    );
    const roll = s.rollups;
    if (roll === null || (roll.triggers_intact && roll.counts_agree)) {
      line("rollups", "consistent (quick check)");
    } else {
      const triggers = roll.triggers_intact ? "intact" : "missing or altered";
      const counts = roll.counts_agree ? "agree" : "differ";
      line("rollups", `NOT consistent (triggers ${triggers}, row counts ${counts})`);
      more("the next tokenhud start rebuilds them");
    }
    line(
      "long context",
      s.long_context_index ? "indexed" : "not indexed yet (the next tokenhud start adds it)",
    );
    renderBackup(s.backup, line, more);
    const rec = s.recovery;
    if (rec.pending.length === 0) line("recovery", "none pending");
    rec.pending.forEach((p, i) => {
      (i === 0 ? (v: string) => line("recovery", v) : more)(
        `recovering ${p.file} (${p.why}): not merged yet`,
      );
    });
    if (rec.pending.length > 0) {
      more("a store recovery is not finished: tokenhud retries it on every full ingest");
      more("pass, and takes no backup until it is done");
    }
    if (rec.last_report !== null) {
      line("last recovery", `${when(rec.last_report.at)}: ${rec.last_report.summary}`);
    }
  }

  const p = r.pricing;
  out.push("", "Pricing");
  line(
    "bundled",
    Object.entries(p.bundled)
      .map(([k, v]) => `${k} checked ${v.checked}`)
      .join(" · "),
  );
  const o = p.overrides;
  const count = o.exists ? `${n(o.models)} models` : "none";
  line(
    "overrides",
    `${shortPath(o.path)}: ${count}${o.warnings.length > 0 ? "" : ", no warnings"}`,
  );
  for (const w of o.warnings) more(`warning: ${w}`);
  const total = p.priced_tokens + p.unpriced_tokens + p.unpriced_tier_tokens;
  line(
    "coverage",
    total === 0 ? "no usage yet" : `${p.priced_pct}% of ${tokens(total)} tokens priced`,
  );
  const list = (items: DoctorReport["pricing"]["unpriced"]) =>
    items
      .map(
        (u) => `${u.model || "(no model)"}${u.tier === "fast" ? " fast" : ""} ${tokens(u.tokens)}`,
      )
      .join(" · ");
  line("unpriced", p.unpriced.length === 0 ? "none" : list(p.unpriced));
  line("unpriced tier", p.unpriced_tier.length === 0 ? "none" : list(p.unpriced_tier));
  line(
    "estimated",
    p.estimated_tokens === 0
      ? "none"
      : `${tokens(p.estimated_tokens)} tokens, $${p.estimated_cost_usd.toFixed(2)}`,
  );

  const c = r.cc_usage;
  out.push("", "cc-usage");
  line("dir", shortPath(c.dir));
  line("ledger", c.ledger ? "found" : "none");
  line("imported", c.last_import === null ? "never" : `last at ${when(c.last_import.at)}`);
  if (c.ledger) {
    line(
      "only there",
      c.rows_only_in_cc_usage === null
        ? `unknown: ${c.note ?? "?"}`
        : c.rows_only_in_cc_usage === 0
          ? "0 rows: everything in cc-usage's ledger is in tokenhud"
          : `${n(c.rows_only_in_cc_usage)} rows: run tokenhud import-cc-usage`,
    );
  }

  const src = r.sources;
  out.push("", "Sources (transcript roots, one account each)");
  if (src.roots.length === 0) line("roots", "none found");
  for (const root of src.roots) {
    const parts = [root.provider];
    if (root.history_only) parts.push("history only");
    if (root.mode === "off") parts.push("disabled");
    else {
      parts.push(root.mode === "polled" ? "polled (Windows side)" : "watched");
      parts.push(root.transcripts === null ? "not read yet" : `${n(root.transcripts)} transcripts`);
      parts.push(
        root.last_ingest === null ? "never ingested" : `last ingest ${when(root.last_ingest)}`,
      );
    }
    line(root.label, parts.join(" · "));
  }
  line("cache", `${shortPath(src.cache.path)}${src.cache.exists ? "" : " (none yet)"}`);

  out.push("", "Claude Code (tokenhud plugin or MCP server, per account)");
  const cc = r.claude_code;
  if (!cc.tokenhud_on_path) {
    line("tokenhud", "not on PATH: the plugin and the MCP server run `tokenhud mcp`");
    more("from PATH, so install tokenhud first");
  } else if (cc.npm_shim) {
    line("tokenhud", "on PATH as an npm shim, which Claude Code can't start on Windows:");
    more("add the server with `claude mcp add -s user tokenhud -- cmd /c tokenhud mcp`");
  } else {
    line("tokenhud", "on PATH");
  }
  const missing = r.claude_code.accounts.filter((a) => a.plugin !== "enabled" && !a.mcp);
  for (const a of r.claude_code.accounts) {
    const parts: string[] = [];
    if (a.plugin === "enabled") parts.push("plugin");
    if (a.plugin === "installed") parts.push("plugin installed but disabled");
    if (a.mcp) parts.push("MCP server");
    line(a.label, parts.length === 0 ? "not installed" : parts.join(" + "));
  }
  if (missing.length > 0) {
    more("install once per account (each CLAUDE_CONFIG_DIR); see the README,");
    more('"Use with Claude Code"');
  }
  return out.join("\n");
}

function renderBackup(
  b: DoctorReport["store"]["backup"],
  line: (label: string, value: string) => void,
  more: (value: string) => void,
): void {
  if (b.at === null) {
    line("backup", "none yet (tokenhud takes one daily while it runs)");
    return;
  }
  const age =
    (b.age_hours ?? 0) >= 48 ? `${Math.round((b.age_hours ?? 0) / 24)} days` : `${b.age_hours} h`;
  line("backup", `${when(b.at)}, ${age} ago (${shortPath(b.path)})`);
  if (b.previous_at !== null) more(`previous ${when(b.previous_at)}`);
}

export function runDoctor(args: readonly string[], env: Env = process.env): number {
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      process.stdout.write(`${DOCTOR_HELP}\n`);
      return 0;
    }
    if (positionals.length > 0) throw new Error(`unexpected argument '${positionals[0]}'`);
    json = values.json === true;
  } catch (error) {
    process.stderr.write(`tokenhud doctor: ${(error as Error).message}\n`);
    return 2;
  }
  const report = doctorReport(env);
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderDoctor(report)}\n`);
  return report.store.error === null ? 0 : 1;
}

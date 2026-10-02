// `tokenhud json usage|models|accounts`: the query layer's answers as stable JSON for
// scripts and agents. It reads the store as it is through a read-only connection, so it
// never waits on or disturbs the TUI's writes. With --refresh it first runs one
// incremental ingest pass, under the single-writer ingest lock when this build has one.
//
// Exit 0 with the document on stdout; 2 for bad arguments and 1 for a store problem, each
// with a JSON error object on stderr.

import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { configPath, loadConfig } from "../config.ts";
import { cachePath } from "../ingest/cursors.ts";
import { IngestEngine } from "../ingest/engine.ts";
import { type AcquireWriterLock, LOCK_HEARTBEAT_MS } from "../mcp/freshness.ts";
import { pricingOverridesPath, storePath } from "../paths.ts";
import { loadPriceTable } from "../pricing/overrides.ts";
import { UsageQueries } from "../query/engine.ts";
import {
  accountsDocument,
  type DocumentContext,
  type DocumentRequest,
  modelsDocument,
  usageDocument,
} from "../query/json.ts";
import { isPeriodName, type Period } from "../query/periods.ts";
import {
  type AccountRef,
  type GroupBy,
  JSON_SCHEMA,
  type JsonError,
  type JsonErrorCode,
} from "../query/types.ts";
import { addDays, isTimeZone, utc, Zone } from "../query/tz.ts";
import { StoreError } from "../store/errors.ts";
import { emptyStoreDatabase, openStoreReader } from "../store/store.ts";

type Env = Readonly<Record<string, string | undefined>>;

const QUERIES = ["usage", "models", "accounts"] as const;
const GROUPS: readonly GroupBy[] = ["model", "account", "day", "week", "month"];
const PROVIDERS = ["claude", "codex"];

export const JSON_HELP = `Usage:
  tokenhud json usage    [--period P] [--group-by G] [--account A]... [--provider X]... [--tz ZONE] [--refresh]
  tokenhud json models   [--period P] [--account A]... [--provider X]... [--tz ZONE] [--refresh]
  tokenhud json accounts [--period P] [--tz ZONE] [--refresh]

Options:
  --period P       today, this_week, this_month, all (default), 1h, 5h, 24h, or custom
  --since DATE     start of a custom period: YYYY-MM-DD (local) or an ISO-8601 instant
  --until DATE     end of a custom period (default now); a YYYY-MM-DD date is included
  --group-by G     model, account, day, week or month (usage only)
  --account A      an account label or id; repeat for several
  --provider X     claude or codex; repeat for both
  --tz ZONE        IANA time zone for calendar periods (default: the config's time_zone,
                   else the system's)
  --refresh        first read what the transcripts added since the last ingest (one pass,
                   skipped while another tokenhud process keeps the store current)

Prints one JSON document (schema ${JSON_SCHEMA}) from the store. Without --refresh nothing is
ingested. Exit codes: 0 ok, 1 store error, 2 bad arguments (errors are JSON on stderr).`;

export class BadArgument extends Error {}

function fail(code: JsonErrorCode, message: string): number {
  const error: JsonError = { schema: JSON_SCHEMA, error: { code, message } };
  process.stderr.write(`${JSON.stringify(error)}\n`);
  return code === "bad_argument" ? 2 : 1;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A --since or --until value as epoch ms. A local date means its midnight in `zone`, or,
 * for --until, the next midnight, so the named day is included. An instant must carry its
 * offset: a bare local time would be ambiguous across DST. Nothing before 1970: the store
 * holds no usage then, and a range from year 1 would print tens of thousands of groups.
 */
export function parseBound(option: string, text: string, zone: Zone, until: boolean): number {
  let at: number | undefined;
  const date = DATE.exec(text);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const check = new Date(utc(year, month - 1, day));
    if (check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
      const local = { year, month, day };
      at = zone.startOf(until ? addDays(local, 1) : local);
    }
  } else if (INSTANT.test(text)) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) at = parsed;
  }
  if (at === undefined) {
    throw new BadArgument(
      `${option} must be a date (YYYY-MM-DD) or an ISO-8601 instant with an offset, got '${text}'`,
    );
  }
  if (at < 0) throw new BadArgument(`${option} must be in 1970 or later, got '${text}'`);
  return at;
}

function resolveAccounts(wanted: readonly string[], known: readonly AccountRef[]): number[] {
  return wanted.flatMap((name) => {
    const byId = /^\d+$/.test(name) ? known.filter((a) => a.id === Number(name)) : [];
    const matches =
      byId.length > 0 ? byId : known.filter((a) => a.label.toLowerCase() === name.toLowerCase());
    if (matches.length === 0) {
      const labels = known.map((a) => a.label).join(", ") || "none yet";
      throw new BadArgument(`unknown account '${name}' (accounts: ${labels})`);
    }
    return matches.map((a) => a.id);
  });
}

interface Parsed {
  query: (typeof QUERIES)[number];
  period: Period | "custom";
  since: string | undefined;
  until: string | undefined;
  groupBy: GroupBy | null;
  accounts: string[];
  providers: string[];
  tz: string | undefined;
  refresh: boolean;
}

function parse(args: readonly string[]): Parsed | "help" {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      period: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      "group-by": { type: "string" },
      account: { type: "string", multiple: true },
      provider: { type: "string", multiple: true },
      tz: { type: "string" },
      refresh: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  const [query, ...extra] = positionals;
  if (query === undefined) throw new BadArgument(`name a query: ${QUERIES.join(", ")}`);
  if (!(QUERIES as readonly string[]).includes(query)) {
    throw new BadArgument(`unknown query '${query}' (queries: ${QUERIES.join(", ")})`);
  }
  if (extra.length > 0) throw new BadArgument(`unexpected argument '${extra[0]}'`);

  const custom = values.since !== undefined || values.until !== undefined;
  const periodText = values.period ?? (custom ? "custom" : "all");
  if (periodText !== "custom" && !isPeriodName(periodText)) {
    throw new BadArgument(
      `unknown period '${periodText}' (today, this_week, this_month, all, 1h, 5h, 24h, custom)`,
    );
  }
  if (periodText === "custom" && values.since === undefined) {
    throw new BadArgument("a custom period needs --since");
  }
  if (periodText !== "custom" && custom) {
    throw new BadArgument("--since and --until need --period custom (or no --period)");
  }

  const groupText = values["group-by"];
  if (groupText !== undefined && query !== "usage") {
    throw new BadArgument("--group-by applies to the usage query only");
  }
  if (groupText !== undefined && !(GROUPS as readonly string[]).includes(groupText)) {
    throw new BadArgument(`unknown group '${groupText}' (${GROUPS.join(", ")})`);
  }
  const accounts = values.account ?? [];
  const providers = values.provider ?? [];
  if (query === "accounts" && (accounts.length > 0 || providers.length > 0)) {
    throw new BadArgument("the accounts query lists every account; drop --account and --provider");
  }
  for (const provider of providers) {
    if (!PROVIDERS.includes(provider)) {
      throw new BadArgument(`unknown provider '${provider}' (${PROVIDERS.join(", ")})`);
    }
  }
  if (values.tz !== undefined && !isTimeZone(values.tz)) {
    throw new BadArgument(
      `unknown time zone '${values.tz}' (use an IANA name such as Europe/Paris)`,
    );
  }
  return {
    query: query as Parsed["query"],
    period: periodText as Period | "custom",
    since: values.since,
    until: values.until,
    groupBy: (groupText as GroupBy | undefined) ?? null,
    accounts,
    providers,
    tz: values.tz,
    refresh: values.refresh === true,
  };
}

export interface JsonOptions {
  home?: string;
  /**
   * The single-writer ingest lock (T10's, through the MCP server's interface) for
   * --refresh. Null while this build has none: the pass then runs unlocked, which is safe
   * (SQLite serialises writers and every write is an idempotent max-merge) and at worst
   * repeats work a running TUI is doing.
   */
  acquireWriterLock?: AcquireWriterLock | null;
}

/**
 * --refresh: one incremental ingest pass into the store, under the writer lock. Returns
 * why the store was not refreshed (as document warnings), or nothing. History import and
 * config creation stay with the TUI and `tokenhud import-cc-usage`.
 */
async function refresh(env: Env, home: string, options: JsonOptions): Promise<string[]> {
  const acquire = options.acquireWriterLock ?? null;
  let lock: ReturnType<AcquireWriterLock> = null;
  if (acquire !== null) {
    try {
      lock = acquire();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      return [`not refreshed: cannot take the ingest lock (${code})`];
    }
    if (lock === null) {
      return [
        "not refreshed: another tokenhud process holds the ingest lock and keeps the store current",
      ];
    }
  }
  const held = lock;
  const beat = held === null ? null : setInterval(() => held.heartbeat(), LOCK_HEARTBEAT_MS);
  const problems: string[] = [];
  try {
    const engine = IngestEngine.open({
      storePath: storePath(env, home),
      cachePath: cachePath(env, home),
      config: loadConfig(configPath(env, home)),
      discover: { home, env },
      importLedger: null,
      log: (level, message) => {
        if (level !== "info") problems.push(`refresh: ${message}`);
      },
    });
    try {
      await engine.fullPass();
    } finally {
      engine.close();
    }
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    problems.push(`not refreshed: ${error.message}`);
  } finally {
    if (beat !== null) clearInterval(beat);
    held?.release();
  }
  return problems;
}

export async function runJson(
  args: readonly string[],
  env: Env = process.env,
  options: JsonOptions = {},
): Promise<number> {
  let parsed: Parsed | "help";
  try {
    parsed = parse(args);
  } catch (error) {
    // parseArgs reports unknown options and missing values as TypeErrors with a code.
    if (
      error instanceof BadArgument ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      return fail("bad_argument", (error as Error).message);
    }
    throw error;
  }
  if (parsed === "help") {
    process.stdout.write(`${JSON_HELP}\n`);
    return 0;
  }

  const home = options.home ?? homedir();
  const refreshed = parsed.refresh ? await refresh(env, home, options) : [];
  const now = Date.now();
  let db: Database | null = null;
  try {
    db = openStoreReader(storePath(env, home)) ?? emptyStoreDatabase();
    const priced = loadPriceTable(pricingOverridesPath(env, home));
    const warnings = [...priced.warnings, ...refreshed];
    const zone =
      parsed.tz === undefined
        ? Zone.configured(loadConfig(configPath(env, home)).time_zone)
        : Zone.of(parsed.tz);
    const queries = new UsageQueries(db, priced.table, { tz: zone.name, now: () => now });
    let period: Period;
    if (parsed.period === "custom") {
      const since = parseBound("--since", parsed.since ?? "", zone, false);
      const until =
        parsed.until === undefined ? now + 1 : parseBound("--until", parsed.until, zone, true);
      if (until <= since) throw new BadArgument("--until must be after --since");
      period = { since, until };
    } else {
      period = parsed.period;
    }
    const known = queries.accountList();
    const req: DocumentRequest = {
      period,
      tz: zone.name,
      ...(parsed.accounts.length > 0 && { accounts: resolveAccounts(parsed.accounts, known) }),
      ...(parsed.providers.length > 0 && { providers: parsed.providers }),
    };
    const ctx: DocumentContext = { now, warnings };
    const doc =
      parsed.query === "usage"
        ? usageDocument(queries, req, parsed.groupBy, ctx)
        : parsed.query === "models"
          ? modelsDocument(queries, req, ctx)
          : accountsDocument(queries, req, ctx);
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof BadArgument) return fail("bad_argument", error.message);
    if (error instanceof StoreError) return fail("store_error", error.message);
    throw error;
  } finally {
    db?.close();
  }
}

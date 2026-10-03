import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaType,
  McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  type StdioServerHandle,
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import {
  ALERT_WINDOWS,
  alertsPath,
  currentSession,
  NOTE_MAX,
  sweepHookSeen,
} from "../alerts/store.ts";
import { AlertWatch } from "../alerts/watch.ts";
import { type Config, configPath, liveConfig } from "../config.ts";
import { cachePath } from "../ingest/cursors.ts";
import { IngestEngine } from "../ingest/engine.ts";
import { ccUsageLimitsPath, limitsPath } from "../limits/cache.ts";
import {
  codexSnapshotsFrom,
  LimitsService,
  type ManualLinks,
  manualLinks,
} from "../limits/index.ts";
import { pricingOverridesPath, storePath } from "../paths.ts";
import { loadPriceTable } from "../pricing/overrides.ts";
import { PERIOD_NAMES } from "../query/periods.ts";
import { Zone } from "../query/tz.ts";
import { discoverClaudeRoots, discoverCodexRoots, type Root } from "../sources/roots.ts";
import { VERSION } from "../version.ts";
import { transcriptExists } from "./accounts.ts";
import { asToolError } from "./errors.ts";
import { type AcquireWriterLock, Freshener } from "./freshness.ts";
import { Heartbeat, mcpDir } from "./heartbeat.ts";
import { newestUsage, StoreSource } from "./store.ts";
import {
  type AccountArgs,
  type ClearAlertArgs,
  MAX_USAGE_GROUPS,
  type SetAlertArgs,
  Tools,
  type ToolsDeps,
  type UsageArgs,
} from "./tools.ts";
import { MAX_WAIT_S, type WaitClock } from "./wait.ts";

/**
 * `tokenhud mcp`: a stdio MCP server (`@modelcontextprotocol/server` 2.2.0, `serveStdio`)
 * that Claude Code starts once per session. stdout is the protocol; anything else goes to
 * stderr, which Claude Code keeps in its MCP log.
 *
 * Claude Code loads MCP tools on demand through ToolSearch, so every description names
 * what an agent would search for: usage limit, rate limit, quota, reset, wait.
 */

type Env = Readonly<Record<string, string | undefined>>;

const PROVIDER: JsonSchemaType = { type: "string", enum: ["claude", "codex"] };
const ACCOUNT: JsonSchemaType = {
  type: "string",
  description:
    "An account label or id from the accounts tool. Omit it for the account this session runs on.",
};
const MODEL: JsonSchemaType = {
  type: "string",
  description:
    "Your model id (e.g. claude-opus-4-8), if you know it. Per-model limits (e.g. FABLE WEEKLY) apply only when they match it; without it they are only mentioned.",
};
const ACCOUNT_PROVIDER: JsonSchemaType = {
  ...PROVIDER,
  description: "claude (default) or codex: which provider's current account to use.",
};

function schema<T>(properties: Record<string, JsonSchemaType>, required: string[] = []) {
  return fromJsonSchema<T>({ type: "object", properties, required, additionalProperties: false });
}

const LIMITS_INPUT = schema<AccountArgs>({ account: ACCOUNT, provider: ACCOUNT_PROVIDER });

type ShouldWaitInput = AccountArgs & {
  min_headroom?: number;
  window?: string;
  estimated_cost?: number;
  model?: string;
};
const SHOULD_WAIT_INPUT = schema<ShouldWaitInput>({
  min_headroom: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "Share of each window to keep free (default 0.1: wait at 90% used).",
  },
  window: {
    type: "string",
    description: "Only this window, by kind or label (session / 5-HOUR, weekly_all / WEEKLY).",
  },
  estimated_cost: {
    type: "number",
    minimum: 0,
    description: "Rough API-equivalent USD the next piece of work will cost.",
  },
  model: MODEL,
  account: ACCOUNT,
  provider: ACCOUNT_PROVIDER,
});

type WaitInput = AccountArgs & {
  window?: string;
  max_wait_s: number;
  until_utilization_below?: number;
  model?: string;
};
const WAIT_INPUT = schema<WaitInput>(
  {
    window: {
      type: "string",
      description: "The window to wait on, by kind or label; default the one should_wait reports.",
    },
    max_wait_s: {
      type: "integer",
      minimum: 1,
      maximum: MAX_WAIT_S,
      description: `Longest wait in seconds (at most ${MAX_WAIT_S}, 5 hours).`,
    },
    until_utilization_below: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 1,
      description: "Also stop once the window's utilization (0-1) is under this.",
    },
    model: MODEL,
    account: ACCOUNT,
    provider: ACCOUNT_PROVIDER,
  },
  ["max_wait_s"],
);

const USAGE_INPUT = schema<UsageArgs>(
  {
    period: { type: "string", enum: [...PERIOD_NAMES, "custom"] },
    since: {
      type: "string",
      description: "For period custom: YYYY-MM-DD (local) or an ISO-8601 instant with offset.",
    },
    until: { type: "string", description: "For period custom; default now. A date is included." },
    group_by: { type: "string", enum: ["model", "account", "day", "week", "month"] },
    account: {
      type: "string",
      description: "An account label or id. Omit it for every account.",
    },
    provider: { ...PROVIDER, description: "Only this provider's usage." },
    tz: { type: "string", description: "IANA time zone for calendar periods (default local)." },
  },
  ["period"],
);

const NO_INPUT = schema<Record<string, never>>({});

const SET_ALERT_INPUT = schema<AccountArgs & SetAlertArgs>(
  {
    window: {
      type: "string",
      enum: [...ALERT_WINDOWS],
      description:
        "Which limit window: 5h (the 5-hour window), weekly, weekly_scoped (a model's own weekly limit, e.g. FABLE WEEKLY) or any.",
    },
    at: {
      type: "number",
      minimum: 1,
      maximum: 100,
      description: "Percent used at which to tell you, e.g. 80.",
    },
    account: ACCOUNT,
    provider: ACCOUNT_PROVIDER,
    scope: {
      type: "string",
      enum: ["session", "persistent"],
      description:
        "session (default): the alert ends with this Claude Code session. persistent: it stays, and is told to sessions on the account, until cleared.",
    },
    note: {
      type: "string",
      maxLength: NOTE_MAX,
      description:
        "Your own words to get back when it fires, e.g. 'pause the refactor and commit' (at most 200 characters).",
    },
  },
  ["window", "at"],
);

const CLEAR_ALERT_INPUT = schema<ClearAlertArgs>({
  id: { type: "string", description: "The alert's id, from set_alert or list_alerts." },
  all: { type: "boolean", description: "Clear every alert of this session instead." },
  persistent: {
    type: "boolean",
    description: "With all: the persistent alerts go too.",
  },
});

const DESCRIPTIONS = {
  limits:
    "Usage limits of this Claude Code (or Codex) account: each rate limit window (5-hour, weekly), its utilization (0-1), when it resets, the spend pace it is projected at (pace_basis: 30m, the last 30 minutes, or window_avg, a weekly window's average since it began) and the projected exhaustion time with the seconds until it (projected_exhaustion_at, projected_exhaustion_in_s; an estimate, a weekly one coarse). Use it to see the remaining quota; should_wait decides whether to wait. Defaults to the account this session runs on.",
  should_wait:
    "Should this agent pause because a usage limit / rate limit is nearly used up? Returns wait (true/false), a short reason, the binding window with its pace (pace_basis) and projected exhaustion (projected_exhaustion_at, and projected_exhaustion_in_s seconds from now), and wait_s until its reset. Call it before a long autonomous run or many subagents, and after a rate-limit or 'usage limit reached' error. Pass model (your model id) so per-model limits count when they are yours. estimated_cost (USD) checks whether that much work still fits in the quota.",
  wait_for_reset:
    "Wait until a usage limit window resets, for non-interactive sessions (claude -p, background tasks, teammates) blocked by a rate limit or an exhausted quota. Sends progress while it waits, re-checks the limits every 5 minutes, returns once the window resets or utilization drops under until_utilization_below, and never waits past max_wait_s (at most 18000 s). In an interactive session, tell the user instead of waiting.",
  usage: `Token usage and API-equivalent cost from this machine's Claude Code and Codex transcripts, for a period (today, this_week, this_month, all, 1h, 5h, 24h, or custom since/until), optionally grouped by model, account, day, week or month (at most ${MAX_USAGE_GROUPS} groups per call). Not the subscription quota: use limits for usage limits and resets.`,
  accounts:
    "The Claude Code and Codex accounts on this machine, from cached data (no requests): label, provider, whether usage limits can be read here (signed_in; null until first checked), last usage, and which one this session runs on (is_current). Pass a label as account to the other tools.",
  set_alert:
    "Set a usage limit alert: tokenhud tells you, in your context, when a rate limit window (5-hour or weekly quota) reaches a percent, e.g. 'tell me when the 5-hour window reaches 80%', so you needn't poll limits. Use it before a long autonomous task or many subagents. It fires once per window (again after the window resets); note is repeated back to you then. Returns the alert's id and the window's current state; a window already at or over the percent is said so and fires next after its reset. Alerts reach you through tokenhud's Claude Code hook: the answer warns when this session doesn't run it.",
  list_alerts:
    "List this session's usage limit alerts and every persistent one, each armed or fired (and when) for the window's current instance, with whether alerts reach this session (the tokenhud hook).",
  clear_alert:
    "Clear a usage limit alert by id, or all of this session's with all: true (persistent ones too with persistent: true). Clear an alert once the task it guarded is done.",
} as const;

function ok(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** Registers the tools on a new server. Each call is one server instance (serveStdio's factory). */
export function createMcpServer(tools: Tools, log: (message: string) => void): McpServer {
  const server = new McpServer(
    { name: "tokenhud", version: VERSION },
    { capabilities: { tools: {} } },
  );
  const answer = async (run: () => Promise<object>): Promise<CallToolResult> => {
    try {
      return ok(await run());
    } catch (error) {
      const failure = asToolError(error, log);
      return {
        content: [{ type: "text", text: failure.message }],
        structuredContent: { error: { code: failure.code, message: failure.message } },
        isError: true,
      };
    }
  };

  server.registerTool(
    "limits",
    { title: "Usage limits", description: DESCRIPTIONS.limits, inputSchema: LIMITS_INPUT },
    (args) => answer(() => tools.limits(args)),
  );
  server.registerTool(
    "should_wait",
    {
      title: "Should I wait?",
      description: DESCRIPTIONS.should_wait,
      inputSchema: SHOULD_WAIT_INPUT,
    },
    (args) => answer(() => tools.shouldWait(args)),
  );
  server.registerTool(
    "wait_for_reset",
    {
      title: "Wait for a reset",
      description: DESCRIPTIONS.wait_for_reset,
      inputSchema: WAIT_INPUT,
    },
    (args, ctx: ServerContext) => {
      const token = ctx.mcpReq._meta?.progressToken;
      const progress =
        token === undefined
          ? null
          : (value: number, total: number, message: string) =>
              ctx.mcpReq.notify({
                method: "notifications/progress",
                params: { progressToken: token, progress: value, total, message },
              });
      return answer(() => tools.waitForReset(args, ctx.mcpReq.signal, progress));
    },
  );
  server.registerTool(
    "usage",
    { title: "Token usage and cost", description: DESCRIPTIONS.usage, inputSchema: USAGE_INPUT },
    (args) => answer(() => tools.usage(args)),
  );
  server.registerTool(
    "accounts",
    { title: "Accounts", description: DESCRIPTIONS.accounts, inputSchema: NO_INPUT },
    () => answer(() => tools.accounts()),
  );
  server.registerTool(
    "set_alert",
    {
      title: "Set a limit alert",
      description: DESCRIPTIONS.set_alert,
      inputSchema: SET_ALERT_INPUT,
    },
    (args) => answer(() => tools.setAlert(args)),
  );
  server.registerTool(
    "list_alerts",
    { title: "Limit alerts", description: DESCRIPTIONS.list_alerts, inputSchema: NO_INPUT },
    () => answer(() => tools.listAlerts()),
  );
  server.registerTool(
    "clear_alert",
    {
      title: "Clear a limit alert",
      description: DESCRIPTIONS.clear_alert,
      inputSchema: CLEAR_ALERT_INPUT,
    },
    (args) => answer(() => tools.clearAlert(args)),
  );
  return server;
}

/** What usage answers say about a bad price overrides file; the detail goes to stderr. */
export const PRICE_WARNING =
  "the price overrides file has problems, so some or all of it is ignored (run `tokenhud doctor` for details)";

/** How long discovered roots are reused: discovery reads /mnt/c over 9P under WSL. */
const ROOTS_TTL_MS = 60_000;

export const realClock: WaitClock = {
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    }),
};

export interface WiringOptions {
  env?: Env;
  home?: string;
  /**
   * The single-writer ingest lock (T10's `src/lock.ts`); `tokenhud mcp` passes it. Null:
   * the server answers usage from the store as it is.
   */
  acquireWriterLock?: AcquireWriterLock | null;
  /** Tests: a fake clock for waits, a fixed now and zone, and T8's fetching mocked. */
  clock?: WaitClock;
  now?: () => number;
  zone?: Zone;
  refresh?: ToolsDeps["refresh"];
  log?: (message: string) => void;
  /** The Claude Code process that started the server (`process.ppid`): finds its session. */
  ppid?: number;
}

export interface Wiring {
  tools: Tools;
  heartbeat: Heartbeat;
  /** Refreshes the accounts of this session's armed alerts every 5 minutes (T29). */
  watch: AlertWatch;
  /** Ends waits in flight, stops T8's fetches and closes the store. */
  close(): Promise<void>;
}

/** The tools over the real store, limits, roots and ingest of `env` and `home`. */
export function wireTools(options: WiringOptions = {}): Wiring {
  const env: Env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const log =
    options.log ?? ((message: string) => process.stderr.write(`tokenhud mcp: ${message}\n`));
  const now = options.now ?? Date.now;
  // config.json, read again when it changes: the TUI's settings edit roots and account
  // links while this server runs for the rest of a session, and the account groups it
  // records must come from the links as they are.
  const currentConfig = liveConfig(configPath(env, home));
  const config = currentConfig();
  const discover = { home, env: { ...env } };
  let cached: { at: number; config: Config; roots: Root[] } | null = null;
  const roots = (): Root[] => {
    const at = Date.now();
    const now = currentConfig();
    if (cached === null || cached.config !== now || at - cached.at > ROOTS_TTL_MS) {
      const claude = discoverClaudeRoots(now, discover);
      cached = {
        at,
        config: now,
        roots: [...claude, ...discoverCodexRoots(now, discover, claude)],
      };
    }
    return cached.roots;
  };
  const links = (): ManualLinks => manualLinks(currentConfig());

  const zone = options.zone ?? Zone.configured(config.time_zone);
  const { table, warnings } = loadPriceTable(pricingOverridesPath(env, home));
  // The warnings quote the file's path and contents: they stay in the log.
  for (const warning of warnings) log(`price overrides: ${warning}`);
  const path = storePath(env, home);
  const store = new StoreSource(path, table, zone.name, now);
  const snapshots = codexSnapshotsFrom(cachePath(env, home));
  const service = new LimitsService({
    limitsPath: limitsPath(env, home),
    ccUsageLimits: ccUsageLimitsPath(env, home),
    roots: () => roots().filter((r) => r.enabled),
    snapshots,
    links,
    now,
    log: (level, message) => log(`${level}: ${message}`),
  });
  service.importIfFirstRun();
  const freshener = new Freshener({
    acquireWriterLock: options.acquireWriterLock ?? null,
    newestData: () => newestUsage(store.get().db),
    ingestOnce: async () => {
      const engine = IngestEngine.open({
        storePath: path,
        cachePath: cachePath(env, home),
        config: currentConfig(),
        discover,
        // History import stays with the TUI and `tokenhud import-cc-usage`: a tool call
        // shouldn't wait for one.
        importLedger: null,
        log: (level, message) => log(`ingest ${level}: ${message}`),
      });
      try {
        const report = await engine.fullPass();
        if (report?.storeError) throw new Error(report.storeError);
      } finally {
        engine.close();
      }
    },
    now,
    log,
  });
  const mcp = mcpDir(env, home);
  const startedAt = now();
  const ppid = options.ppid ?? process.ppid;
  const session = () => currentSession(env, mcp, ppid, startedAt);
  const heartbeat = new Heartbeat(mcp, { log, session });
  const shutdown = new AbortController();
  const clock = options.clock ?? realClock;
  const refresh: ToolsDeps["refresh"] =
    options.refresh ?? ((account, maxAgeS) => service.refresh(account, maxAgeS));
  const tools = new Tools({
    env,
    home,
    zone,
    now,
    roots,
    store: () => store.get(),
    priceWarnings: warnings.length === 0 ? [] : [PRICE_WARNING],
    limitsPath: limitsPath(env, home),
    snapshots,
    links,
    refresh,
    freshen: () => freshener.ensure(),
    hasTranscript: memoTranscripts(),
    clock: {
      now: clock.now,
      // A wait also ends when the server shuts down.
      sleep: (ms, signal) => clock.sleep(ms, AbortSignal.any([signal, shutdown.signal])),
    },
    record: (tool, account) => heartbeat.record(tool, account),
    alertsPath: alertsPath(env, home),
    mcpDir: mcp,
    session,
    log,
  });
  const watch = new AlertWatch({ armed: () => tools.armedAccounts(), refresh, log });
  return {
    tools,
    heartbeat,
    watch,
    async close() {
      watch.stop();
      shutdown.abort();
      await service.stop();
      store.close();
    },
  };
}

/** Serves `tools` over a stdio transport (the process's own stdin/stdout by default). */
export function serveTools(
  tools: Tools,
  log: (message: string) => void,
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): StdioServerHandle {
  return serveStdio(() => createMcpServer(tools, log), {
    transport: new StdioServerTransport(stdin, stdout),
    onerror: (error) => log(`protocol: ${error.message}`),
  });
}

/** Runs the server until the client closes stdin or a signal arrives. Resolves with the exit code. */
export async function runMcpServer(options: WiringOptions = {}): Promise<number> {
  const log = (message: string) => process.stderr.write(`tokenhud mcp: ${message}\n`);
  const wiring = wireTools({ log, ...options });
  const stdin = process.stdin;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const closed = new Promise<void>((resolve) => {
    const stop = () => {
      stdin.off("end", stop);
      stdin.off("close", stop);
      for (const s of signals) process.off(s, stop);
      resolve();
    };
    stdin.on("end", stop);
    stdin.on("close", stop);
    for (const s of signals) process.on(s, stop);
  });
  wiring.heartbeat.start();
  wiring.watch.start();
  // Sessions that ended without SessionEnd (a crash) leave their hook's record behind.
  sweepHookSeen(mcpDir(options.env ?? process.env, options.home ?? homedir()), Date.now());
  const handle = serveTools(wiring.tools, log);
  await closed;
  await Promise.allSettled([handle.close(), wiring.close()]);
  wiring.heartbeat.stop();
  return 0;
}

/**
 * `transcriptExists`, remembering hits: a session's transcript stays where it is, so a root
 * found once is not listed again on every call. Misses are checked again each time.
 */
function memoTranscripts(): (root: Root, sessionId: string) => boolean {
  const found = new Set<string>();
  return (root, sessionId) => {
    const key = `${root.identity}/${sessionId}`;
    if (found.has(key)) return true;
    const exists = transcriptExists(root, sessionId);
    if (exists) found.add(key);
    return exists;
  };
}

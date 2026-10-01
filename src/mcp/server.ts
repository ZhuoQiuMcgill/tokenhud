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
import { configPath, loadConfig } from "../config.ts";
import { cachePath } from "../ingest/cursors.ts";
import { IngestEngine } from "../ingest/engine.ts";
import { ccUsageLimitsPath, limitsPath } from "../limits/cache.ts";
import { codexSnapshotsFrom, LimitsService } from "../limits/index.ts";
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
  MAX_USAGE_GROUPS,
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
  account: ACCOUNT,
  provider: ACCOUNT_PROVIDER,
});

type WaitInput = AccountArgs & {
  window?: string;
  max_wait_s: number;
  until_utilization_below?: number;
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

const DESCRIPTIONS = {
  limits:
    "Usage limits of this Claude Code (or Codex) account: each rate limit window (5-hour, weekly), its utilization (0-1), when it resets, the spend pace and the projected exhaustion time (an estimate). Use it to see the remaining quota; should_wait decides whether to wait. Defaults to the account this session runs on.",
  should_wait:
    "Should this agent pause because a usage limit / rate limit is nearly used up? Returns wait (true/false), a short reason, the binding window and wait_s until its reset. Call it before a long autonomous run or many subagents, and after a rate-limit or 'usage limit reached' error. estimated_cost (USD) checks whether that much work still fits in the quota.",
  wait_for_reset:
    "Wait until a usage limit window resets, for non-interactive sessions (claude -p, background tasks, teammates) blocked by a rate limit or an exhausted quota. Sends progress while it waits, re-checks the limits every 5 minutes, returns once the window resets or utilization drops under until_utilization_below, and never waits past max_wait_s (at most 18000 s). In an interactive session, tell the user instead of waiting.",
  usage: `Token usage and API-equivalent cost from this machine's Claude Code and Codex transcripts, for a period (today, this_week, this_month, all, 1h, 5h, 24h, or custom since/until), optionally grouped by model, account, day, week or month (at most ${MAX_USAGE_GROUPS} groups per call). Not the subscription quota: use limits for usage limits and resets.`,
  accounts:
    "The Claude Code and Codex accounts on this machine: label, provider, whether usage limits can be read here (signed_in), last usage, and which one this session runs on (is_current). Pass a label as account to the other tools.",
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
  return server;
}

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
   * The single-writer ingest lock (T10's `src/lock.ts`). Null until it exists in this
   * build: the server then answers usage from the store as it is.
   */
  acquireWriterLock?: AcquireWriterLock | null;
  /** Tests: a fake clock for waits, a fixed now and zone, and T8's fetching mocked. */
  clock?: WaitClock;
  now?: () => number;
  zone?: Zone;
  refresh?: ToolsDeps["refresh"];
  log?: (message: string) => void;
}

export interface Wiring {
  tools: Tools;
  heartbeat: Heartbeat;
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
  const config = loadConfig(configPath(env, home));
  const discover = { home, env: { ...env } };
  let cached: { at: number; roots: Root[] } | null = null;
  const roots = (): Root[] => {
    const at = Date.now();
    if (cached === null || at - cached.at > ROOTS_TTL_MS) {
      const claude = discoverClaudeRoots(config, discover);
      cached = { at, roots: [...claude, ...discoverCodexRoots(config, discover, claude)] };
    }
    return cached.roots;
  };

  const zone = options.zone ?? Zone.system();
  const { table, warnings } = loadPriceTable(pricingOverridesPath(env, home));
  const path = storePath(env, home);
  const store = new StoreSource(path, table, zone.name, now);
  const snapshots = codexSnapshotsFrom(cachePath(env, home));
  const service = new LimitsService({
    limitsPath: limitsPath(env, home),
    ccUsageLimits: ccUsageLimitsPath(env, home),
    roots: () => roots().filter((r) => r.enabled),
    snapshots,
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
        config,
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
  const heartbeat = new Heartbeat(mcpDir(env, home), { log });
  const shutdown = new AbortController();
  const clock = options.clock ?? realClock;
  const tools = new Tools({
    env,
    home,
    zone,
    now,
    roots,
    store: () => store.get(),
    priceWarnings: warnings,
    limitsPath: limitsPath(env, home),
    snapshots,
    refresh: options.refresh ?? ((account, maxAgeS) => service.refresh(account, maxAgeS)),
    freshen: () => freshener.ensure(),
    hasTranscript: memoTranscripts(),
    clock: {
      now: clock.now,
      // A wait also ends when the server shuts down.
      sleep: (ms, signal) => clock.sleep(ms, AbortSignal.any([signal, shutdown.signal])),
    },
    record: (tool, account) => heartbeat.record(tool, account),
  });
  return {
    tools,
    heartbeat,
    async close() {
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

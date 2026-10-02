// `tokenhud`: the interactive TUI. This module is the UI thread's entry; it must never reach
// the query layer or the store (test/tui/imports.test.ts checks the import graph). View
// models come from the view-model Worker, which starts first so that its warm-up runs while
// OpenTUI and React load.
import { homedir } from "node:os";
import { join } from "node:path";
import { ccUsageDir, configPath, ensureConfig } from "../config.ts";
import { ccUsageLimitsPath, limitsPath } from "../limits/cache.ts";
import { lockFailure, lockPath, WriterLock } from "../lock.ts";
import { mcpDir } from "../mcp/heartbeat.ts";
import { configDir, pricingOverridesPath, storePath } from "../paths.ts";
import { fileLog, logPath } from "./log.ts";
import type { Boot, TuiPaths } from "./run.tsx";
import { superviseVmWorker } from "./vm/client.ts";
import { type VmMessage, vmSettingsOf } from "./vm/types.ts";

type Env = Readonly<Record<string, string | undefined>>;

export function tuiPaths(env: Env, home: string): TuiPaths {
  return {
    config: configPath(env, home),
    store: storePath(env, home),
    // src/ingest/cursors.ts `cachePath`, spelled out here: that module opens SQLite, which the
    // UI thread never loads. A test keeps the two equal.
    cache: join(configDir(env, home), "cache.db"),
    limits: limitsPath(env, home),
    overrides: pricingOverridesPath(env, home),
    lock: lockPath(env, home),
    mcp: mcpDir(env, home),
    ccUsageLedger: join(ccUsageDir(env, home), "ledger.sqlite3"),
    ccUsageLimits: ccUsageLimitsPath(env, home),
    log: logPath(env, home),
  };
}

/** Runs the TUI until the user quits; resolves with the exit code. */
export async function runTui(env: Env = process.env, home: string = homedir()): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "tokenhud: the interactive view needs a terminal; for text output use tokenhud --once or tokenhud json\n",
    );
    return 2;
  }
  const paths = tuiPaths(env, home);
  const { config } = ensureConfig(paths.config, join(ccUsageDir(env, home), "config.json"), {
    home,
    env,
  });
  let lock: WriterLock | null = null;
  let lockError: string | null = null;
  const log = fileLog(paths.log, home);
  try {
    lock = WriterLock.tryAcquire({
      path: paths.lock,
      owner: "tui",
      log: (message) => log.write("warn", message),
    });
  } catch (error) {
    // An unwritable config dir, or a lock file or journal that can't be repaired: show what
    // is stored, and retry on every tick (run.tsx).
    lockError = lockFailure(error);
  }
  const early: VmMessage[] = [];
  let deliver: (message: VmMessage) => void = (message) => early.push(message);
  const vm = superviseVmWorker({
    start: {
      type: "start",
      storePath: paths.store,
      overridesPath: paths.overrides,
      mcpDir: paths.mcp,
      limitsPath: paths.limits,
      cachePath: paths.cache,
      mode: lock === null ? "reader" : "owner",
      settings: vmSettingsOf(config, null),
      scopeLabel: config.account_scope === "all" ? null : config.account_scope,
      config,
      discover: { home, env: { ...env } },
    },
    onMessage: (message) => deliver(message),
  });
  const { runApp } = await import("./run.tsx");
  const boot: Boot = {
    env,
    home,
    paths,
    config,
    lock,
    lockError,
    vm,
    early,
    attach: (fn) => {
      deliver = fn;
    },
    trace: env.TOKENHUD_TRACE ?? null,
  };
  return runApp(boot);
}

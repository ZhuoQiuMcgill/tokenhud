// The test guard (T15): no test may run the real `claude` or `codex` (one did, against the
// real home), and the guard must hold whatever directory `bun test` is run from.
//
// Every test file imports this module and calls `guard()` at its top; test/lint.test.ts
// fails a file that doesn't. Importing it installs the guard once per thread:
// - stub `claude` and `codex` executables (`.cmd` files on Windows) in a new temp dir, first
//   on PATH. A stub writes "real <name> spawned from a test" to stderr, records its name in
//   the dir's log and exits 97;
// - TOKENHUD_TEST=1 and TOKENHUD_TEST_STUBS, which turn on the product's refusal
//   (`refuseRealClient`) of any client outside the test temp root;
// - every Worker, `Bun.spawn` and `Bun.spawnSync` gets those variables merged into its env.
//   Bun otherwise starts both with the environment the process started with, not
//   `process.env` as it is now, and a caller's own env would drop them.
// `guard()` then fails any test after which a stub ran or a client was refused, even when
// the code under test swallowed the error. Under the preload (`bun test` from the repo
// root, which reads bunfig.toml) that check is global, set before any test file loads.
import { afterAll, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { TEST_SPAWN_LOG } from "../src/limits/clients.ts";
import { removeTempDir } from "./temp.ts";

/** The provider clients tokenhud runs. */
const CLIENTS = ["claude", "codex"] as const;

const windows = process.platform === "win32";

/** Whether `name` is PATH: on Windows names ignore case, and it is spelled `Path`. */
const isPath = (name: string) => (windows ? name.toUpperCase() === "PATH" : name === "PATH");

/** The names PATH goes by in `process.env`. */
export function pathNames(): string[] {
  return Object.keys(process.env).filter(isPath);
}

// GitHub's Windows runners keep %TEMP% on the VM's OS disk, C:. Measured on two runners
// (T15): there a 4 KB write plus fsync took 5–8 ms at the median and up to 92 ms, and
// creating a store with a backup 120–200 ms; on the runner's temp disk, RUNNER_TEMP on D:,
// 0.3 ms and 11 ms. The whole suite took 150–310 s on C: and 71–81 s on D:. The store
// syncs whenever it creates a file, backs up or checkpoints, so tests that make stores
// waited seconds on C:, and in a slow spell ran past their 5 s timeout. On a Windows
// runner, tests therefore make their temp dirs under RUNNER_TEMP, which GitHub provides
// per job and empties after it. Elsewhere nothing changes.
function tempOnRunnerDisk(): void {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (windows && runnerTemp) {
    process.env.TEMP = runnerTemp;
    process.env.TMP = runnerTemp;
  }
}

/** Makes the stub clients in a new temp dir; returns the dir. */
function makeStubs(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-test-bin-"));
  const log = join(dir, TEST_SPAWN_LOG);
  for (const name of CLIENTS) {
    const message = `real ${name} spawned from a test`;
    if (windows) {
      const lines = ["@echo off", `echo ${message} 1>&2`, `>>"${log}" echo ${name}`, "exit /b 97"];
      writeFileSync(join(dir, `${name}.cmd`), `${lines.join("\r\n")}\r\n`);
    } else {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\necho '${message}' >&2\necho ${name} >> '${log}'\nexit 97\n`);
      chmodSync(path, 0o755);
    }
  }
  return dir;
}

/**
 * `env` with the guard merged in: TOKENHUD_TEST, the stub dir, and the stubs first on PATH
 * (alone, if `env` has no PATH). For every env a test hands a child or a Worker.
 */
export function childEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  let path: string | undefined;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isPath(name)) path = value;
    else out[name] = value;
  }
  // Spelled PATH: a Worker handed Windows' `Path` looks PATH up case-sensitively and
  // misses it (10 of 10 runs on a Windows runner, T15).
  out.PATH =
    path === undefined || path === ""
      ? stubs
      : path.split(delimiter)[0] === stubs
        ? path
        : `${stubs}${delimiter}${path}`;
  out.TOKENHUD_TEST = "1";
  out.TOKENHUD_TEST_STUBS = stubs;
  return out;
}

type SpawnOptions = { env?: Record<string, string | undefined> } & Record<string, unknown>;

/** Bun.spawn's and spawnSync's arguments, either form, with `childEnv` as the env. */
function withGuardEnv(args: unknown[]): unknown[] {
  const [first, second] = args as [unknown, SpawnOptions | undefined];
  if (Array.isArray(first))
    return [first, { ...second, env: childEnv(second?.env ?? process.env) }];
  const options = first as SpawnOptions;
  return [{ ...options, env: childEnv(options.env ?? process.env) }];
}

/** Gives every Worker and child the guard's env, whatever env it was (or wasn't) given. */
function wrapSpawners(): void {
  const BunWorker = globalThis.Worker;
  globalThis.Worker = class extends BunWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const env = options?.env;
      super(url, { ...options, env: typeof env === "symbol" ? env : childEnv(env ?? process.env) });
    }
  };
  const bun = Bun as unknown as Record<"spawn" | "spawnSync", (...args: unknown[]) => unknown>;
  const spawn = bun.spawn;
  const spawnSync = bun.spawnSync;
  bun.spawn = (...args) => spawn(...withGuardEnv(args));
  bun.spawnSync = (...args) => spawnSync(...withGuardEnv(args));
}

/**
 * Installs the guard in this thread, once. A thread that inherits a guard (a Worker or
 * child of a guarded test) keeps its stub dir rather than making another.
 */
function install(): string {
  tempOnRunnerDisk();
  const inherited = process.env.TOKENHUD_TEST_STUBS;
  const dir = inherited && existsSync(inherited) ? inherited : makeStubs();
  const path = process.env.PATH ?? "";
  for (const name of pathNames()) delete process.env[name];
  process.env.PATH = path.split(delimiter)[0] === dir ? path : `${dir}${delimiter}${path}`;
  process.env.TOKENHUD_TEST = "1";
  process.env.TOKENHUD_TEST_STUBS = dir;
  wrapSpawners();
  return dir;
}

const stubs = install();
/** Set by the preload, whose check covers every test. */
let global = false;

/**
 * What reached a stub, or was refused by the product, since the last call: one line per
 * attempt ("claude", "codex (refused)"). Clears the log.
 */
export function takeSpawned(): string[] {
  const log = join(stubs, TEST_SPAWN_LOG);
  if (!existsSync(log)) return [];
  const lines = readFileSync(log, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  writeFileSync(log, "");
  return lines;
}

function check(): void {
  const spawned = takeSpawned();
  if (spawned.length > 0) {
    throw new Error(
      `this test reached a real provider client (${spawned.join(", ")}); give it an explicit stub`,
    );
  }
}

/**
 * Fails, after each test of the calling file, a test that reached a client. Every test
 * file calls it at its top: Bun evaluates this module once per run, so a hook registered
 * here when it loads would cover only the first file. A no-op under the preload.
 */
export function guard(): void {
  if (!global) afterEach(check);
}

/** The preload's: the check for every test, and the stub dir removed at the end. */
export function guardEveryTest(): void {
  global = true;
  afterEach(check);
  afterAll(() => removeTempDir(stubs));
}

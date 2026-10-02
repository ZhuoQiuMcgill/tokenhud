import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { TEST_SPAWN_LOG } from "../src/limits/clients.ts";

/** The provider clients tokenhud runs; a test must never run the real ones. */
const CLIENTS = ["claude", "codex"] as const;

/**
 * Makes stub `claude` and `codex` executables (`.cmd` files on Windows) in a new temp dir,
 * puts it first on PATH, and turns on the product's guard (`refuseRealClient`), which then
 * refuses any client outside the test temp root. A stub writes "real <name> spawned from a
 * test" to stderr, records its name in the dir's log and exits 97. Returns the dir.
 */
export function installClientStubs(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-test-bin-"));
  const log = join(dir, TEST_SPAWN_LOG);
  for (const name of CLIENTS) {
    const message = `real ${name} spawned from a test`;
    if (process.platform === "win32") {
      const lines = ["@echo off", `echo ${message} 1>&2`, `>>"${log}" echo ${name}`, "exit /b 97"];
      writeFileSync(join(dir, `${name}.cmd`), `${lines.join("\r\n")}\r\n`);
    } else {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\necho '${message}' >&2\necho ${name} >> '${log}'\nexit 97\n`);
      chmodSync(path, 0o755);
    }
  }
  const path = process.env.PATH ?? "";
  // Windows spells it `Path` (under pwsh, as in ci.yml; Git Bash says `PATH`). A Worker
  // given that env as a plain record looks `PATH` up case-sensitively, misses it and
  // searches the start-up PATH instead, without the stubs: 10 of 10 runs on a Windows
  // runner. So it is stored as `PATH`.
  for (const name of pathNames()) delete process.env[name];
  process.env.PATH = `${dir}${delimiter}${path}`;
  process.env.TOKENHUD_TEST = "1";
  process.env.TOKENHUD_TEST_STUBS = dir;
  // Bun starts a Worker with the environment the process started with, not `process.env`
  // as it is now (Node's default), so the ingest Worker, which fetches limits, would miss
  // all of the above. In tests, Workers get Node's default.
  const BunWorker = globalThis.Worker;
  globalThis.Worker = class extends BunWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) env[name] = value;
      }
      super(url, { env, ...options });
    }
  };
  return dir;
}

/** The names `PATH` goes by in `process.env`: case-insensitive on Windows. */
export function pathNames(): string[] {
  return Object.keys(process.env).filter((name) =>
    process.platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH",
  );
}

/**
 * What reached a stub, or was refused by the guard, since the last call: one line per
 * attempt ("claude", "codex (refused)"). Clears the log.
 */
export function takeSpawned(): string[] {
  const log = join(process.env.TOKENHUD_TEST_STUBS ?? "", TEST_SPAWN_LOG);
  if (!existsSync(log)) return [];
  const lines = readFileSync(log, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  writeFileSync(log, "");
  return lines;
}

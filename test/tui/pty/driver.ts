// Runs tokenhud in a real pseudo-terminal through `script` (util-linux), feeds it keys,
// and reads its screen back through the Vt emulator. Everything runs in a throwaway home:
// a fake ~/.claude with synthetic transcripts and a temp config dir, never the user's.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../guard.ts";
import { claudeLine } from "../../ingest/helpers.ts";
import { Vt } from "./vt.ts";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const CLI = join(REPO, "src", "cli.ts");

/** Whether this machine can run the pty checks (Linux with util-linux `script`). */
export function ptyAvailable(): boolean {
  if (process.platform !== "linux") return false;
  return (
    Bun.spawnSync(["script", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  );
}

export interface Home {
  readonly dir: string;
  readonly env: Record<string, string>;
  readonly configDir: string;
  readonly projects: string;
  remove(): void;
}

/**
 * A temp HOME with a Claude root holding one synthetic transcript, a config refreshing
 * every 2 s, no Windows-side roots, and nothing inherited that names real accounts.
 */
export function makeHome(options: { store?: string; base?: string; refresh?: number } = {}): Home {
  const dir = mkdtempSync(join(options.base ?? tmpdir(), "tokenhud-pty-"));
  const configDir = join(dir, "config", "tokenhud");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ refresh_interval: options.refresh ?? 2, time_zone: "UTC" }),
  );
  const projects = join(dir, ".claude", "projects", "fake-project");
  mkdirSync(projects, { recursive: true });
  const now = Date.now();
  let lines = "";
  for (let i = 0; i < 40; i++) {
    const ts = new Date(now - (40 - i) * 3 * 60_000).toISOString();
    lines += claudeLine(`PTY${i}`, `PTY${i}`, 1000 + i, 200, { ts, model: "claude-opus-4-8" });
  }
  writeFileSync(join(projects, "00000000-0000-4000-8000-000000000001.jsonl"), lines);
  const env = childEnv({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    TOKENHUD_WSL_USERS: "",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  });
  return {
    dir,
    env,
    configDir,
    projects,
    remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  };
}

export interface PtyRun {
  readonly vt: Vt;
  send(keys: string): void;
  /** Resolves once `pred` holds for the screen; rejects with the screen after `timeoutMs`. */
  waitFor(pred: (screen: string) => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** Raw bytes the program wrote, decoded. */
  output(): string;
  stderr(): Promise<string>;
  /** The program's exit code (script -e passes it through). */
  readonly exited: Promise<number>;
  kill(): void;
}

/**
 * Starts `command` (a shell command line) in a `cols`×`rows` pty. Run `stty` after the
 * program in the same command line to see the modes it left the terminal in.
 */
export function runInPty(
  command: string,
  env: Record<string, string>,
  cols = 105,
  rows = 50,
): PtyRun {
  const vt = new Vt(cols, rows);
  let raw = "";
  const proc = Bun.spawn(
    ["script", "-q", "-e", "-c", `stty cols ${cols} rows ${rows}; ${command}`, "/dev/null"],
    { cwd: REPO, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      raw += text;
      vt.write(text);
    }
  })();
  return {
    vt,
    send(keys) {
      proc.stdin.write(keys);
      proc.stdin.flush();
    },
    async waitFor(pred, what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!pred(vt.text())) {
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for ${what}; screen:\n${vt.text()}`);
        await Bun.sleep(50);
      }
    },
    output: () => raw,
    stderr: () => new Response(proc.stderr).text(),
    exited: proc.exited.then(async (code) => {
      await reading;
      return code;
    }),
    kill: () => proc.kill(),
  };
}

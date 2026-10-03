// Runs tokenhud's hook commands as Claude Code runs them, against a given tokenhud binary,
// through every shell Claude Code runs hook commands in on this machine (T29 B1):
// - the plugin's (plugin/hooks/hooks.json, `tokenhud` from PATH) on each of its events;
// - the one `tokenhud mcp install --hooks` writes (the binary by absolute path);
// - the plugin's with no tokenhud on PATH at all.
// Shells: `/bin/sh -c` on Linux and macOS; on Windows Git Bash (`bash -c`) and PowerShell 7
// and Windows PowerShell (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`),
// each that is installed, since Claude Code uses Git Bash when it finds one and PowerShell
// otherwise.
//
//   bun scripts/hook-compat.ts <bin-dir> --expect silent [--version 0.1.3]
//   bun scripts/hook-compat.ts <bin-dir> --expect alert
//
// `<bin-dir>` holds the binary as `tokenhud` (`tokenhud.exe` on Windows). `silent`: every run
// exits 0 with nothing on stdout, as it must with a tokenhud that predates `hook` (CI runs
// the released 0.1.3). `alert`: with a fixture alert over its line, PostToolBatch and
// UserPromptSubmit print the hook reply naming it, SessionEnd prints nothing. Every run is
// on a temp HOME and config home, deleted afterwards; nothing of this machine's is read.
// Exits 1 on any problem. CI's `hook-compat` job runs it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HOOK_EVENTS, hookCommand } from "../src/alerts/install.ts";

const ROOT = join(import.meta.dir, "..");
const SESSION = "00000000-0000-4000-8000-000000000001";
const windows = process.platform === "win32";

export interface Shell {
  readonly name: string;
  /** The argv that runs a command line. */
  readonly argv: (command: string) => string[];
  readonly powershell: boolean;
}

/** The shells Claude Code may run a hook command in here. */
export function hookShells(): Shell[] {
  if (!windows) return [{ name: "sh", argv: (c) => ["/bin/sh", "-c", c], powershell: false }];
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const flags = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
  const candidates: Array<[string, string, boolean]> = [
    ["Git Bash", "C:\\Program Files\\Git\\bin\\bash.exe", false],
    ["PowerShell 7", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", true],
    ["Windows PowerShell", `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, true],
  ];
  return candidates
    .filter(([, exe]) => existsSync(exe))
    .map(([name, exe, powershell]) => ({
      name,
      argv: (c: string) => (powershell ? [exe, ...flags, c] : [exe, "-c", c]),
      powershell,
    }));
}

/** The plugin's command per event, as hooks.json has it. */
export function pluginCommands(): Map<string, string> {
  const file = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8"));
  const out = new Map<string, string>();
  for (const event of HOOK_EVENTS) out.set(event, file.hooks[event][0].hooks[0].command);
  return out;
}

function event(name: string, home: string): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: join(home, ".claude", "projects", "-compat", `${SESSION}.jsonl`),
    cwd: home,
    permission_mode: "default",
    hook_event_name: name,
    ...(name === "PostToolBatch" && { tool_calls: [], tool_results: [] }),
    ...(name === "UserPromptSubmit" && { prompt_text: "hello", is_continuation: false }),
    ...(name === "SessionEnd" && { reason: "other" }),
  });
}

/** A session alert whose 5-hour window is at 82 % of a line at 80 %. */
function writeFixture(config: string): void {
  const now = Date.now();
  const id = "compat-identity";
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, "limits.json"),
    JSON.stringify({
      providers: {
        [id]: {
          captured_at: now / 1000 - 30,
          source: "claude",
          via: "api",
          rate_limits: {
            session: { label: "5-HOUR", used_percentage: 82, resets_at: now / 1000 + 3600 },
          },
        },
      },
      status: {},
    }),
  );
  writeFileSync(
    join(config, "alerts.json"),
    JSON.stringify({
      alerts: [
        {
          id: "compat01",
          created_at: now,
          session: SESSION,
          account: { id, label: "compat", provider: "claude", group: null, members: [id] },
          window: "5h",
          at: 80,
          note: null,
          delivered: [],
        },
      ],
    }),
  );
}

/** PATH holding `dir` (null: no tokenhud at all) and the system's own directories. */
function pathWith(dir: string | null): string {
  const system = windows
    ? [
        `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
        process.env.SystemRoot ?? "C:\\Windows",
      ]
    : ["/usr/bin", "/bin"];
  return [...(dir === null ? [] : [dir]), ...system].join(delimiter);
}

export interface CheckOptions {
  binDir: string;
  expect: "silent" | "alert";
  shells?: Shell[];
}

/** Every problem found; empty when each run behaved. */
export function checkHookCommands(o: CheckOptions): string[] {
  const problems: string[] = [];
  // Absolute, as Claude Code's PATH and the installed command have it.
  const binDir = resolve(o.binDir);
  const binary = join(binDir, windows ? "tokenhud.exe" : "tokenhud");
  const installed = hookCommand([binary]);
  const shells = o.shells ?? hookShells();
  // Windows spells it `Path`: one PATH, ours, whatever the case.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"),
  );
  if (shells.length === 0) return ["no shell Claude Code runs hooks in was found"];
  for (const shell of shells) {
    const forms: Array<{ form: string; command: string; path: string | null }> = [];
    for (const [name, command] of pluginCommands()) {
      forms.push({ form: `plugin ${name}`, command, path: binDir });
    }
    // Written for PowerShell on Windows and sh elsewhere: only run where it is meant to.
    if ((installed.shell === "powershell") === shell.powershell) {
      forms.push({ form: "installed PostToolBatch", command: installed.command, path: null });
    }
    forms.push({
      form: "plugin, no tokenhud on PATH",
      command: pluginCommands().get("UserPromptSubmit") as string,
      path: null,
    });
    for (const { form, command, path } of forms) {
      const name = /SessionEnd/.test(form)
        ? "SessionEnd"
        : /UserPromptSubmit|no tokenhud/.test(form)
          ? "UserPromptSubmit"
          : "PostToolBatch";
      const base = mkdtempSync(join(tmpdir(), "tokenhud-hook-compat-"));
      try {
        const home = join(base, "home");
        const xdg = join(base, "xdg");
        mkdirSync(home, { recursive: true });
        const telling = o.expect === "alert" && !form.includes("no tokenhud");
        if (telling) writeFixture(join(xdg, "tokenhud"));
        const run = Bun.spawnSync(shell.argv(command), {
          env: {
            ...baseEnv,
            PATH: pathWith(path),
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: xdg,
            TOKENHUD_WSL_USERS: "",
          },
          stdin: Buffer.from(event(name, home)),
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = run.stdout.toString();
        const where = `${shell.name}, ${form}`;
        if (run.exitCode !== 0) problems.push(`${where}: exit ${run.exitCode}`);
        if (telling && name !== "SessionEnd") {
          let reply: {
            hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
          } = {};
          try {
            reply = JSON.parse(out);
          } catch {
            // reported below
          }
          const told = reply.hookSpecificOutput;
          if (
            told?.hookEventName !== name ||
            !told.additionalContext?.startsWith("[tokenhud alert] 5-hour limit (compat) is at 82%")
          ) {
            problems.push(`${where}: expected the alert's hook reply, got ${JSON.stringify(out)}`);
          }
        } else if (out.trim() !== "") {
          problems.push(`${where}: stdout must be empty, got ${JSON.stringify(out)}`);
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { expect: { type: "string" }, version: { type: "string" } },
  });
  const binDir = positionals[0];
  const expect = values.expect;
  if (binDir === undefined || (expect !== "silent" && expect !== "alert")) {
    console.error(
      "usage: bun scripts/hook-compat.ts <bin-dir> --expect silent|alert [--version V]",
    );
    process.exit(2);
  }
  const binary = join(binDir, windows ? "tokenhud.exe" : "tokenhud");
  if (values.version !== undefined) {
    const said = Bun.spawnSync([binary, "--version"], { env: process.env })
      .stdout.toString()
      .trim();
    if (said !== `tokenhud ${values.version}`) {
      console.error(`FAIL ${binary} says ${JSON.stringify(said)}, not tokenhud ${values.version}`);
      process.exit(1);
    }
  }
  const shells = hookShells();
  const problems = checkHookCommands({ binDir, expect, shells });
  for (const p of problems) console.error(`FAIL ${p}`);
  console.log(
    problems.length === 0
      ? `ok   ${binary}: hook commands ${expect} in ${shells.map((s) => s.name).join(", ")}`
      : `${problems.length} problem(s)`,
  );
  if (problems.length > 0) process.exit(1);
}

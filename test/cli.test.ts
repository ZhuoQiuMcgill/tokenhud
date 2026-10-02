import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

// Run the CLI the way users do: a fresh Bun process on the entry file, observed only
// through its exit code and output streams.
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function run(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Runs the CLI in a throwaway home, so nothing reads the user's store or config. */
function runHome(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "tokenhud-cli-test-"));
  try {
    const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        // Windows: the home is USERPROFILE, and Bun fills in the real one when it is
        // missing. The child then read the real ~\.claude, and wrote Bun's transpiler cache
        // under the real profile on the runner's slow C: disk, which once took the first
        // --once past 5 s (T15). Temp files go in the throwaway home too.
        USERPROFILE: home,
        TEMP: home,
        TMP: home,
        XDG_CONFIG_HOME: join(home, "config"),
        TOKENHUD_WSL_USERS: "",
      },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Every invocation in docs/ARCHITECTURE.md §3, written as there.
const ARCHITECTURE_COMMANDS = [
  "tokenhud",
  "tokenhud --once",
  "tokenhud json <query>",
  "tokenhud mcp",
  "tokenhud import-cc-usage",
  "tokenhud doctor",
  "tokenhud update",
];
const AVAILABLE = new Set([
  "tokenhud",
  "tokenhud --once",
  "tokenhud json <query>",
  "tokenhud mcp",
  "tokenhud import-cc-usage",
  "tokenhud doctor",
]);

describe("--version", () => {
  test("prints the package version and exits 0", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(run("--version")).toEqual({ code: 0, stdout: `tokenhud ${version}\n`, stderr: "" });
  });

  test("-v is an alias", () => {
    expect(run("-v")).toEqual(run("--version"));
  });
});

describe("--help", () => {
  const help = run("--help");
  const lines = help.stdout.trimEnd().split("\n");

  test("exits 0 with the help on stdout only", () => {
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(lines[0]).toBe(`tokenhud ${version}`);
  });

  test.each(ARCHITECTURE_COMMANDS)("lists '%s' with a summary, marked if not available", (cmd) => {
    // Two spaces end the invocation column, so "tokenhud" doesn't match "tokenhud mcp".
    const line = lines.find((l) => l.trimStart().startsWith(`${cmd}  `));
    expect(line).toBeDefined();
    const summary = line?.trimStart().slice(cmd.length).replace("(not yet available)", "").trim();
    expect(summary).not.toBe("");
    if (AVAILABLE.has(cmd)) expect(line).not.toContain("(not yet available)");
    else expect(line).toEndWith("(not yet available)");
  });

  test.each(["--width N", "-h, --help", "-v, --version"])(
    "lists the option '%s' with a summary",
    (option) => {
      const line = lines.find((l) => l.trimStart().startsWith(`${option}  `));
      expect(line).toBeDefined();
      expect(line?.trimStart().slice(option.length).trim()).not.toBe("");
    },
  );

  test("fits an 80-column terminal", () => {
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  test("-h is an alias", () => {
    expect(run("-h")).toEqual(help);
  });

  test("wins after a command that is not available yet", () => {
    expect(run("update", "--help")).toEqual(help);
  });

  test.each(["json", "mcp", "import-cc-usage", "doctor"])(
    "'%s --help' is that command's own help",
    (cmd) => {
      const own = run(cmd, "--help");
      expect(own.code).toBe(0);
      expect(own.stderr).toBe("");
      expect(own.stdout).toContain(`tokenhud ${cmd}`);
      expect(own.stdout).not.toEqual(help.stdout);
    },
  );
});

describe("commands that are not available yet", () => {
  test.each([
    [["update"], "update"],
    [["--once", "update"], "update"],
  ])("%j exits 2 naming '%s'", (args, name) => {
    expect(run(...args)).toEqual({
      code: 2,
      stdout: "",
      stderr: `tokenhud: '${name}' is not available yet\n`,
    });
  });
});

describe("the TUI and --once", () => {
  test("bare tokenhud without a terminal exits 2 and points at --once and json", () => {
    const out = runHome();
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("needs a terminal");
    expect(out.stderr).toContain("tokenhud --once");
  });

  test("--once prints the Overview as plain text when not on a TTY, then exits 0", () => {
    const out = runHome("--once", "--width", "80");
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines[0]).toStartWith(" tokenhud ");
    expect(out.stdout).toContain(" SPEND");
    expect(out.stdout).not.toContain("\x1b");
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  });

  test("--width=N is the same as --width N", () => {
    const stamp = (text: string) => text.replace(/as of \d\d:\d\d/, "as of --:--");
    expect(stamp(runHome("--once", "--width=100").stdout)).toEqual(
      stamp(runHome("--once", "--width", "100").stdout),
    );
  });
});

describe("usage errors", () => {
  test.each([
    [["--once", "--width", "39"], "--width takes a whole number from 40 to 1000"],
    [["--once", "--width", "wide"], "--width takes a whole number from 40 to 1000"],
    [["--once", "--width"], "--width takes a whole number from 40 to 1000"],
    [["--width", "100"], "--width applies to --once"],
    [["--bogus"], "unknown option '--bogus'"],
    [["-x"], "unknown option '-x'"],
    [["update", "--bogus"], "unknown option '--bogus'"],
    [["--bogus", "doctor"], "unknown option '--bogus'"],
    [["--bogus", "--help"], "unknown option '--bogus'"],
    [["frobnicate"], "unknown command 'frobnicate'"],
  ])("%j exits 2 and points at --help", (args, error) => {
    expect(run(...args)).toEqual({
      code: 2,
      stdout: "",
      stderr: `tokenhud: ${error}\nrun tokenhud --help for usage\n`,
    });
  });
});

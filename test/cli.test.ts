import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { version } from "../package.json";

// Run the CLI the way users do: a fresh Bun process on the entry file, observed only
// through its exit code and output streams.
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function run(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
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

  test.each(ARCHITECTURE_COMMANDS)("lists '%s' with a summary, marked not yet available", (cmd) => {
    // Two spaces end the invocation column, so "tokenhud" doesn't match "tokenhud mcp".
    const line = lines.find((l) => l.trimStart().startsWith(`${cmd}  `));
    expect(line).toBeDefined();
    const summary = line?.trimStart().slice(cmd.length).replace("(not yet available)", "").trim();
    expect(summary).not.toBe("");
    expect(line).toEndWith("(not yet available)");
  });

  test("documents --help and --version", () => {
    expect(help.stdout).toContain("--help");
    expect(help.stdout).toContain("--version");
  });

  test("fits an 80-column terminal", () => {
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  test("-h is an alias", () => {
    expect(run("-h")).toEqual(help);
  });

  test("wins after a command", () => {
    expect(run("doctor", "--help")).toEqual(help);
  });
});

describe("commands that are not available yet", () => {
  test.each([
    [[], "tokenhud"],
    [["--once"], "--once"],
    [["json", "today"], "json"],
    [["mcp"], "mcp"],
    [["import-cc-usage"], "import-cc-usage"],
    [["doctor"], "doctor"],
    [["update"], "update"],
  ])("%j exits 2 naming '%s'", (args, name) => {
    expect(run(...args)).toEqual({
      code: 2,
      stdout: "",
      stderr: `tokenhud: '${name}' is not available yet\n`,
    });
  });
});

describe("usage errors", () => {
  test.each([
    [["--bogus"], "unknown option '--bogus'"],
    [["-x"], "unknown option '-x'"],
    [["doctor", "--bogus"], "unknown option '--bogus'"],
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

// The TUI log (critique M1): one clean line on screen, details in a capped file that holds
// no content and no path below an account root.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorLine, fileLog, logPath, MAX_LOG_BYTES, scrub } from "../../src/tui/log.ts";
import { guard } from "../guard.ts";

guard();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "tokenhud-log-"));
  dirs.push(d);
  return d;
};

test("the log lives in the config dir's logs/", () => {
  expect(logPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/example")).toBe(
    join("/x/cfg", "tokenhud", "logs", "tokenhud.log"),
  );
});

test("scrub keeps account roots, cuts what is below them, and shortens home to ~", () => {
  const home = "/home/example";
  expect(
    scrub(
      "ENOENT: open '/home/example/.claude/projects/-secret-proj/abc.jsonl'\n    at read (/opt/app/src/sources/claude.ts:12:3)",
      home,
    ),
  ).toBe("ENOENT: open '~/.claude/projects/…' | at read (claude.ts:12:3)");
  expect(
    scrub("C:\\Users\\Example\\.codex\\sessions\\2026\\09\\x.jsonl gone", "C:\\Users\\Example"),
  ).toBe("~\\.codex\\sessions/… gone");
});

test("errorLine picks the message out of Bun's source excerpt", () => {
  const bun = [
    "25 |   }",
    "26 | };",
    "27 | ",
    "28 | throw new Error('database disk image is malformed');",
    "           ^",
    "error: database disk image is malformed",
    "      at /opt/app/src/tui/vm/worker.ts:28:7",
  ].join("\n");
  expect(errorLine(bun)).toBe("database disk image is malformed");
  expect(errorLine("TypeError: x is not a function")).toBe("x is not a function");
  expect(errorLine("")).toBe("unexpected error");
  expect(errorLine(`Error: ${"x".repeat(200)}`)).toHaveLength(120);
});

test("the file log appends scrubbed lines and rotates past its cap", () => {
  const dir = tempDir();
  const path = join(dir, "logs", "tokenhud.log");
  const log = fileLog(path, "/home/example");
  log.write("error", "boom in /home/example/.claude/projects/p/s.jsonl");
  const line = readFileSync(path, "utf8");
  expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z error boom in ~\/\.claude\/projects\/…\n$/);
  writeFileSync(path, "x".repeat(MAX_LOG_BYTES + 1));
  log.write("warn", "after");
  expect(statSync(`${path}.1`).size).toBe(MAX_LOG_BYTES + 1);
  expect(readFileSync(path, "utf8")).toContain(" warn after");
});

test("an unwritable log is skipped silently", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "logs"), "a file where the directory should be");
  expect(() => fileLog(join(dir, "logs", "tokenhud.log")).write("error", "x")).not.toThrow();
});

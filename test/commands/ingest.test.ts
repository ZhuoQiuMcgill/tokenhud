import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeLine, cleanup, makeRoot, tempDir } from "../ingest/helpers.ts";

afterEach(cleanup);

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

/** Runs the CLI with HOME and XDG_CONFIG_HOME inside `dir`, and no Windows-side search. */
function run(dir: string, ...args: string[]) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(dir, "home"),
    USERPROFILE: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg"),
    TOKENHUD_WSL_USERS: "",
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("tokenhud ingest", () => {
  test("is not listed in --help", () => {
    expect(run(tempDir(), "--help").stdout).not.toContain("ingest");
  });

  test("--help prints its own usage", () => {
    const out = run(tempDir(), "ingest", "--help");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("usage: tokenhud ingest");
  });

  test("an unknown option is a usage error", () => {
    const out = run(tempDir(), "ingest", "--bogus");
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("usage: tokenhud ingest");
  });

  test("--once --stats ingests, prints per-account stats, and writes only where told", () => {
    const dir = tempDir();
    const home = join(dir, "home");
    const root = makeRoot(home, ".claude");
    mkdirSync(join(root, "projects", "p"));
    writeFileSync(
      join(root, "projects", "p", "s.jsonl"),
      claudeLine("1", "1", 10) + claudeLine("2", "2", 20),
    );
    const db = join(dir, "out", "t.db");
    const cache = join(dir, "out", "c.db");
    const first = run(dir, "ingest", "--once", "--stats", "--db", db, "--cache", cache);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    const lines = first.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^account\s+files\s+read\s+MB\s+lines\s+candidates\s+records\s+new\s+changed\s+read ms$/,
    );
    expect(lines[1]).toMatch(/^personal \(claude\)\s+1\s+1\s+0\.0\s+2\s+2\s+2\s+2\s+0\s+\d+$/);
    expect(lines.at(-1)).toMatch(/^wall \d+ ms$/);
    expect(first.stdout).not.toContain(home);
    expect(existsSync(db) && existsSync(cache)).toBe(true);
    expect(existsSync(join(dir, "xdg", "tokenhud"))).toBe(false);

    const second = run(dir, "ingest", "--once", "--db", db, "--cache", cache);
    expect(second.stdout).toMatch(
      /^read 0 of 1 files \(0\.0 MB\), 0 records: 0 new, 0 changed, in \d+ ms\n$/,
    );
  });

  test("the first run creates tokenhud's config from cc-usage's, once; --config moves it", () => {
    const dir = tempDir();
    const home = join(dir, "home");
    makeRoot(home, ".claude");
    const work = makeRoot(dir, "work-root");
    writeFileSync(join(work, "projects", "s.jsonl"), claudeLine("1", "1", 10));
    mkdirSync(join(dir, "xdg", "cc-usage"), { recursive: true });
    const theirs = join(dir, "xdg", "cc-usage", "config.json");
    writeFileSync(
      theirs,
      JSON.stringify({ theme: "light", claude_roots: [{ path: work, label: "job" }] }),
    );
    const own = join(dir, "custom", "config.json");
    const args = ["ingest", "--once", "--stats", "--no-import", "--config", own];
    const first = run(dir, ...args, "--db", join(dir, "t.db"), "--cache", join(dir, "c.db"));
    expect(first.stderr).toBe("info: created tokenhud's config from cc-usage's\n");
    expect(first.stdout).toMatch(/^job \(claude\)\s+1\s+1/m);
    expect(JSON.parse(readFileSync(own, "utf8")).claude_roots).toEqual([
      { path: work, label: "job" },
    ]);
    expect(existsSync(join(dir, "xdg", "tokenhud"))).toBe(false);

    writeFileSync(theirs, JSON.stringify({ theme: "dark", claude_roots: [] }));
    const second = run(dir, ...args, "--db", join(dir, "t2.db"), "--cache", join(dir, "c2.db"));
    expect(second.stderr).toBe("");
    expect(second.stdout).toMatch(/^job \(claude\)\s+1\s+1/m);
    expect(JSON.parse(readFileSync(own, "utf8")).theme).toBe("light");
  });
});

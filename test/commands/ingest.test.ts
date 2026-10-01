import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeLine, cleanup, makeRoot, tempDir } from "../ingest/helpers.ts";

afterEach(cleanup);

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

/** HOME and XDG_CONFIG_HOME inside `dir`, and no Windows-side search. */
function envFor(dir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(dir, "home"),
    USERPROFILE: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg"),
    TOKENHUD_WSL_USERS: "",
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

/** Runs the CLI in `envFor(dir)`. */
function run(dir: string, ...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: envFor(dir),
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

  // Network-free: the only Claude root has no credential file, and there is no ~/.codex.
  (process.platform === "win32" ? test.skip : test)(
    "--limits fetches limits after the first pass and prints them content-free",
    async () => {
      const dir = tempDir();
      makeRoot(join(dir, "home"), ".claude");
      const out = join(dir, "out");
      const proc = Bun.spawn(
        [
          process.execPath,
          CLI,
          "ingest",
          "--no-import",
          "--db",
          join(out, "t.db"),
          "--cache",
          join(out, "c.db"),
          "--limits",
          join(out, "limits.json"),
        ],
        { stdout: "pipe", stderr: "pipe", env: envFor(dir) },
      );
      let stdout = "";
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      const deadline = performance.now() + 10_000;
      while (!stdout.includes("limits personal") && performance.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value);
      }
      reader.releaseLock();
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(0);
      expect(stdout).toContain(
        "limits personal (claude): no windows [none] · not signed in here · no Claude credentials in this config dir\n",
      );
      expect(stdout).not.toContain(dir);
      expect(existsSync(join(out, "limits.json"))).toBe(true);
    },
  );

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

  test("--stats reports Codex replay skips and tiers under the account's label", () => {
    const dir = tempDir();
    const sessions = join(dir, "home", ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const token = (ts: string, total: number[], last: number[]) =>
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: total[0],
              cached_input_tokens: 0,
              output_tokens: total[1],
            },
            last_token_usage: {
              input_tokens: last[0],
              cached_input_tokens: 0,
              output_tokens: last[1],
            },
          },
        },
      });
    const child = [
      JSON.stringify({
        timestamp: "2026-07-10T08:00:00Z",
        type: "session_meta",
        payload: {
          id: "00000000-0000-4000-8000-000000000002",
          forked_from_id: "00000000-0000-4000-8000-000000000099",
        },
      }),
      token("2026-07-10T08:00:00.100Z", [100, 10], [100, 10]),
      token("2026-07-10T08:00:00.200Z", [300, 20], [200, 10]),
      token("2026-07-10T08:01:00Z", [350, 25], [50, 5]),
    ];
    writeFileSync(
      join(sessions, "rollout-2026-07-10T08-00-00-00000000-0000-4000-8000-000000000002.jsonl"),
      `${child.join("\n")}\n`,
    );
    const out = run(
      dir,
      "ingest",
      "--once",
      "--stats",
      "--no-import",
      "--db",
      join(dir, "t.db"),
      "--cache",
      join(dir, "c.db"),
    );
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^codex \(codex\)\s+1\s+1/m);
    expect(out.stdout).toContain(
      "codex: 2 inherited (replayed) events skipped, 0 stored rows removed, 0 rows of removed keys not written; 0 fast-tier records",
    );
  });
});

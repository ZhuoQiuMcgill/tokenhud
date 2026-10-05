// `tokenhud selftest workers` (T31): every Worker started and answering, from source here;
// the release smoke tests run it in each compiled binary (scripts/build.ts --smoke).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSelftest } from "../../src/commands/selftest.ts";
import { childEnv, guard } from "../guard.ts";
import { cleanup, tempDir } from "../ingest/helpers.ts";

guard();

afterEach(cleanup);

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

/**
 * The CLI with HOME, USERPROFILE, XDG_CONFIG_HOME and the OS temp dir (TMPDIR, TEMP, TMP)
 * in `dir`, and no Windows side.
 */
function run(dir: string, ...args: string[]) {
  const tmp = join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(dir, "home"),
    USERPROFILE: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg"),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    TOKENHUD_WSL_USERS: "",
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(env),
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("tokenhud selftest", () => {
  test("is not listed in --help", () => {
    expect(run(tempDir(), "--help").stdout).not.toContain("selftest");
  });

  test("--help prints its usage; anything but `workers` is a usage error", () => {
    const help = run(tempDir(), "selftest", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toBe("usage: tokenhud selftest workers\n");
    for (const args of [[], ["bogus"], ["workers", "extra"]]) {
      const out = run(tempDir(), "selftest", ...args);
      expect(out.code).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toBe("usage: tokenhud selftest workers\n");
    }
  });

  test("workers: each Worker answers, and the temp machine is gone afterwards", () => {
    const dir = tempDir();
    const out = run(dir, "selftest", "workers");
    expect(out.stderr).toBe("");
    expect(out.stdout).toBe(
      [
        "ok   ingest Worker: 2 rows stored",
        "ok   parse Worker: 2 read a transcript each",
        "ok   view-model Worker: views of 1 account(s)",
        "",
      ].join("\n"),
    );
    expect(out.code).toBe(0);
    // Its temp dir is gone, and it wrote nothing to the config home (Bun, from source, keeps
    // a transpiler cache under HOME).
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
    expect(existsSync(join(dir, "xdg"))).toBe(false);
  }, 60_000);

  test("a Worker that can't start is named, with Bun's reason, and fails the run", async () => {
    // What 0.1.4's Windows binaries did: a Worker entry that isn't there.
    const missing = new URL("./no-such-worker.ts", import.meta.url).href;
    const lines: string[] = [];
    const code = await runSelftest(["workers"], {
      ingestUrl: missing,
      vmUrl: missing,
      write: (text) => lines.push(text),
    });
    expect(code).toBe(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("FAIL ingest Worker: ");
    expect(lines[1]).toStartWith("FAIL view-model Worker: ");
    for (const line of lines) {
      expect(line).toContain("no-such-worker.ts");
      expect(line.trimEnd()).not.toContain("\n");
    }
  }, 60_000);
});

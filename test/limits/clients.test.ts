// No test can run the real `claude` or `codex` (T15). The preload puts stub clients first
// on PATH, and the product refuses any client outside the test temp root while
// TOKENHUD_TEST is set. Every attempt is recorded and fails the test that made it, so each
// test here takes its own record (`takeSpawned`) before the preload's check sees it.
import { afterEach, describe, expect, test } from "bun:test";
import { basename, dirname, join, resolve } from "node:path";
import { fetchClaudeLimits } from "../../src/limits/claude.ts";
import { findOnPath, refuseRealClient } from "../../src/limits/clients.ts";
import { codexExecutable, runCodexRpc } from "../../src/limits/codex.ts";
import { pathNames, takeSpawned } from "../stubs.ts";
import { cleanup, FAKE_TOKEN, tempDir, writeCredentials } from "./helpers.ts";

afterEach(cleanup);

const stubs = process.env.TOKENHUD_TEST_STUBS as string;
/** The dir holding `path`, comparable with `stubs` (Windows paths ignore case). */
const dirOf = (path: string | null) => {
  const dir = resolve(dirname(path ?? ""));
  return process.platform === "win32" ? dir.toLowerCase() : dir;
};
const stubDir = dirOf(join(stubs, "x"));
const noHttp = async (): Promise<Response> => {
  throw new Error("no HTTP in this test");
};

describe("the stub clients", () => {
  test("come first on the PATH the product searches", () => {
    expect(dirOf(findOnPath("claude"))).toBe(stubDir);
    expect(dirOf(codexExecutable())).toBe(stubDir);
    // Spelled PATH, so a copy of the env handed to a Worker still has the stubs on it.
    expect(pathNames()).toEqual(["PATH"]);
  });

  test("and in a Worker too, with the guard on (the ingest Worker fetches limits)", async () => {
    const worker = new Worker(new URL("./guard-worker.ts", import.meta.url).href);
    try {
      const seen = await new Promise<{ test: string | null; stubs: string | null; claude: string }>(
        (resolve) => {
          worker.onmessage = (event) => resolve(event.data);
        },
      );
      expect(seen.test).toBe("1");
      expect(seen.stubs).toBe(stubs);
      expect(dirOf(seen.claude)).toBe(stubDir);
    } finally {
      worker.terminate();
    }
  });

  test("spawning claude from a test hits the stub, which fails loudly", () => {
    for (const name of ["claude", "codex"]) {
      const run = Bun.spawnSync([findOnPath(name) as string, "--print"], {
        env: process.env,
        stderr: "pipe",
      });
      expect(run.exitCode).toBe(97);
      expect(run.stderr.toString()).toContain(`real ${name} spawned from a test`);
      expect(takeSpawned()).toEqual([name]);
    }
  });

  test("a token refresh with no client stubbed reaches only the stub", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1); // expired: the fetcher runs the client to refresh
    const error = await fetchClaudeLimits({ path: dir, source: "config" }, { fetch: noHttp }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(takeSpawned()).toEqual(["claude"]);
  });

  test("an app-server read with no executable given reaches only the stub", async () => {
    const error = await runCodexRpc({ codexHome: tempDir() }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(takeSpawned()).toEqual(["codex"]);
  });
});

describe("the guard", () => {
  // Bun itself: a real executable, outside the test temp root.
  const real = process.execPath;
  const refused = `${basename(real)} (refused)`;

  test("refuses a client outside the test temp root before it runs", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const claude = await fetchClaudeLimits(
      { path: dir, source: "config" },
      { which: () => real, fetch: noHttp },
    ).catch((e) => e);
    // The fetcher's errors carry no detail; the record says it was refused, not run.
    expect(claude).toBeInstanceOf(Error);
    expect(takeSpawned()).toEqual([refused]);

    const codex = await runCodexRpc({ codexHome: tempDir(), executable: real }).catch((e) => e);
    expect(codex).toBeInstanceOf(Error);
    expect(takeSpawned()).toEqual([refused]);
  });

  test("lets a test's own stub, under the temp root, run", () => {
    expect(() => refuseRealClient(join(tempDir(), "codex"))).not.toThrow();
    expect(takeSpawned()).toEqual([]);
  });

  test("does nothing outside tests, and refuses everything with no stub dir", () => {
    expect(() => refuseRealClient(real, {})).not.toThrow();
    expect(() => refuseRealClient(real, { TOKENHUD_TEST: "1" })).toThrow(/not a test stub/);
    expect(takeSpawned()).toEqual([]);
  });
});

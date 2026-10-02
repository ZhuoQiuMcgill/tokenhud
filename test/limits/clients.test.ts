// No test can run the real `claude` or `codex` (T15). The test guard (test/guard.ts) puts
// stub clients first on PATH and gives every Worker and child its env, and the product
// refuses any client outside the test temp root while TOKENHUD_TEST is set, or in
// `bun test`'s own thread without the guard. Every attempt is recorded and fails the test
// that made it, so each test here takes its own record (`takeSpawned`) before the guard's
// check sees it.
import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fetchClaudeLimits } from "../../src/limits/claude.ts";
import { findOnPath, RefusedClient, refuseRealClient } from "../../src/limits/clients.ts";
import { codexExecutable, runCodexRpc } from "../../src/limits/codex.ts";
import { guard, pathNames, takeSpawned } from "../guard.ts";
import { cleanup, FAKE_TOKEN, tempDir, writeCredentials } from "./helpers.ts";

guard();

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
const SRC = join(import.meta.dir, "..", "..", "src", "limits");

interface Seen {
  test: string | null;
  stubs: string | null;
  claude: string | null;
}

/** What a Bun child sees of the guard, started with `options` (no env, unless given). */
function childSees(options: { env?: Record<string, string> } = {}): Seen {
  const script = `
const { findOnPath } = await import(${JSON.stringify(join(SRC, "clients.ts"))});
console.log(JSON.stringify({ test: process.env.TOKENHUD_TEST ?? null, stubs: process.env.TOKENHUD_TEST_STUBS ?? null, claude: findOnPath("claude") }));
`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { ...options, stdout: "pipe" });
  return JSON.parse(run.stdout.toString());
}

/** What a Worker sees of the guard, started with `options`. */
async function workerSees(options?: WorkerOptions): Promise<Seen> {
  const worker = new Worker(new URL("./guard-worker.ts", import.meta.url).href, options);
  try {
    return await new Promise<Seen>((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
    });
  } finally {
    worker.terminate();
  }
}

describe("the stub clients", () => {
  test("come first on the PATH the product searches", () => {
    expect(dirOf(findOnPath("claude"))).toBe(stubDir);
    expect(dirOf(codexExecutable())).toBe(stubDir);
    // Spelled PATH, so a copy of the env handed to a Worker still has the stubs on it.
    expect(pathNames()).toEqual(["PATH"]);
  });

  test("spawning claude from a test hits the stub, which fails loudly", () => {
    for (const name of ["claude", "codex"]) {
      const run = Bun.spawnSync([findOnPath(name) as string, "--print"], { stderr: "pipe" });
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

describe("Workers and children get the guard", () => {
  // Bun starts both with the environment the process started with unless given an env;
  // the guard gives them its own, merged into any env a test passes (critique M2, m1, n2).
  test("a Worker, with no env or its own", async () => {
    for (const options of [undefined, { env: { HOME: tempDir() } }]) {
      const seen = await workerSees(options);
      expect(seen).toMatchObject({ test: "1", stubs });
      expect(dirOf(seen.claude)).toBe(stubDir);
    }
  });

  test("a child, with no env or a hand-built one", () => {
    for (const options of [{}, { env: { HOME: tempDir() } }]) {
      const seen = childSees(options);
      expect(seen).toMatchObject({ test: "1", stubs });
      expect(dirOf(seen.claude)).toBe(stubDir);
    }
  });

  test("product code in a child started with no env reaches only the stub", () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const script = `
const { fetchClaudeLimits } = await import(${JSON.stringify(join(SRC, "claude.ts"))});
await fetchClaudeLimits({ path: ${JSON.stringify(dir)}, source: "config" }, {
  fetch: async () => { throw new Error("no HTTP in this test"); },
}).catch(() => {});
`;
    Bun.spawnSync([process.execPath, "-e", script]);
    expect(takeSpawned()).toEqual(["claude"]);
  });
});

describe("the guard", () => {
  // Bun itself: a real executable, outside the test temp root.
  const real = process.execPath;
  const refused = `${basename(real)} (refused)`;

  test("refuses a client outside the test temp root before it runs, and says so", async () => {
    const dir = tempDir();
    writeCredentials(dir, FAKE_TOKEN, 1);
    const claude = await fetchClaudeLimits(
      { path: dir, source: "config" },
      { which: () => real, fetch: noHttp },
    ).catch((e) => e);
    expect(String(claude)).toContain(`refused to run ${basename(real)} from a test`);
    expect(takeSpawned()).toEqual([refused]);

    const codex = await runCodexRpc({ codexHome: tempDir(), executable: real }).catch((e) => e);
    expect(codex).toBeInstanceOf(RefusedClient);
    expect(takeSpawned()).toEqual([refused]);
  });

  test("lets a test's own stub, under the temp root, run", () => {
    expect(() => refuseRealClient(join(tempDir(), "codex"))).not.toThrow();
    expect(takeSpawned()).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "refuses a link under the temp root to a binary outside it",
    () => {
      const link = join(tempDir(), "claude");
      symlinkSync(real, link);
      expect(() => refuseRealClient(link)).toThrow(RefusedClient);
      expect(takeSpawned()).toEqual(["claude (refused)"]);
    },
  );

  test("with no guard, refuses every client in bun test's own thread, and nowhere else", () => {
    const testFile = join(tempDir(), "x.test.ts");
    const inBunTest = { NODE_ENV: "test" };
    expect(() => refuseRealClient(real, inBunTest, testFile)).toThrow(/guard is not installed/);
    expect(() => refuseRealClient(join(tempDir(), "claude"), inBunTest, testFile)).toThrow(
      RefusedClient,
    );
    // A user's process: no test file running, whatever NODE_ENV says.
    expect(() => refuseRealClient(real, {}, "/opt/tokenhud/cli.ts")).not.toThrow();
    expect(() => refuseRealClient(real, inBunTest, "/opt/tokenhud/cli.ts")).not.toThrow();
    expect(() => refuseRealClient(real, {}, testFile)).not.toThrow();
    // TOKENHUD_TEST without a stub dir refuses everything too.
    expect(() => refuseRealClient(real, { TOKENHUD_TEST: "1" }, "cli.ts")).toThrow(RefusedClient);
    expect(takeSpawned()).toEqual([]);
  });
});

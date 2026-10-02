// The npm launcher (npm/tokenhud/bin/tokenhud.cjs) in a node_modules tree like the one npm
// installs, with a shell script standing in for the platform package's binary. It runs
// under Node (`npx`, `npm install -g`) and under Bun (`bunx` on a machine without Node), so
// every case runs on each runtime there is: Bun always, Node when the `node` on PATH really
// is Node (`bun run` puts its own `node` alias there).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmPackage, RELEASE_TARGETS } from "../../src/release.ts";
import { guard } from "../guard.ts";

guard();

const SHIM = join(import.meta.dir, "..", "..", "npm", "tokenhud", "bin", "tokenhud.cjs");

function realNode(): string | null {
  const node = Bun.which("node");
  if (node === null) return null;
  const run = Bun.spawnSync([node, "-p", "typeof Bun"], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "ignore",
  });
  return run.stdout.toString().trim() === "undefined" ? node : null;
}

const NODE = realNode();
const RUNTIMES: ReadonlyArray<readonly [name: string, path: string]> = [
  ["bun", process.execPath],
  ...(NODE === null ? [] : [["node", NODE] as const]),
];

test("the launcher starts with Bun's line: bun links it as published, with no Node", () => {
  expect(readFileSync(SHIM, "utf8").split("\n")[0]).toBe("#!/usr/bin/env bun");
});

test("the launcher knows exactly the platforms releases are built for", () => {
  const list = /const SUPPORTED = \[([^\]]*)\]/.exec(readFileSync(SHIM, "utf8"))?.[1] ?? "";
  const ids = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toEqual(RELEASE_TARGETS.map((t) => npmPackage(t).slice("@tokenhud/".length)));
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32").each(RUNTIMES)(
  "the npm launcher on %s",
  (_, runtime) => {
    let dir: string;
    let pids: string;
    let id: string;
    /** The pids every stand-in binary wrote when it started. */
    const started = () => readdirSync(pids).map(Number);

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tokenhud-npm-test-"));
      pids = join(dir, "pids");
      mkdirSync(pids);
      mkdirSync(join(dir, "node_modules", "tokenhud", "bin"), { recursive: true });
      copyFileSync(SHIM, join(dir, "node_modules", "tokenhud", "bin", "tokenhud.cjs"));
      // The machine's own platform package, glibc flavour (CI and dev machines are glibc).
      id = `${process.platform}-${process.arch}`;
    });
    afterEach(() => {
      // A failed case must not leave a stand-in binary looping.
      for (const pid of started()) if (alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    });

    function platformPackage(script: string): void {
      const pkg = join(dir, "node_modules", "@tokenhud", id);
      mkdirSync(join(pkg, "bin"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@tokenhud/${id}` }));
      writeFileSync(join(pkg, "bin", "tokenhud"), `#!/bin/sh\n: > "${pids}/$$"\n${script}\n`);
      chmodSync(join(pkg, "bin", "tokenhud"), 0o755);
    }

    function launch(...args: string[]) {
      const shim = join(dir, "node_modules", "tokenhud", "bin", "tokenhud.cjs");
      return Bun.spawn([runtime, shim, ...args], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    async function result(proc: ReturnType<typeof launch>) {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, signal: proc.signalCode, stdout, stderr };
    }

    /** Waits up to 2 s for every stand-in binary to be gone; returns those still running. */
    async function strays(): Promise<number[]> {
      for (let i = 0; i < 40 && started().some(alive); i++) await Bun.sleep(50);
      return started().filter(alive);
    }

    test("runs the platform binary with the arguments, output and exit code", async () => {
      platformPackage('printf "%s|" "$@"; echo; echo oops >&2; exit 7');
      expect(await result(launch("json", "usage", "--tz", "Europe/Paris", "a b"))).toEqual({
        code: 7,
        signal: null,
        stdout: "json|usage|--tz|Europe/Paris|a b|\n",
        stderr: "oops\n",
      });
    });

    test("without the platform package: exit 1 and how to fix it", async () => {
      const out = await result(launch("--version"));
      expect(out.code).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain(`@tokenhud/${id}`);
      expect(out.stderr).toContain("--omit=optional");
      expect(out.stderr).toContain("bun add -g tokenhud          (a global install with bun)");
      expect(out.stderr).toContain("npm install -g tokenhud      (a global install with npm)");
      expect(out.stderr).toContain("npm install tokenhud         (in a project)");
    });

    // Bun ignores `libc` and installs a glibc package on Alpine too (and the other way
    // round, by hand): a binary for the other libc can't start, so it is never run.
    test.skipIf(process.platform !== "linux")(
      "a package for the other libc is not run: the missing one is named",
      async () => {
        const mine = id;
        id = `${mine}-musl`;
        platformPackage("echo ran");
        id = mine;
        const out = await result(launch("--version"));
        expect([out.code, out.stdout]).toEqual([1, ""]);
        expect(out.stderr).toContain(`@tokenhud/${mine},`);
      },
    );

    test("a binary killed by a signal: the launcher dies of the same signal", async () => {
      platformPackage("kill -TERM $$");
      const out = await result(launch());
      expect(out.signal).toBe("SIGTERM");
    });

    test("passes SIGTERM on to the binary and exits as the binary does", async () => {
      platformPackage(
        'trap "echo got-term; exit 0" TERM; echo ready; while :; do sleep 0.05; done',
      );
      const proc = launch();
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toBe("ready\n");
      proc.kill("SIGTERM");
      const rest = new TextDecoder().decode((await reader.read()).value);
      expect(rest).toBe("got-term\n");
      expect(await proc.exited).toBe(0);
      expect(await strays()).toEqual([]);
    });

    // T14 re-review M1: the launcher registered its forwarding only after starting the
    // binary. A runtime may hand a handler to the OS a moment later (Bun did), so a SIGTERM in
    // that moment killed the launcher and left the binary running. On an idle machine that
    // moment is microseconds; 40 launchers at once make it real: before the fix, 5 to 7 of 40
    // Bun launchers died and orphaned their binary in every round.
    test("40 launchers at once, each signalled the moment its binary starts: none dies, none is left", async () => {
      platformPackage('trap "exit 0" TERM; kill -TERM $PPID; while :; do sleep 0.05; done');
      const codes = await Promise.all(Array.from({ length: 40 }, () => launch().exited));
      const failures = codes.flatMap((code, i) =>
        code === 0 ? [] : [`launcher ${i}: exit ${code}`],
      );
      expect([failures, started().length, await strays()]).toEqual([[], 40, []]);
    }, 60_000);

    test("40 launchers signalled as soon as they start: never a binary left behind", async () => {
      platformPackage('trap "exit 0" TERM; while :; do sleep 0.05; done');
      const procs = Array.from({ length: 40 }, () => launch());
      for (const proc of procs) proc.kill("SIGTERM");
      await Promise.all(procs.map((p) => p.exited));
      expect(await strays()).toEqual([]);
    }, 60_000);

    test("a launcher that crashes takes the binary with it", async () => {
      platformPackage("echo ready; while :; do sleep 0.05; done");
      const crash = join(dir, "crash.cjs");
      writeFileSync(crash, 'setTimeout(() => { throw new Error("launcher crash") }, 300);\n');
      const shim = join(dir, "node_modules", "tokenhud", "bin", "tokenhud.cjs");
      const preload = runtime === process.execPath ? "--preload" : "--require";
      const proc = Bun.spawn([runtime, preload, crash, shim], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await result(proc);
      expect(out.stdout).toBe("ready\n");
      expect(out.stderr).toContain("launcher crash");
      expect(out.code).not.toBe(0);
      expect([started().length, await strays()]).toEqual([1, []]);
    });
  },
);

// The package's preinstall (npm/tokenhud/preinstall.cjs): npm, which runs it under Node
// before linking the command, gets a launcher that starts with Node's line; under Bun it
// changes nothing.
describe("the preinstall", () => {
  const PREINSTALL = join(import.meta.dir, "..", "..", "npm", "tokenhud", "preinstall.cjs");
  let pkg: string;
  let launcher: string;
  const published = readFileSync(SHIM, "utf8");

  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), "tokenhud-preinstall-test-"));
    mkdirSync(join(pkg, "bin"));
    launcher = join(pkg, "bin", "tokenhud.cjs");
    copyFileSync(SHIM, launcher);
    chmodSync(launcher, 0o755);
    copyFileSync(PREINSTALL, join(pkg, "preinstall.cjs"));
  });
  afterEach(() => {
    chmodSync(join(pkg, "bin"), 0o755);
    rmSync(pkg, { recursive: true, force: true });
  });

  const preinstall = (runtime: string) =>
    Bun.spawnSync([runtime, join(pkg, "preinstall.cjs")], {
      cwd: pkg,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });

  test.skipIf(NODE === null)(
    "under Node: Node's line, the rest as published, still executable",
    () => {
      const run = preinstall(NODE as string);
      expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
      const text = readFileSync(launcher, "utf8");
      expect(text).toBe(published.replace("#!/usr/bin/env bun\n", "#!/usr/bin/env node\n"));
      if (process.platform !== "win32") expect(statSync(launcher).mode & 0o777).toBe(0o755);
      expect(readdirSync(join(pkg, "bin"))).toEqual(["tokenhud.cjs"]);
      // Again (a reinstall over it): unchanged.
      expect(preinstall(NODE as string).exitCode).toBe(0);
      expect(readFileSync(launcher, "utf8")).toBe(text);
    },
  );

  test("under Bun (a trusted install): unchanged", () => {
    const run = preinstall(process.execPath);
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    expect(readFileSync(launcher, "utf8")).toBe(published);
  });

  test.skipIf(NODE === null || process.platform === "win32" || process.getuid?.() === 0)(
    "a launcher it can't rewrite: the install goes on, and it says the command needs Bun",
    () => {
      chmodSync(join(pkg, "bin"), 0o555);
      const run = preinstall(NODE as string);
      expect(run.exitCode).toBe(0);
      expect(run.stderr.toString()).toContain("the tokenhud command will need Bun");
      expect(readFileSync(launcher, "utf8")).toBe(published);
    },
  );
});

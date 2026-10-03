// The Node launcher (npm/tokenhud/lib/tokenhud.cjs), the command npm installs on Windows,
// in a node_modules tree like the one npm installs, with a shell script standing in for the
// platform package's binary. Its logic knows every platform, so every case runs here, on each
// runtime there is: Bun always, Node when the `node` on PATH really is Node (`bun run` puts
// its own `node` alias there). The Linux and macOS command, bin/tokenhud, is a sh script:
// test/release/launcher.test.ts.
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

const PKG = join(import.meta.dir, "..", "..", "npm", "tokenhud");
const SHIM = join(PKG, "lib", "tokenhud.cjs");

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

test("the command is a sh script; the Windows launcher is Node's, never Bun's", () => {
  expect(readFileSync(join(PKG, "bin", "tokenhud"), "utf8").split("\n")[0]).toBe("#!/bin/sh");
  expect(readFileSync(SHIM, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
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
      // Both causes: optional dependencies left out, and a download that failed. Only npm's
      // commands: this launcher runs only where npm installed it (Bun isn't supported on
      // Windows).
      expect(out.stderr).toBe(
        [
          `tokenhud: the package with the tokenhud binary for this machine, @tokenhud/${id},`,
          "is not installed. It comes as an optional dependency, so it is missing when",
          "optional dependencies were skipped (--omit=optional, --no-optional, or a lockfile",
          "made on another platform). Reinstall tokenhud the same way, without --omit=optional:",
          "  npm install -g tokenhud      (a global install)",
          "  npm install tokenhud         (in a project)",
          "It is also missing when its download failed, which npm passes over without an",
          "error. If tokenhud was just released, wait a few minutes and reinstall:",
          "  npm install -g --prefer-online tokenhud",
          "or install the binary directly: https://github.com/ZhuoQiuMcgill/tokenhud#install",
          "",
        ].join("\n"),
      );
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

// The package's preinstall (npm/tokenhud/preinstall.cjs): on Windows under Node (npm), it
// puts the Node launcher in place of the sh command before npm links it; everywhere else, and
// under Bun, it changes nothing.
describe("the preinstall", () => {
  const PREINSTALL = join(PKG, "preinstall.cjs");
  const command = readFileSync(join(PKG, "bin", "tokenhud"), "utf8");
  const node = readFileSync(SHIM, "utf8");
  let pkg: string;

  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), "tokenhud-preinstall-test-"));
    mkdirSync(join(pkg, "bin"));
    mkdirSync(join(pkg, "lib"));
    writeFileSync(join(pkg, "bin", "tokenhud"), command);
    chmodSync(join(pkg, "bin", "tokenhud"), 0o755);
    writeFileSync(join(pkg, "lib", "tokenhud.cjs"), node);
    copyFileSync(PREINSTALL, join(pkg, "preinstall.cjs"));
  });
  afterEach(() => {
    rmSync(pkg, { recursive: true, force: true });
  });

  const preinstall = (runtime: string) =>
    Bun.spawnSync([runtime, join(pkg, "preinstall.cjs")], {
      cwd: pkg,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
  const installed = () => readFileSync(join(pkg, "bin", "tokenhud"), "utf8");

  test.skipIf(NODE === null || process.platform !== "win32")(
    "Windows, under Node: the Node launcher in the command's place, and nothing else left",
    () => {
      const run = preinstall(NODE as string);
      expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
      expect(installed()).toBe(node);
      expect(readdirSync(join(pkg, "bin"))).toEqual(["tokenhud"]);
      // Again (a reinstall over it): the same.
      expect(preinstall(NODE as string).exitCode).toBe(0);
      expect(installed()).toBe(node);
    },
  );

  test.skipIf(NODE === null || process.platform !== "win32")(
    "Windows, a launcher it can't copy: the install goes on, and it says how to repair it",
    () => {
      rmSync(join(pkg, "lib", "tokenhud.cjs"));
      const run = preinstall(NODE as string);
      expect(run.exitCode).toBe(0);
      expect(run.stderr.toString()).toContain("couldn't set up the Windows command");
      expect(installed()).toBe(command);
      expect(readdirSync(join(pkg, "bin"))).toEqual(["tokenhud"]);
    },
  );

  test.skipIf(NODE === null || process.platform === "win32")(
    "Linux and macOS, under Node: the sh command stays, executable",
    () => {
      const run = preinstall(NODE as string);
      expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
      expect(installed()).toBe(command);
      expect(statSync(join(pkg, "bin", "tokenhud")).mode & 0o777).toBe(0o755);
    },
  );

  test("under Bun (a trusted install), on any OS: unchanged", () => {
    const run = preinstall(process.execPath);
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    expect(installed()).toBe(command);
  });
});

// The npm launcher (npm/tokenhud/bin/tokenhud.cjs) in a node_modules tree like the one npm
// installs, with a shell script standing in for the platform package's binary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmPackage, RELEASE_TARGETS } from "../../src/release.ts";

const SHIM = join(import.meta.dir, "..", "..", "npm", "tokenhud", "bin", "tokenhud.cjs");
const node = Bun.which("node");

test("the launcher knows exactly the platforms releases are built for", () => {
  const list = /const SUPPORTED = \[([^\]]*)\]/.exec(readFileSync(SHIM, "utf8"))?.[1] ?? "";
  const ids = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toEqual(RELEASE_TARGETS.map((t) => npmPackage(t).slice("@tokenhud/".length)));
});

describe.skipIf(node === null || process.platform === "win32")("the npm launcher", () => {
  let dir: string;
  let id: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tokenhud-npm-test-"));
    mkdirSync(join(dir, "node_modules", "tokenhud", "bin"), { recursive: true });
    copyFileSync(SHIM, join(dir, "node_modules", "tokenhud", "bin", "tokenhud.cjs"));
    // The machine's own platform package, glibc flavour (CI and dev machines are glibc).
    id = `${process.platform}-${process.arch}`;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function platformPackage(script: string): void {
    const pkg = join(dir, "node_modules", "@tokenhud", id);
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@tokenhud/${id}` }));
    writeFileSync(join(pkg, "bin", "tokenhud"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(pkg, "bin", "tokenhud"), 0o755);
  }

  function launch(...args: string[]) {
    return Bun.spawn(
      [node as string, join(dir, "node_modules", "tokenhud", "bin", "tokenhud.cjs"), ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  async function result(proc: ReturnType<typeof launch>) {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, signal: proc.signalCode, stdout, stderr };
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
    expect(out.stderr).toContain("npm install -g tokenhud --include=optional");
  });

  test("passes SIGTERM on to the binary and dies of it too", async () => {
    platformPackage('trap "echo got-term; exit 0" TERM; echo ready; while :; do sleep 0.05; done');
    const proc = launch();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("ready\n");
    proc.kill("SIGTERM");
    const rest = new TextDecoder().decode((await reader.read()).value);
    expect(rest).toBe("got-term\n");
    expect(await proc.exited).toBe(0);
  });
});

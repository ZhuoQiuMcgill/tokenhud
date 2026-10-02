// Finding every tokenhud on PATH and telling how each was installed, on synthetic PATH
// directories laid out as bun, npm, install.sh and other installers lay them out.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyToKeep,
  isCopyOf,
  pathDirs,
  removeCommand,
  tokenhudsOnPath,
  type VersionedCopy,
} from "../src/installs.ts";
import { guard } from "./guard.ts";

guard();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-installs-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(path: string, text: string, mode = 0o755): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

/** A launcher in a package tree and a link to it in `binDir`, as bun and npm make them. */
function linked(binDir: string, launcher: string): string {
  file(launcher, "#!/usr/bin/env bun\n");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(launcher, join(binDir, "tokenhud"));
  return join(binDir, "tokenhud");
}

describe.skipIf(process.platform === "win32")("tokenhud on PATH, POSIX", () => {
  test("each install method, in PATH order, each file once, only executables", () => {
    const curl = file(join(dir, "local", "bin", "tokenhud"), "\x7fELF a binary");
    const bun = linked(
      join(dir, ".bun", "bin"),
      join(dir, ".bun", "install", "global", "node_modules", "tokenhud", "bin", "tokenhud.cjs"),
    );
    const npm = linked(
      join(dir, "npm", "bin"),
      join(dir, "npm", "lib", "node_modules", "tokenhud", "bin", "tokenhud.cjs"),
    );
    const pnpm = file(
      join(dir, "pnpm", "tokenhud"),
      '#!/bin/sh\nexec node "$basedir/global/node_modules/tokenhud/bin/tokenhud.cjs" "$@"\n',
    );
    file(join(dir, "data", "tokenhud"), "not executable", 0o644);
    const PATH = [
      join(dir, "local", "bin"),
      join(dir, "data"),
      "",
      join(dir, ".bun", "bin"),
      join(dir, "local", "bin"),
      join(dir, "npm", "bin"),
      join(dir, "pnpm"),
      join(dir, "missing"),
    ].join(":");
    expect(tokenhudsOnPath({ PATH }, "linux")).toEqual([
      { path: curl, method: "binary" },
      { path: bun, method: "bun" },
      { path: npm, method: "npm" },
      { path: pnpm, method: "other" },
    ]);
  });

  test("bun's install anywhere BUN_INSTALL points; the same layout elsewhere is npm-like", () => {
    const root = join(dir, "opt", "bun");
    const link = linked(
      join(root, "bin"),
      join(root, "install", "global", "node_modules", "tokenhud", "bin", "tokenhud.cjs"),
    );
    const PATH = join(root, "bin");
    expect(tokenhudsOnPath({ PATH, BUN_INSTALL: root }, "linux")).toEqual([
      { path: link, method: "bun" },
    ]);
    expect(tokenhudsOnPath({ PATH }, "linux")).toEqual([{ path: link, method: "npm" }]);
  });

  test("a copy is this install's: bun's bin directory, npm's link, the very binary", () => {
    const home = join(dir, ".bun");
    const bun = linked(
      join(home, "bin"),
      join(home, "install", "global", "node_modules", "tokenhud", "bin", "tokenhud.cjs"),
    );
    const curl = file(join(dir, "local", "bin", "tokenhud"), "\x7fELF");
    const bunCopy = { path: bun, method: "bun" } as const;
    const curlCopy = { path: curl, method: "binary" } as const;
    const bunMethod = { kind: "bun-global", root: home } as const;
    expect(isCopyOf(bunCopy, bunMethod, "", "linux")).toBe(true);
    expect(isCopyOf(curlCopy, bunMethod, "", "linux")).toBe(false);
    expect(isCopyOf(bunCopy, { kind: "bun-global", root: join(dir, "other") }, "", "linux")).toBe(
      false,
    );
    expect(isCopyOf(curlCopy, { kind: "binary" }, curl, "linux")).toBe(true);
    expect(isCopyOf(curlCopy, { kind: "binary" }, join(dir, "elsewhere"), "linux")).toBe(false);
    expect(
      isCopyOf({ path: "/x", method: "npm" }, { kind: "npm", global: true }, "", "linux"),
    ).toBe(true);
    expect(isCopyOf({ path: "/x", method: "npm" }, { kind: "npx" }, "", "linux")).toBe(false);
  });
});

describe("tokenhud on PATH, Windows", () => {
  test("bun's shim, npm's .cmd, a standalone .exe, another script; PATHEXT picks within a directory", () => {
    const bun = file(join(dir, "bun", "tokenhud.exe"), "MZ bun's shim");
    file(join(dir, "bun", "tokenhud.bunx"), "metadata");
    const npm = file(
      join(dir, "npm", "tokenhud.cmd"),
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\tokenhud\\bin\\tokenhud.cjs" %*\r\n',
    );
    const ps1 = file(join(dir, "local", "tokenhud.exe"), "MZ the binary");
    const other = file(join(dir, "scoop", "tokenhud.cmd"), "@echo off\r\nsomething.exe %*\r\n");
    file(join(dir, "both", "tokenhud.cmd"), "@echo off\r\n");
    const both = file(join(dir, "both", "tokenhud.exe"), "MZ");
    const Path = ["bun", "npm", '"local"', "scoop", "both", "npm"]
      .map((d) => (d.startsWith('"') ? `"${join(dir, d.slice(1, -1))}"` : join(dir, d)))
      .join(";");
    expect(tokenhudsOnPath({ Path, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32")).toEqual([
      { path: bun, method: "bun" },
      { path: npm, method: "npm" },
      { path: ps1, method: "binary" },
      { path: other, method: "other" },
      { path: both, method: "binary" },
    ]);
    // A PATHEXT that lists .CMD first: the .cmd in `both`.
    expect(
      tokenhudsOnPath({ PATH: join(dir, "both"), PATHEXT: ".CMD;.EXE" }, "win32").map(
        (c) => c.method,
      ),
    ).toEqual(["other"]);
  });

  test("PATH entries in quotes, empty ones skipped", () => {
    expect(pathDirs({ Path: 'C:\\a;;"C:\\Program Files\\b";' }, "win32")).toEqual([
      "C:\\a",
      "C:\\Program Files\\b",
    ]);
  });
});

describe("which copy to keep, and how to remove the others", () => {
  const copy = (path: string, method: VersionedCopy["method"], version: string | null) => ({
    path,
    method,
    version,
  });

  test("the newest; among equals, bun's, then npm's, then a binary; then PATH order", () => {
    const a = copy("/a", "binary", "0.1.0-rc.1");
    const b = copy("/b", "bun", "0.1.0");
    const c = copy("/c", "npm", "0.1.0");
    expect(copyToKeep([a, b, c])).toBe(b);
    expect(copyToKeep([a, c])).toBe(c);
    expect(copyToKeep([copy("/x", "binary", "0.2.0"), b])?.path).toBe("/x");
    expect(copyToKeep([copy("/x", "binary", null), copy("/y", "npm", null)])?.path).toBe("/y");
    expect(copyToKeep([copy("/x", "binary", null), copy("/y", "binary", "0.0.1")])?.path).toBe(
      "/y",
    );
    expect(copyToKeep([copy("/x", "binary", "1.0.0"), copy("/y", "binary", "1.0.0")])?.path).toBe(
      "/x",
    );
    expect(copyToKeep([])).toBeUndefined();
  });

  test("each method's own command; a binary's file by name", () => {
    expect(removeCommand({ path: "/p", method: "bun" }, "linux")).toBe("bun remove -g tokenhud");
    expect(removeCommand({ path: "/p", method: "npm" }, "win32")).toBe("npm uninstall -g tokenhud");
    expect(
      removeCommand({ path: "/home/u/.local/bin/tokenhud", method: "binary" }, "linux", (p) =>
        p.replace("/home/u", "~"),
      ),
    ).toBe("rm ~/.local/bin/tokenhud");
    expect(removeCommand({ path: "C:\\t\\tokenhud.exe", method: "binary" }, "win32")).toBe(
      'del "C:\\t\\tokenhud.exe"',
    );
    expect(removeCommand({ path: "/opt/x/tokenhud", method: "other" }, "linux")).toBe(
      "delete /opt/x/tokenhud, or uninstall it the way it was installed",
    );
  });
});

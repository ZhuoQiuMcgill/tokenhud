// scripts/stage-npm.ts on stand-in binaries: the platform packages and the launcher package
// as they are published.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import { stageNpm } from "../../scripts/stage-npm.ts";
import { assetName, RELEASE_TARGETS, targetById } from "../../src/release.ts";
import { guard } from "../guard.ts";

guard();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-stage-npm-test-"));
  mkdirSync(join(dir, "dist"));
  for (const t of RELEASE_TARGETS)
    writeFileSync(join(dir, "dist", assetName(t)), `binary ${assetName(t)}`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("staging the npm packages", () => {
  test("a package per platform, and the launcher, last", () => {
    const out = join(dir, "npm");
    const dirs = stageNpm({ dist: join(dir, "dist"), out, version: "1.2.3" });
    expect(dirs.map((d) => d.slice(out.length + 1))).toEqual([
      "linux-x64",
      "linux-arm64",
      "linux-x64-musl",
      "linux-arm64-musl",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
      "win32-arm64",
      "tokenhud",
    ]);
  });

  test("a platform package: its binary, and os, cpu and libc so it installs only where it runs", () => {
    const out = join(dir, "npm");
    stageNpm({ dist: join(dir, "dist"), out, version: "1.2.3" });
    const musl = json(join(out, "linux-x64-musl", "package.json"));
    expect(musl).toMatchObject({
      name: "@tokenhud/linux-x64-musl",
      version: "1.2.3",
      os: ["linux"],
      cpu: ["x64"],
      libc: ["musl"],
      files: ["bin/tokenhud"],
    });
    expect(readFileSync(join(out, "linux-x64-musl", "README.md"), "utf8")).toContain(
      "`bun add -g @tokenhud/linux-x64-musl tokenhud`",
    );
    expect(readFileSync(join(out, "linux-x64-musl", "bin", "tokenhud"), "utf8")).toBe(
      "binary tokenhud-linux-x64-musl",
    );
    const win = json(join(out, "win32-arm64", "package.json"));
    expect(win).toMatchObject({ os: ["win32"], cpu: ["arm64"], files: ["bin/tokenhud.exe"] });
    expect(win.libc).toBeUndefined();
    if (process.platform !== "win32") {
      expect(statSync(join(out, "linux-x64", "bin", "tokenhud")).mode & 0o777).toBe(0o755);
    }
  });

  test("the launcher: the sh command, the Windows launcher and its preinstall, every platform but musl as an optional dependency", () => {
    const out = join(dir, "npm");
    stageNpm({ dist: join(dir, "dist"), out, version: "1.2.3" });
    const pkg = json(join(out, "tokenhud", "package.json"));
    expect(pkg).toMatchObject({
      name: "tokenhud",
      version: "1.2.3",
      bin: { tokenhud: "bin/tokenhud" },
      files: ["bin/tokenhud", "lib/tokenhud.cjs", "preinstall.cjs"],
      scripts: { preinstall: "node preinstall.cjs" },
    });
    // Bun ignores `libc`: as dependencies, the musl packages would download on every Linux.
    expect(pkg.optionalDependencies).toEqual({
      "@tokenhud/linux-x64": "1.2.3",
      "@tokenhud/linux-arm64": "1.2.3",
      "@tokenhud/darwin-x64": "1.2.3",
      "@tokenhud/darwin-arm64": "1.2.3",
      "@tokenhud/win32-x64": "1.2.3",
      "@tokenhud/win32-arm64": "1.2.3",
    });
    expect(readdirSync(join(out, "tokenhud")).sort()).toEqual([
      "LICENSE",
      "README.md",
      "bin",
      "lib",
      "package.json",
      "preinstall.cjs",
    ]);
    // As in the repo, byte for byte: .gitattributes keeps them LF on every checkout.
    const src = join(import.meta.dir, "..", "..", "npm", "tokenhud");
    for (const file of ["bin/tokenhud", "lib/tokenhud.cjs", "preinstall.cjs"]) {
      expect([file, readFileSync(join(out, "tokenhud", file), "utf8")]).toEqual([
        file,
        readFileSync(join(src, file), "utf8"),
      ]);
    }
    expect(readFileSync(join(out, "tokenhud", "bin", "tokenhud"), "utf8")).toStartWith(
      "#!/bin/sh\n",
    );
    expect(readFileSync(join(out, "tokenhud", "lib", "tokenhud.cjs"), "utf8")).not.toContain("\r");
    if (process.platform !== "win32") {
      expect(statSync(join(out, "tokenhud", "bin", "tokenhud")).mode & 0o777).toBe(0o755);
    }
  });

  test("only the platforms asked for, from where they are; the launcher lists them all", () => {
    const out = join(dir, "only");
    const t = targetById("darwin-arm64");
    if (t === undefined) throw new Error("no darwin-arm64 target");
    const dirs = stageNpm({ dist: join(dir, "dist"), out, version: "0.0.1", targets: [t] });
    expect(dirs).toEqual([join(out, "darwin-arm64"), join(out, "tokenhud")]);
    expect(
      Object.keys(json(join(out, "tokenhud", "package.json")).optionalDependencies),
    ).toHaveLength(6);
  });

  test("a missing binary stops it, naming the file", () => {
    rmSync(join(dir, "dist", "tokenhud-linux-arm64"));
    expect(() => stageNpm({ dist: join(dir, "dist"), out: join(dir, "npm") })).toThrow(
      "tokenhud-linux-arm64 is missing",
    );
  });
});

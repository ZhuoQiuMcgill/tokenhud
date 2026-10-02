// doctor's Install section on synthetic PATH directories: every tokenhud on PATH with its
// install method and version, tokenhud installed twice, an older copy shadowing a newer one,
// and bun's bin directory missing from PATH. Versions come from the probe, so nothing runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DoctorReport,
  doctorReport,
  type InstallProbe,
  renderDoctor,
} from "../../src/commands/doctor.ts";
import { guard } from "../guard.ts";

guard();

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokenhud-doctor-install-"));
  home = join(dir, "home");
  mkdirSync(home);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-02T12:00:00Z");

function file(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

/** `bun add -g tokenhud` under ~/.bun: the link in ~/.bun/bin and the platform binary. */
function bunInstall(): { link: string; exe: string } {
  const global = join(home, ".bun", "install", "global", "node_modules");
  const launcher = file(join(global, "tokenhud", "bin", "tokenhud"), "#!/bin/sh\n");
  file(join(global, "tokenhud", "package.json"), "{}");
  const exe = file(join(global, "@tokenhud", "linux-x64", "bin", "tokenhud"), "\x7fELF");
  mkdirSync(join(home, ".bun", "bin"), { recursive: true });
  symlinkSync(launcher, join(home, ".bun", "bin", "tokenhud"));
  return { link: join(home, ".bun", "bin", "tokenhud"), exe };
}

/** install.sh's copy: ~/.local/bin/tokenhud. */
function curlInstall(): string {
  return file(join(home, ".local", "bin", "tokenhud"), "\x7fELF");
}

function report(
  PATH: string[],
  execPath: string,
  versions: Record<string, string>,
): DoctorReport["install"] {
  const probe: InstallProbe = {
    execPath,
    compiled: true,
    platform: "linux",
    npmPrefix: () => null,
    versionOf: (copy) => versions[copy.path] ?? null,
  };
  const env = {
    PATH: PATH.join(":"),
    HOME: home,
    XDG_CONFIG_HOME: join(dir, "xdg"),
    TOKENHUD_WSL_USERS: "",
  };
  return doctorReport(env, NOW, home, probe).install;
}

/** The Install section of the human report. */
function rendered(install: DoctorReport["install"]): string {
  const base = doctorReport({ HOME: home, XDG_CONFIG_HOME: join(dir, "xdg") }, NOW, home);
  const text = renderDoctor({ ...base, install }, home);
  return text.slice(text.indexOf("Install"), text.indexOf("Claude Code")).trimEnd();
}

describe.skipIf(process.platform === "win32")("doctor: Install", () => {
  test("install.sh's copy ahead of a newer bun install: both listed, which to remove, and that it shadows", () => {
    const curl = curlInstall();
    const bun = bunInstall();
    const install = report(
      [join(home, ".local", "bin"), join(home, ".bun", "bin"), "/usr/bin"],
      bun.exe,
      { [curl]: "0.1.0-rc.1", [bun.link]: "0.1.0" },
    );
    expect(install).toEqual({
      method: "bun-global",
      on_path: [
        { path: curl, method: "binary", version: "0.1.0-rc.1", this_copy: false },
        { path: bun.link, method: "bun", version: "0.1.0", this_copy: true },
      ],
      bun_bin: { path: join(home, ".bun", "bin"), on_path: true },
      warnings: [
        {
          problem:
            "tokenhud is installed 2 ways: a standalone binary and bun. Keep one; to keep " +
            "~/.bun/bin/tokenhud (0.1.0), remove the other:",
          fix: ["rm ~/.local/bin/tokenhud"],
        },
        {
          problem:
            "~/.local/bin/tokenhud comes first on PATH, so `tokenhud` runs it, but it is " +
            "0.1.0-rc.1 and ~/.bun/bin/tokenhud is 0.1.0.",
          fix: [],
        },
      ],
    });
    expect(rendered(install)).toBe(
      [
        "Install (every tokenhud on PATH; a shell runs the first)",
        "  this copy     bun (bun add -g)",
        "  on PATH       ~/.local/bin/tokenhud · a standalone binary · 0.1.0-rc.1 · runs as tokenhud",
        "                ~/.bun/bin/tokenhud · bun · 0.1.0 · this copy",
        "  bun bin       ~/.bun/bin is on PATH",
        "  warning       tokenhud is installed 2 ways: a standalone binary and bun. Keep one; to keep",
        "                ~/.bun/bin/tokenhud (0.1.0), remove the other:",
        "                  rm ~/.local/bin/tokenhud",
        "  warning       ~/.local/bin/tokenhud comes first on PATH, so `tokenhud` runs it, but it is",
        "                0.1.0-rc.1 and ~/.bun/bin/tokenhud is 0.1.0.",
      ].join("\n"),
    );
  });

  test("installed with bun, but bun's bin directory is not on PATH", () => {
    const curl = curlInstall();
    const bun = bunInstall();
    const install = report([join(home, ".local", "bin")], curl, { [curl]: "0.1.0" });
    expect(install.method).toBe("binary");
    expect(install.on_path).toEqual([
      { path: curl, method: "binary", version: "0.1.0", this_copy: true },
    ]);
    expect(install.bun_bin).toEqual({ path: join(home, ".bun", "bin"), on_path: false });
    expect(install.warnings).toEqual([
      {
        problem: "tokenhud is installed with bun, but ~/.bun/bin is not on PATH",
        fix: [
          `add it in your shell's profile (bun's installer does): export PATH="$HOME/.bun/bin:$PATH"`,
        ],
      },
    ]);
    // Run from bun's own copy, the same.
    expect(report([], bun.exe, {}).warnings).toEqual(install.warnings);
  });

  test("one install method twice, the older first: only that it shadows the newer", () => {
    const old = file(join(dir, "usr-local", "tokenhud"), "\x7fELF");
    const curl = curlInstall();
    const install = report([join(dir, "usr-local"), join(home, ".local", "bin")], curl, {
      [old]: "0.0.9",
      [curl]: "0.1.0",
    });
    expect(install.warnings).toEqual([
      {
        problem: `${old} comes first on PATH, so \`tokenhud\` runs it, but it is 0.0.9 and ~/.local/bin/tokenhud is 0.1.0. If you don't use it:`,
        fix: [`rm ${old}`],
      },
    ]);
  });

  test("one copy, or none: no warnings", () => {
    const curl = curlInstall();
    expect(report([join(home, ".local", "bin")], curl, { [curl]: "0.1.0" }).warnings).toEqual([]);
    const none = report(["/nonexistent"], curl, {});
    expect(none.on_path).toEqual([]);
    expect(none.warnings).toEqual([]);
    expect(rendered(none)).toContain("  on PATH       none");
  });
});

describe("doctor: Install on Windows", () => {
  test("bun's shim and an install.ps1 copy: bun's directory by its full path", () => {
    const bunBin = join(home, ".bun", "bin");
    file(join(bunBin, "tokenhud.exe"), "MZ");
    file(join(bunBin, "tokenhud.bunx"), "");
    file(join(home, ".bun", "install", "global", "node_modules", "tokenhud", "package.json"), "{}");
    const exe = file(
      join(
        home,
        ".bun",
        "install",
        "global",
        "node_modules",
        "@tokenhud",
        "win32-x64",
        "bin",
        "tokenhud.exe",
      ),
      "MZ",
    );
    const ps1 = file(join(home, "AppData", "Local", "tokenhud", "bin", "tokenhud.exe"), "MZ");
    const probe: InstallProbe = {
      execPath: exe,
      compiled: true,
      platform: "win32",
      npmPrefix: () => null,
      versionOf: (copy) => (copy.path === ps1 ? "0.1.0" : "0.1.0"),
    };
    const env = {
      Path: [join(home, "AppData", "Local", "tokenhud", "bin"), bunBin].join(";"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: home,
      HOME: home,
      XDG_CONFIG_HOME: join(dir, "xdg"),
      TOKENHUD_WSL_USERS: "",
    };
    const install = doctorReport(env, NOW, home, probe).install;
    expect(install.on_path).toEqual([
      { path: ps1, method: "binary", version: "0.1.0", this_copy: false },
      { path: join(bunBin, "tokenhud.exe"), method: "bun", version: "0.1.0", this_copy: true },
    ]);
    expect(install.bun_bin).toEqual({ path: bunBin, on_path: true });
    expect(install.warnings).toEqual([
      {
        problem: `tokenhud is installed 2 ways: a standalone binary and bun. Keep one; to keep ${join(bunBin, "tokenhud.exe")} (0.1.0), remove the other:`,
        fix: [`del "${ps1}"`],
      },
    ]);
  });
});

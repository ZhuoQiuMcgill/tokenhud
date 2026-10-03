// Every `tokenhud` on PATH and how each was installed: for `tokenhud doctor` (tokenhud
// installed twice, an older copy shadowing a newer one, bun's bin directory missing from
// PATH) and `tokenhud update` (a warning when another copy shadows the one it updated).
// Read-only: a copy is never removed, only named with the command that removes it.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, posix, win32 } from "node:path";
import { testMayRun } from "./limits/clients.ts";
import { bunGlobalRoot, compareVersions, type InstallMethod, parseVersion } from "./update.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** How a copy on PATH was installed. */
export type CopyMethod =
  /** `bun add -g`: bun's link (POSIX), or its shim `tokenhud.exe` beside `tokenhud.bunx`. */
  | "bun"
  /** `npm install -g`: npm's link (POSIX), or its `tokenhud.cmd` (Windows). */
  | "npm"
  /** A standalone binary: install.sh, install.ps1, a download, a local build. */
  | "binary"
  /** Anything else: another package manager's script, a wrapper. */
  | "other";

export interface PathCopy {
  /** The file a shell runs for `tokenhud` from one PATH directory. */
  readonly path: string;
  readonly method: CopyMethod;
}

/** `env`'s variable `name`; on Windows in any case (`Path`, `PathExt`). */
function variable(env: Env, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The directories on PATH, in order, as absolute paths: a relative entry (`.`, `bin`) is the
 * one a shell would search from `cwd`. On POSIX an empty entry is the current directory, as
 * sh and bash search it; Windows skips empty entries.
 */
export function pathDirs(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): string[] {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  return (variable(env, "PATH", windows) ?? "")
    .split(windows ? ";" : ":")
    .map((dir) => (windows ? dir.replace(/^"(.*)"$/, "$1") : dir))
    .filter((dir) => !windows || dir !== "")
    .map((dir) => (dir !== "" && path.isAbsolute(dir) ? dir : path.resolve(cwd, dir)));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether two paths name one file or directory: links resolved, case folded on Windows. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform) {
  const fold = (p: string) => {
    const r = real(p).replaceAll("\\", "/").replace(/\/+$/, "");
    return platform === "win32" ? r.toLowerCase() : r;
  };
  return fold(a) === fold(b);
}

function runnable(path: string, windows: boolean): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (windows || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Whether the file starts with `#!`: a script, not a binary. Reads two bytes. */
function isScript(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(2);
      return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** A launcher in a package (`node_modules/tokenhud/bin/…`), or a platform package's binary. */
const IN_PACKAGE =
  /[/\\]node_modules[/\\](?:tokenhud[/\\]bin[/\\][^/\\]+|@tokenhud[/\\][^/\\]+[/\\]bin[/\\]tokenhud)$/;

function posixMethod(path: string, env: Env): CopyMethod {
  const target = real(path);
  if (IN_PACKAGE.test(target)) {
    return bunGlobalRoot(target, env.BUN_INSTALL) !== null ? "bun" : "npm";
  }
  return isScript(target) ? "other" : "binary";
}

function windowsMethod(path: string): CopyMethod {
  const ext = extname(path).toLowerCase();
  if (ext === ".exe") return existsSync(join(dirname(path), "tokenhud.bunx")) ? "bun" : "binary";
  if (ext === ".cmd" || ext === ".bat") {
    try {
      // npm's shim starts "%dp0%\node_modules\tokenhud\bin\tokenhud".
      const text = readFileSync(path, "latin1");
      return /node_modules[/\\]tokenhud[/\\]bin[/\\]/i.test(text) ? "npm" : "other";
    } catch {
      return "other";
    }
  }
  return "other";
}

/**
 * Every `tokenhud` on PATH, in PATH order: a shell runs the first. One per directory, the
 * one a shell would pick there (on Windows, by PATHEXT); a file reached twice (a directory
 * on PATH twice, or through a link) counts once.
 */
export function tokenhudsOnPath(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): PathCopy[] {
  const windows = platform === "win32";
  const exts = windows
    ? (variable(env, "PATHEXT", true) ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((ext) => ext.trim().toLowerCase())
        .filter((ext) => ext.startsWith("."))
    : [""];
  const seen = new Set<string>();
  const copies: PathCopy[] = [];
  for (const dir of pathDirs(env, platform, cwd)) {
    for (const ext of exts) {
      const path = join(dir, `tokenhud${ext}`);
      if (!runnable(path, windows)) continue;
      const key = windows ? path.toLowerCase() : real(path);
      if (!seen.has(key)) {
        seen.add(key);
        copies.push({ path, method: windows ? windowsMethod(path) : posixMethod(path, env) });
      }
      break;
    }
  }
  return copies;
}

/**
 * The tokenhud package (`…/node_modules/tokenhud`) a bun or npm copy runs, or null: the one
 * its link leads to on POSIX; on Windows the one beside npm's tokenhud.cmd, which starts it.
 * Bun's Windows shim is left out: it can't run tokenhud's command at all.
 */
export function packageOf(copy: PathCopy, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    return copy.method === "npm" ? join(dirname(copy.path), "node_modules", "tokenhud") : null;
  }
  if (copy.method !== "bun" && copy.method !== "npm") return null;
  const target = real(copy.path);
  return /[/\\]node_modules[/\\]tokenhud[/\\]bin[/\\][^/\\]+$/.test(target)
    ? dirname(dirname(target))
    : null;
}

/**
 * Whether the tokenhud package at `pkg` has one of the platform packages `names` (`linux-x64`,
 * …) where its command looks: node_modules beside it, or in any directory above it.
 */
export function hasPlatformPackage(
  pkg: string,
  names: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const exe = platform === "win32" ? "tokenhud.exe" : "tokenhud";
  for (let dir = pkg; ; dir = dirname(dir)) {
    if (basename(dir) !== "node_modules") {
      for (const name of names) {
        if (existsSync(join(dir, "node_modules", "@tokenhud", name, "bin", exe))) return true;
      }
    }
    if (dirname(dir) === dir) return false;
  }
}

/** Whether `copy` runs the install `method` describes (this copy's, from `execPath`). */
export function isCopyOf(
  copy: PathCopy,
  method: InstallMethod,
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  switch (method.kind) {
    case "bun-global":
      return (
        copy.method === "bun" && samePath(dirname(copy.path), join(method.root, "bin"), platform)
      );
    case "npm":
      return method.global && copy.method === "npm";
    case "binary":
      return copy.method === "binary" && samePath(copy.path, execPath, platform);
    default:
      return false;
  }
}

/** The bun install root that holds tokenhud globally (BUN_INSTALL, or ~/.bun), or null. */
export function bunInstallRoot(env: Env, home: string): string | null {
  const root = env.BUN_INSTALL || join(home, ".bun");
  const pkg = join(root, "install", "global", "node_modules", "tokenhud", "package.json");
  return existsSync(pkg) ? root : null;
}

/**
 * What `copy --version` says (`0.1.0`), or null when it can't be run, says otherwise, or
 * isn't one of tokenhud's installs ("other": a wrapper this has no business running).
 */
export function copyVersion(copy: PathCopy, env: Env, platform: NodeJS.Platform): string | null {
  // In a test, only a copy the test made: never the machine's own tokenhud.
  if (copy.method === "other" || !testMayRun(copy.path)) return null;
  // npm's tokenhud.cmd runs only through cmd.exe, which takes the path quoted as written.
  const shim = platform === "win32" && /\.(?:cmd|bat)$/i.test(copy.path);
  const cmd = shim
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `""${copy.path}" --version"`]
    : [copy.path, "--version"];
  try {
    const run = Bun.spawnSync(cmd, {
      env: { ...env },
      stdout: "pipe",
      stderr: "ignore",
      // `--version` answers at once; a copy that hangs is shown with no version.
      timeout: 5_000,
      windowsVerbatimArguments: shim,
    });
    const m = /^tokenhud (\S+)$/.exec(run.stdout.toString().trim());
    return run.exitCode === 0 && m !== null ? (m[1] as string) : null;
  } catch {
    return null;
  }
}

/** How a copy's install method reads in a sentence. */
export const COPY_METHODS: Readonly<Record<CopyMethod, string>> = {
  bun: "bun",
  npm: "npm",
  binary: "a standalone binary",
  other: "another installer",
};

/**
 * A path as one word for a POSIX shell, to paste as it is: `~/…` under `home`, and quoted
 * only when it has to be, so `~/My Tools/x` becomes `"$HOME/My Tools/x"`.
 */
export function shellWord(path: string, home: string): string {
  const plain = /^[\w@%+=:,./-]+$/;
  if (home !== "" && path.startsWith(`${home}/`)) {
    const rest = path.slice(home.length);
    return plain.test(rest) ? `~${rest}` : `"$HOME${rest.replace(/["\\$`]/g, "\\$&")}"`;
  }
  return plain.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/** The command that removes `copy`; a path under `home` is written from `~` on POSIX. */
export function removeCommand(copy: PathCopy, platform: NodeJS.Platform, home: string): string {
  const shown = platform === "win32" ? `"${copy.path}"` : shellWord(copy.path, home);
  switch (copy.method) {
    case "bun":
      return "bun remove -g tokenhud";
    case "npm":
      return "npm uninstall -g tokenhud";
    case "binary":
      return platform === "win32" ? `del ${shown}` : `rm ${shown}`;
    default:
      return `delete ${shown}, or uninstall it the way it was installed`;
  }
}

/** A copy on PATH with its version, as `tokenhud doctor` lists them. */
export interface VersionedCopy extends PathCopy {
  readonly version: string | null;
}

const RANK: Readonly<Record<CopyMethod, number>> = { bun: 0, npm: 1, binary: 2, other: 3 };

/**
 * The copy to keep of several: the newest; among equals (or unknown versions), bun's, then
 * npm's, then a standalone binary, then the first on PATH. On Windows, where bun can't run
 * tokenhud's command, never bun's while there is another.
 */
export function copyToKeep(
  copies: readonly VersionedCopy[],
  platform: NodeJS.Platform = process.platform,
): VersionedCopy | undefined {
  const version = (c: VersionedCopy) => (c.version === null ? null : parseVersion(c.version));
  const unsupported = (c: VersionedCopy) => platform === "win32" && c.method === "bun";
  return [...copies].sort((a, b) => {
    if (unsupported(a) !== unsupported(b)) return unsupported(a) ? 1 : -1;
    const va = version(a);
    const vb = version(b);
    if (va !== null && vb !== null && compareVersions(va, vb) !== 0) return compareVersions(vb, va);
    if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
    return RANK[a.method] - RANK[b.method];
  })[0];
}

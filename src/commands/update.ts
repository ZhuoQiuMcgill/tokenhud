// `tokenhud update`: moves to the newest release. A standalone binary (install.sh,
// install.ps1) replaces itself with the newest GitHub release. A global bun or npm install
// belongs to its package manager, so tokenhud runs it (`bun add -g`, `npm install -g`) and
// checks the version it installed. npx, bunx and a project's dependency are told the
// command. Never runs on its own.

import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  COPY_METHODS,
  isCopyOf,
  type PathCopy,
  removeCommand,
  tokenhudsOnPath,
} from "../installs.ts";
import { refuseRealClient } from "../limits/clients.ts";
import { assetName, targetById } from "../release.ts";
import {
  compareVersions,
  downloadVerified,
  type InstallMethod,
  installMethod,
  isCompiled,
  newestRelease,
  npmGlobalPrefix,
  type PackageManagerUpdate,
  packageManagerUpdate,
  parkingPath,
  parseVersion,
  platformPackageOf,
  type Release,
  type ReleaseSource,
  releaseSource,
  replaceBinary,
  stagingPath,
  UpdateError,
  type Version,
  whenFree,
} from "../update.ts";
import { VERSION } from "../version.ts";

export const UPDATE_HELP = `Usage:
  tokenhud update [--check] [--prerelease] [--print]

Updates tokenhud to the newest release. A binary installed by install.sh or install.ps1
replaces itself with the newest release on GitHub, once the download matches the release's
SHA-256 checksums. A global bun or npm install is updated by its package manager: tokenhud
runs bun add -g or npm install -g, then checks the version it installed. For npx, bunx or a
project's dependency, it prints the command that updates it.

Options:
  --check        only report whether an update is available
  --prerelease   include prereleases (release candidates, betas); npm's next tag
  --print        print the command that updates this install, and run nothing`;

/** What the command touches, so tests can fake an install, a release and an older version. */
export interface UpdateDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly execPath: string;
  readonly compiled: boolean;
  readonly platform: NodeJS.Platform;
  /** Which release asset this binary is (scripts/build.ts defines it), e.g. "linux-x64". */
  readonly target: string | undefined;
  readonly fetch: typeof fetch;
  readonly npmPrefix: () => string | null;
  /** What `bin --version` prints, or why it could not run. */
  readonly versionOf: (bin: string) => string;
  /** Every tokenhud on PATH, in PATH order: to warn when another comes before this one. */
  readonly copies: () => readonly PathCopy[];
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function versionOf(bin: string): string {
  try {
    // A just-written .exe is locked while Windows scans it; spawning then fails with EBUSY.
    const run = whenFree(() =>
      Bun.spawnSync([bin, "--version"], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      }),
    );
    if (run.exitCode === 0) return run.stdout.toString().trim();
    return `exit ${run.exitCode}: ${run.stderr.toString().trim().split("\n")[0] ?? ""}`;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Deletes the staged download; reports one it can't. */
function removeStaged(path: string, deps: UpdateDeps): void {
  try {
    whenFree(() => rmSync(path, { force: true }), deps.platform);
  } catch (error) {
    deps.err(`couldn't delete ${path}: ${(error as Error).message}`);
  }
}

function defaultDeps(): UpdateDeps {
  return {
    env: process.env,
    version: VERSION,
    execPath: process.execPath,
    compiled: isCompiled(),
    platform: process.platform,
    target: process.env.TOKENHUD_TARGET,
    fetch,
    npmPrefix: npmGlobalPrefix,
    versionOf,
    copies: () => tokenhudsOnPath(process.env),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`tokenhud update: ${line}\n`),
  };
}

/**
 * For an install tokenhud leaves to the user (npx, bunx, a project's dependency): why, and
 * the command that updates it. Null for the others, which `tokenhud update` updates.
 */
function hintFor(
  method: InstallMethod,
  tag: "latest" | "next",
): { why: string; command: string } | null {
  switch (method.kind) {
    case "npm":
      return method.global
        ? null
        : {
            why: "installed as a project dependency; in that project run",
            command: `npm install tokenhud@${tag}`,
          };
    case "npx":
      return {
        why: "run through npx, which keeps a cached copy; for the newest one run",
        command: `npx tokenhud@${tag}`,
      };
    case "bunx":
      return {
        why: "run through bunx, which keeps a cached copy; for the newest one run",
        command: `bunx tokenhud@${tag}`,
      };
    default:
      return null;
  }
}

/**
 * Whether every registry the environment names is on this machine. A test may run a real
 * bun or npm only against one: the install test's fake registry, never npm's.
 */
function localRegistry(env: UpdateDeps["env"]): boolean {
  const named = ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"]
    .map((name) => env[name])
    .filter((url) => url !== undefined && url !== "");
  return (
    named.length > 0 && named.every((url) => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url as string))
  );
}

/** Runs the package manager on this terminal: its exit code, or why it didn't run. */
function runPackageManager(
  update: PackageManagerUpdate,
  method: InstallMethod,
  deps: UpdateDeps,
): number | string {
  const [name, ...args] = update.argv as [string, ...string[]];
  const path = deps.env.PATH ?? deps.env.Path;
  let exe = Bun.which(name, path === undefined ? {} : { PATH: path });
  if (exe === null && method.kind === "bun-global") {
    // The bun that made this install, when PATH lacks it.
    const own = join(method.root, "bin", deps.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(own)) exe = own;
  }
  if (exe === null) return `${name} is not on PATH`;
  try {
    if (!localRegistry(deps.env)) refuseRealClient(exe);
  } catch (error) {
    return (error as Error).message;
  }
  // npm is npm.cmd on Windows, which only cmd.exe runs; it takes the path quoted as written.
  const shim = deps.platform === "win32" && /\.(?:cmd|bat)$/i.test(exe);
  const cmd = shim
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `""${exe}" ${args.join(" ")}"`]
    : [exe, ...args];
  try {
    const run = Bun.spawnSync(cmd, {
      env: { ...deps.env, ...update.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      windowsVerbatimArguments: shim,
    });
    return run.exitCode ?? `it was stopped by ${run.signalCode}`;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Warns when the tokenhud a shell runs is not the one just updated: an older install comes
 * first on PATH, or (for bun) bun's bin directory isn't on PATH at all. Never removes one.
 */
function warnShadowed(method: InstallMethod, deps: UpdateDeps): void {
  const first = deps.copies()[0];
  if (first === undefined) {
    if (method.kind === "bun-global") {
      deps.err(
        `WARNING: ${join(method.root, "bin")} is not on PATH, so the tokenhud command isn't ` +
          "found: add it to PATH (bun's installer does)",
      );
    }
    return;
  }
  if (isCopyOf(first, method, deps.execPath, deps.platform)) return;
  deps.err(
    `WARNING: ${first.path} (${COPY_METHODS[first.method]}) comes first on PATH, so ` +
      "`tokenhud` runs that one, not the copy just updated. If you don't use it, remove it: " +
      removeCommand(first, deps.platform),
  );
}

/**
 * Moves this .exe out of its package before the package manager replaces the package
 * (`parkingPath` says why). Returns where it went, or null when it stayed.
 */
function park(exe: string, deps: UpdateDeps): string | null {
  const to = parkingPath(exe);
  if (to === null) return null;
  try {
    whenFree(() => renameSync(exe, to), deps.platform);
    return to;
  } catch (error) {
    deps.err(`couldn't move ${exe} aside (${(error as Error).message}); updating anyway`);
    return null;
  }
}

/** After the package manager: puts the parked .exe back if nothing replaced it. */
function unpark(parked: string, exe: string, deps: UpdateDeps): void {
  try {
    if (!existsSync(exe)) whenFree(() => renameSync(parked, exe), deps.platform);
    else rmSync(parked, { force: true });
  } catch {
    // Still running: the next start deletes it (removeStaleOld).
  }
}

function updateThroughPackageManager(
  update: PackageManagerUpdate,
  method: InstallMethod,
  tag: "latest" | "next",
  current: Version,
  deps: UpdateDeps,
): number {
  const command = update.argv.join(" ");
  deps.out(`running: ${command}`);
  const exe = deps.execPath;
  const parked = deps.platform === "win32" ? park(exe, deps) : null;
  let result: number | string;
  try {
    result = runPackageManager(update, method, deps);
  } finally {
    if (parked !== null) unpark(parked, exe, deps);
  }
  if (result !== 0) {
    deps.err(
      typeof result === "number"
        ? `${command} failed (exit ${result})`
        : `couldn't run ${command}: ${result}`,
    );
    return 1;
  }
  const says = deps.versionOf(exe);
  const installed = /^tokenhud (\S+)$/.exec(says)?.[1];
  const version = installed === undefined ? null : parseVersion(installed);
  if (installed === undefined || version === null) {
    deps.err(`${command} finished, but ${exe} --version said: ${says}`);
    return 1;
  }
  const order = compareVersions(version, current);
  deps.out(
    order === 0
      ? `tokenhud ${deps.version} is up to date`
      : order > 0
        ? `updated tokenhud ${deps.version} → ${installed}`
        : `installed tokenhud ${installed}, older than ${deps.version}: the ${tag} tag points at an older release`,
  );
  warnShadowed(method, deps);
  return 0;
}

export async function runUpdate(
  args: readonly string[],
  deps: UpdateDeps = defaultDeps(),
): Promise<number> {
  let check: boolean;
  let prerelease: boolean;
  let print: boolean;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        check: { type: "boolean", default: false },
        prerelease: { type: "boolean", default: false },
        print: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      deps.out(UPDATE_HELP);
      return 0;
    }
    if (positionals.length > 0) throw new Error(`unexpected argument '${positionals[0]}'`);
    check = values.check;
    prerelease = values.prerelease;
    print = values.print;
  } catch (error) {
    deps.err((error as Error).message);
    return 2;
  }

  const method = installMethod(deps.execPath, deps.compiled, deps.npmPrefix, deps.env);
  if (method.kind === "source") {
    deps.err("this is tokenhud running from source; update the checkout with git pull");
    return 1;
  }
  const tag = prerelease ? "next" : "latest";
  const managed = packageManagerUpdate(method, tag, platformPackageOf(deps.execPath));
  const hint = hintFor(method, tag);
  if (print) {
    // Asks nothing over the network: the command doesn't depend on what is released.
    deps.out(
      managed?.argv.join(" ") ??
        hint?.command ??
        `tokenhud update${prerelease ? " --prerelease" : ""}`,
    );
    return 0;
  }
  const current = parseVersion(deps.version);
  if (current === null) {
    deps.err(`can't compare versions: this build's version '${deps.version}' isn't semver`);
    return 1;
  }
  // The package manager knows what its registry has; GitHub's newest release may not be
  // published there yet, so it isn't asked.
  if (managed !== null && !check) {
    return updateThroughPackageManager(managed, method, tag, current, deps);
  }

  let source: ReleaseSource;
  try {
    source = releaseSource(deps.env);
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    deps.err(error.message);
    return 2;
  }
  if (source.overridden) {
    deps.err(
      `WARNING: releases come from ${source.api} (TOKENHUD_RELEASES_API), not GitHub. ` +
        "Its SHA256SUMS comes from the same server, so use only a server you trust.",
    );
  }

  const hintLine = hint === null ? null : `${hint.why}:  ${hint.command}`;
  let release: Release | null;
  try {
    release = await newestRelease(source, prerelease, deps.fetch);
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    deps.err(error.message);
    if (hintLine !== null) deps.out(hintLine);
    return 1;
  }
  if (release === null) {
    deps.out(
      prerelease
        ? "no release of tokenhud found"
        : "no stable release yet; tokenhud update --prerelease includes prereleases",
    );
    return 0;
  }
  const latest = release.tag.replace(/^v/, "");
  const order = compareVersions(release.version, current);
  if (order <= 0) {
    deps.out(
      order === 0
        ? `tokenhud ${deps.version} is up to date`
        : `tokenhud ${deps.version} is newer than the latest release (${latest})`,
    );
    return 0;
  }
  if (check || hintLine !== null) {
    deps.out(`update available: tokenhud ${deps.version} → ${latest}`);
    if (hintLine !== null) deps.out(hintLine);
    else if (managed !== null) {
      deps.out(
        `run: tokenhud update${prerelease ? " --prerelease" : ""}  (it runs ${managed.argv.join(" ")})`,
      );
    } else deps.out(`run: tokenhud update${prerelease ? " --prerelease" : ""}`);
    return 0;
  }
  const code = await selfUpdate(release, latest, source, deps);
  if (code === 0) warnShadowed(method, deps);
  return code;
}

async function selfUpdate(
  release: Release,
  latest: string,
  source: ReleaseSource,
  deps: UpdateDeps,
): Promise<number> {
  const target = deps.target === undefined ? undefined : targetById(deps.target);
  if (target === undefined) {
    deps.err("this binary doesn't know its platform; reinstall it with install.sh or install.ps1");
    return 1;
  }
  const name = assetName(target);
  const exe = deps.execPath;
  const staging = stagingPath(exe, deps.platform);
  try {
    // Fails early, before a 100 MB download, when the binary's directory isn't writable.
    writeFileSync(staging, "");
    deps.out(`downloading ${name} from ${release.tag}…`);
    const bytes = await downloadVerified(release, name, staging, deps.fetch, source.insecure);
    deps.out(`checksum ok (${(bytes / 1e6).toFixed(1)} MB)`);
    if (deps.platform !== "win32") chmodSync(staging, 0o755);
    // A binary that can't start (or isn't the version it claims) must not replace one that can.
    const says = deps.versionOf(staging);
    if (says !== `tokenhud ${latest}`) {
      throw new UpdateError(
        `the downloaded binary didn't report version ${latest} (${says}); nothing was changed`,
      );
    }
    replaceBinary(exe, staging, deps.platform);
  } catch (error) {
    if (error instanceof UpdateError) deps.err(error.message);
    else {
      const code = (error as NodeJS.ErrnoException).code;
      deps.err(
        code === "EACCES" || code === "EPERM"
          ? `can't replace ${exe} (${code}): it is not writable by you. Re-run the installer, ` +
              "or install to a directory you own (TOKENHUD_INSTALL)"
          : `can't replace ${exe}: ${(error as Error).message}`,
      );
    }
    removeStaged(staging, deps);
    return 1;
  }
  deps.out(`updated tokenhud ${deps.version} → ${latest} (${exe})`);
  return 0;
}

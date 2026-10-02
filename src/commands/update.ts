// `tokenhud update`: moves to the newest release. A standalone binary (install.sh,
// install.ps1) replaces itself with the newest GitHub release. A global bun or npm install
// belongs to its package manager: tokenhud asks it which version each dist-tag points at,
// installs that exact version (`bun add -g`, `npm install -g`), never an older one unless
// told, and checks that the command a shell runs works afterwards. npx, bunx and a
// project's dependency are told the command. Never runs on its own.

import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  COPY_METHODS,
  isCopyOf,
  type PathCopy,
  removeCommand,
  tokenhudsOnPath,
} from "../installs.ts";
import { refuseRealClient, testMayRun } from "../limits/clients.ts";
import { assetName, targetById } from "../release.ts";
import {
  chooseTarget,
  compareVersions,
  distTagsCommand,
  downloadVerified,
  type InstallMethod,
  installCommand,
  installMethod,
  isCompiled,
  newestRelease,
  npmGlobalPrefix,
  type PackageManager,
  packageManagerFor,
  parkingPath,
  parseDistTags,
  parseVersion,
  printTag,
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
  tokenhud update [--check] [--prerelease] [--allow-downgrade] [--print]

Updates tokenhud to the newest release. A binary installed by install.sh or install.ps1
replaces itself with the newest release on GitHub, once the download matches the release's
SHA-256 checksums. A global bun or npm install is updated by its package manager: tokenhud
asks it for the version npm's latest tag points at (next, for a release candidate, while
next is no older), installs exactly that version with bun add -g or npm install -g, then
checks that the tokenhud command runs it. It never installs an older version unless asked.
For npx, bunx or a project's dependency, it prints the command that updates it.

Options:
  --check             only report whether an update is available
  --prerelease        include prereleases (release candidates, betas); npm's next tag
  --allow-downgrade   install the tag's version even when it is older than this one
  --print             print the command that updates this install, by tag, and run nothing`;

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
  /** What `bin --version` prints, or why it could not run; `bin` may be npm's .cmd. */
  readonly versionOf: (bin: string) => string;
  /** Every tokenhud on PATH, in PATH order: to warn when another comes before this one. */
  readonly copies: () => readonly PathCopy[];
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** A .cmd or .bat file: only cmd.exe runs it, and it takes the path quoted as written. */
const isCmdScript = (path: string, platform: NodeJS.Platform) =>
  platform === "win32" && /\.(?:cmd|bat)$/i.test(path);

/** `[file, ...args]` as Bun.spawn takes it, through cmd.exe for a .cmd file. */
function spawnable(file: string, args: readonly string[], platform: NodeJS.Platform) {
  if (!isCmdScript(file, platform)) return { cmd: [file, ...args], verbatim: false };
  const line = `""${file}" ${args.join(" ")}"`;
  return { cmd: [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", line], verbatim: true };
}

function versionOf(bin: string): string {
  if (!existsSync(bin)) return `${bin} is not there`;
  try {
    const { cmd, verbatim } = spawnable(bin, ["--version"], process.platform);
    // A just-written .exe is locked while Windows scans it; spawning then fails with EBUSY.
    const run = whenFree(() =>
      Bun.spawnSync(cmd, {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        windowsVerbatimArguments: verbatim,
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
 * In a test, whether a real bun or npm may run: only against the install test's fake
 * registry (every registry variable, scoped ones too, at 127.0.0.1), and only into the
 * test's temp dir (bun's BUN_INSTALL, npm's prefix). Outside tests, always.
 */
function mayRunRealPackageManager(pm: PackageManager, env: UpdateDeps["env"]): boolean {
  const registries = Object.entries(env).filter(([name, url]) => /registry$/i.test(name) && url);
  const local =
    registries.length > 0 &&
    registries.every(([, url]) => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url as string));
  const destination =
    pm.name === "bun" ? pm.env.BUN_INSTALL : (env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX);
  return local && destination !== undefined && destination !== "" && testMayRun(destination);
}

/** The package manager's executable, or why it can't run. */
function resolvePackageManager(pm: PackageManager, deps: UpdateDeps): string | Error {
  const path = deps.env.PATH ?? deps.env.Path;
  let exe = Bun.which(pm.name, path === undefined ? {} : { PATH: path });
  if (exe === null && pm.name === "bun" && pm.env.BUN_INSTALL !== undefined) {
    // The bun that made this install, when PATH lacks it.
    const own = join(pm.env.BUN_INSTALL, "bin", deps.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(own)) exe = own;
  }
  if (exe === null) return new Error(`${pm.name} is not on PATH`);
  try {
    if (!mayRunRealPackageManager(pm, deps.env)) refuseRealClient(exe);
  } catch (error) {
    return error as Error;
  }
  return exe;
}

/**
 * Runs the package manager in `pm.cwd`: its exit code and, with `capture`, its output; or
 * why it didn't run. Without `capture` it uses this terminal.
 */
function runPackageManager(
  exe: string,
  args: readonly string[],
  pm: PackageManager,
  deps: UpdateDeps,
  capture: boolean,
): { code: number; stdout: string } | Error {
  const { cmd, verbatim } = spawnable(exe, args, deps.platform);
  try {
    const run = Bun.spawnSync(cmd, {
      env: { ...deps.env, ...pm.env },
      cwd: pm.cwd,
      stdin: capture ? "ignore" : "inherit",
      stdout: capture ? "pipe" : "inherit",
      stderr: "inherit",
      windowsVerbatimArguments: verbatim,
    });
    if (run.exitCode === null) return new Error(`it was stopped by ${run.signalCode}`);
    return { code: run.exitCode, stdout: capture ? (run.stdout?.toString() ?? "") : "" };
  } catch (error) {
    return error as Error;
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
      removeCommand(first, deps.platform, homedir()),
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

/** How to get the command working again after an update left it unable to start. */
function repairFor(pm: PackageManager, version: string, platform: NodeJS.Platform): string {
  if (platform === "win32" && pm.name === "npm") {
    return (
      "npm puts the Windows command in place with an install script, so with ignore-scripts " +
      "set the command stays the Linux and macOS one. Repair it with:  " +
      "npm rebuild -g --ignore-scripts=false tokenhud"
    );
  }
  if (platform === "win32") {
    return "bun can't run tokenhud's command on Windows; install it with npm or install.ps1 (see the README)";
  }
  return `reinstall it with:  ${installCommand(pm, version).join(" ")}`;
}

interface UpdateOptions {
  readonly check: boolean;
  readonly prerelease: boolean;
  readonly allowDowngrade: boolean;
}

function updateThroughPackageManager(
  pm: PackageManager,
  method: InstallMethod,
  options: UpdateOptions,
  current: Version,
  deps: UpdateDeps,
): number {
  const exe = resolvePackageManager(pm, deps);
  if (exe instanceof Error) {
    deps.err(`can't run ${pm.name}: ${exe.message}`);
    return 1;
  }
  const ask = distTagsCommand(pm);
  const asked = runPackageManager(exe, ask.slice(1), pm, deps, true);
  const tags = asked instanceof Error || asked.code !== 0 ? null : parseDistTags(asked.stdout);
  if (tags === null) {
    const why =
      asked instanceof Error
        ? asked.message
        : asked.code !== 0
          ? `exit ${asked.code}`
          : "its answer isn't the dist-tags";
    deps.err(`couldn't learn tokenhud's versions with ${ask.join(" ")} (${why})`);
    return 1;
  }
  const target = chooseTarget(tags, current, options.prerelease);
  if (target === null) {
    deps.err(`the registry has no ${options.prerelease ? "next" : "latest"} tag for tokenhud`);
    return 1;
  }
  const order = compareVersions(parseVersion(target.version) as Version, current);
  if (order === 0) {
    deps.out(`tokenhud ${deps.version} is up to date (${target.tag})`);
    return 0;
  }
  if (order < 0 && !options.allowDowngrade) {
    deps.out(
      `tokenhud ${deps.version} is newer than tokenhud@${target.tag} (${target.version}); ` +
        `nothing to do. tokenhud update --allow-downgrade installs ${target.version}`,
    );
    return 0;
  }
  const install = installCommand(pm, target.version);
  if (options.check) {
    deps.out(`update available: tokenhud ${deps.version} → ${target.version} (${target.tag})`);
    deps.out(
      `run: tokenhud update${options.prerelease ? " --prerelease" : ""}  (it runs ${install.join(" ")})`,
    );
    return 0;
  }

  deps.out(`running: ${install.join(" ")}`);
  const binary = deps.execPath;
  const parked = deps.platform === "win32" ? park(binary, deps) : null;
  let ran: ReturnType<typeof runPackageManager>;
  try {
    ran = runPackageManager(exe, install.slice(1), pm, deps, false);
  } finally {
    if (parked !== null) unpark(parked, binary, deps);
  }
  if (ran instanceof Error || ran.code !== 0) {
    deps.err(
      ran instanceof Error
        ? `couldn't run ${install.join(" ")}: ${ran.message}`
        : `${install.join(" ")} failed (exit ${ran.code})`,
    );
    return 1;
  }
  const expected = `tokenhud ${target.version}`;
  const says = deps.versionOf(binary);
  if (says !== expected) {
    deps.err(`${install.join(" ")} finished, but ${binary} --version said: ${says}`);
    return 1;
  }
  // The binary is right; the command a shell runs must reach it too.
  const command = deps.versionOf(pm.command);
  if (command !== expected) {
    deps.err(
      `installed tokenhud ${target.version}, but the tokenhud command (${pm.command}) ` +
        `doesn't start it: ${command}`,
    );
    deps.err(repairFor(pm, target.version, deps.platform));
    return 1;
  }
  deps.out(`updated tokenhud ${deps.version} → ${target.version}`);
  warnShadowed(method, deps);
  return 0;
}

export async function runUpdate(
  args: readonly string[],
  deps: UpdateDeps = defaultDeps(),
): Promise<number> {
  let options: UpdateOptions;
  let print: boolean;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        check: { type: "boolean", default: false },
        prerelease: { type: "boolean", default: false },
        "allow-downgrade": { type: "boolean", default: false },
        print: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      deps.out(UPDATE_HELP);
      return 0;
    }
    if (positionals.length > 0) throw new Error(`unexpected argument '${positionals[0]}'`);
    options = {
      check: values.check,
      prerelease: values.prerelease,
      allowDowngrade: values["allow-downgrade"],
    };
    print = values.print;
  } catch (error) {
    deps.err((error as Error).message);
    return 2;
  }
  const { prerelease } = options;

  let prefix: string | null | undefined;
  const npmPrefix = () => {
    if (prefix === undefined) prefix = deps.npmPrefix();
    return prefix;
  };
  const method = installMethod(deps.execPath, deps.compiled, npmPrefix, deps.env);
  if (method.kind === "source") {
    deps.err("this is tokenhud running from source; update the checkout with git pull");
    return 1;
  }
  const current = parseVersion(deps.version);
  const tag = printTag(current, prerelease);
  const pm = packageManagerFor(
    method,
    deps.execPath,
    deps.platform,
    method.kind === "npm" ? npmPrefix() : null,
  );
  const hint = hintFor(method, tag);
  if (print) {
    // Asks nothing over the network: the command names the tag, not its version.
    deps.out(
      pm !== null
        ? installCommand(pm, tag).join(" ")
        : (hint?.command ?? `tokenhud update${prerelease ? " --prerelease" : ""}`),
    );
    return 0;
  }
  if (current === null) {
    deps.err(`can't compare versions: this build's version '${deps.version}' isn't semver`);
    return 1;
  }
  // The package manager's registry, not GitHub, says what it can install.
  if (pm !== null) return updateThroughPackageManager(pm, method, options, current, deps);

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
  if (options.check || hintLine !== null) {
    deps.out(`update available: tokenhud ${deps.version} → ${latest}`);
    if (hintLine !== null) deps.out(hintLine);
    else deps.out(`run: tokenhud update${prerelease ? " --prerelease" : ""}`);
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

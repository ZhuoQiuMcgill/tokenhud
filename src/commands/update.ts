// `tokenhud update`: moves to the newest GitHub release. A standalone binary (install.sh,
// install.ps1) replaces itself; an npm, npx or bunx install is told the command that
// updates it, since its package manager owns the files. Never runs on its own.

import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assetName, targetById } from "../release.ts";
import {
  compareVersions,
  downloadVerified,
  type InstallMethod,
  installMethod,
  isCompiled,
  newestRelease,
  npmGlobalPrefix,
  parseVersion,
  type Release,
  releasesApi,
  replaceBinary,
  stagingPath,
  UpdateError,
  whenFree,
} from "../update.ts";
import { VERSION } from "../version.ts";

export const UPDATE_HELP = `Usage:
  tokenhud update [--check] [--prerelease]

Updates tokenhud to the newest release on GitHub. A binary installed by install.sh or
install.ps1 replaces itself, once the download matches the release's SHA-256 checksums.
For an npm, npx or bunx install, it prints the command that updates it.

Options:
  --check        only report whether an update is available
  --prerelease   include prereleases (release candidates, betas)`;

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
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function versionOf(bin: string): string {
  try {
    // A just-written .exe is locked while Windows scans it; spawning then fails with EBUSY.
    const run = whenFree(() =>
      Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 60_000 }),
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
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`tokenhud update: ${line}\n`),
  };
}

/** The command that updates a package-manager install, or a hint; null for a binary. */
function packageManagerHint(method: InstallMethod, tag: "latest" | "next"): string | null {
  switch (method.kind) {
    case "npm":
      return method.global
        ? `installed with npm; update with:  npm install -g tokenhud@${tag}`
        : `installed as a project dependency; in that project run:  npm install tokenhud@${tag}`;
    case "bun-global":
      return `installed with bun; update with:  bun add -g tokenhud@${tag}`;
    case "npx":
      return `run through npx, which keeps a cached copy; for the newest one run:  npx tokenhud@${tag}`;
    case "bunx":
      return `run through bunx, which keeps a cached copy; for the newest one run:  bunx tokenhud@${tag}`;
    default:
      return null;
  }
}

export async function runUpdate(
  args: readonly string[],
  deps: UpdateDeps = defaultDeps(),
): Promise<number> {
  let check: boolean;
  let prerelease: boolean;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        check: { type: "boolean", default: false },
        prerelease: { type: "boolean", default: false },
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
  } catch (error) {
    deps.err((error as Error).message);
    return 2;
  }

  const method = installMethod(deps.execPath, deps.compiled, deps.npmPrefix);
  if (method.kind === "source") {
    deps.err("this is tokenhud running from source; update the checkout with git pull");
    return 1;
  }
  const hint = packageManagerHint(method, prerelease ? "next" : "latest");
  const current = parseVersion(deps.version);
  if (current === null) {
    deps.err(`can't compare versions: this build's version '${deps.version}' isn't semver`);
    return 1;
  }

  let release: Release | null;
  try {
    release = await newestRelease(releasesApi(deps.env), prerelease, deps.fetch);
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    deps.err(error.message);
    if (hint !== null) deps.out(hint);
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
  if (check || hint !== null) {
    deps.out(`update available: tokenhud ${deps.version} → ${latest}`);
    if (hint !== null) deps.out(hint);
    else deps.out(`run: tokenhud update${prerelease ? " --prerelease" : ""}`);
    return 0;
  }
  return selfUpdate(release, latest, deps);
}

async function selfUpdate(release: Release, latest: string, deps: UpdateDeps): Promise<number> {
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
    const bytes = await downloadVerified(release, name, staging, deps.fetch);
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

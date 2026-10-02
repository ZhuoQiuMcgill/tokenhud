// The pieces of `tokenhud update` (src/commands/update.ts): how this copy of tokenhud was
// installed, which release is the newest on GitHub, replacing the binary with a downloaded
// one only once its SHA-256 matches the release's SHA256SUMS, and the command that updates
// a bun or npm install through its package manager.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { REPO, SUMS_FILE, sumFor } from "./release.ts";
import { VERSION } from "./version.ts";

// ── versions ────────────────────────────────────────────────────────────────────────

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease identifiers (`rc.1` → ["rc", 1]); empty for a release. */
  readonly pre: readonly (string | number)[];
}

/** A semver version, with or without a leading `v`; build metadata is ignored. Null if not one. */
export function parseVersion(text: string): Version | null {
  const m =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      text.trim(),
    );
  if (m === null) return null;
  const pre = m[4] === undefined ? [] : m[4].split(".");
  if (pre.some((id) => id === "")) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: pre.map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  };
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  // A release ranks above its prereleases.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i] as string | number;
    const y = b.pre[i] as string | number;
    if (x === y) continue;
    // Numeric identifiers rank below alphanumeric ones.
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

// ── install method ──────────────────────────────────────────────────────────────────

export type InstallMethod =
  /** `bun src/cli.ts`: a checkout. */
  | { readonly kind: "source" }
  | { readonly kind: "npx" }
  | { readonly kind: "bunx" }
  /** `bun add -g`: under `<root>/install/global`, where root is BUN_INSTALL (~/.bun by default). */
  | { readonly kind: "bun-global"; readonly root: string }
  /** npm, globally (under `npm prefix -g`) or as a project's dependency. */
  | { readonly kind: "npm"; readonly global: boolean }
  /** A standalone binary: install.sh, install.ps1, a download, or a local build. */
  | { readonly kind: "binary" };

/** Whether this process is a compiled binary rather than Bun running src/. */
export function isCompiled(main: string = Bun.main): boolean {
  return /^(?:\/\$bunfs\/|[A-Za-z]:[/\\]~BUN[/\\])/.test(main);
}

const isWindowsPath = (path: string) => /^[A-Za-z]:[/\\]/.test(path);

/**
 * The bun install root (BUN_INSTALL) whose global packages (`<root>/install/global`) hold
 * `path`, or null: `~/.bun`, or wherever BUN_INSTALL points. Returned as `path` spells it.
 */
export function bunGlobalRoot(path: string, bunInstall: string | undefined): string | null {
  const slashed = path.replaceAll("\\", "/");
  const at = slashed.indexOf("/install/global/node_modules/");
  if (at < 0) return null;
  const root = slashed.slice(0, at);
  const custom = bunInstall?.replaceAll("\\", "/").replace(/\/+$/, "");
  const fold = (p: string) => (isWindowsPath(path) ? p.toLowerCase() : p);
  if (root.endsWith("/.bun") || (custom && fold(root) === fold(custom))) return path.slice(0, at);
  return null;
}

/**
 * How this copy was installed, from where its binary lives. The npm launcher runs the binary
 * from its platform package (`node_modules/@tokenhud/<platform>/bin/`), so that path tells
 * the package manager apart: npx and bunx keep packages in their caches, `bun add -g` in
 * `~/.bun/install/global` (or BUN_INSTALL's), and npm everywhere else, globally when under
 * its prefix. `npmPrefix` is `npm prefix -g`, asked only when the answer depends on it.
 */
export function installMethod(
  execPath: string,
  compiled: boolean,
  npmPrefix: () => string | null,
  env: Readonly<Record<string, string | undefined>> = {},
): InstallMethod {
  if (!compiled) return { kind: "source" };
  const path = execPath.replaceAll("\\", "/");
  if (!/\/node_modules\/@tokenhud\/[^/]+\/bin\/[^/]+$/.test(path)) return { kind: "binary" };
  if (path.includes("/_npx/")) return { kind: "npx" };
  if (/\/bunx-[^/]*\//.test(path) || path.includes("/.bun/install/cache/")) return { kind: "bunx" };
  const root = bunGlobalRoot(execPath, env.BUN_INSTALL);
  if (root !== null) return { kind: "bun-global", root };
  const prefix = npmPrefix()?.replaceAll("\\", "/").replace(/\/+$/, "");
  // Without npm to ask, a global install is the likelier one.
  if (prefix === undefined || prefix === "") return { kind: "npm", global: true };
  const under = isWindowsPath(path)
    ? path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    : path.startsWith(`${prefix}/`);
  return { kind: "npm", global: under };
}

/** The platform package a binary in node_modules comes from (`@tokenhud/linux-x64`), or null. */
export function platformPackageOf(execPath: string): string | null {
  const m = /\/node_modules\/(@tokenhud\/[^/]+)\/bin\/[^/]+$/.exec(execPath.replaceAll("\\", "/"));
  return m === null ? null : (m[1] as string);
}

/** A package-manager command that updates tokenhud. */
export interface PackageManagerUpdate {
  /** The command, as typed: its first word is looked up on PATH. */
  readonly argv: readonly string[];
  /** Variables it runs with, over the environment. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The command that updates a global bun or npm install to the `tag` dist-tag, or null for
 * other installs. The musl packages are not dependencies of tokenhud (scripts/stage-npm.ts
 * says why), so a musl binary's package is named too.
 */
export function packageManagerUpdate(
  method: InstallMethod,
  tag: "latest" | "next",
  platformPackage: string | null,
): PackageManagerUpdate | null {
  const extra = platformPackage?.endsWith("-musl") ? [`${platformPackage}@${tag}`] : [];
  if (method.kind === "bun-global") {
    return {
      // --no-cache: bun otherwise answers from a registry reply it keeps for minutes, and
      // would miss a release that new.
      argv: ["bun", "add", "-g", "--no-cache", `tokenhud@${tag}`, ...extra],
      // The bun install that holds this copy, whatever BUN_INSTALL the shell has.
      env: { BUN_INSTALL: method.root },
    };
  }
  if (method.kind === "npm" && method.global) {
    return { argv: ["npm", "install", "-g", `tokenhud@${tag}`, ...extra], env: {} };
  }
  return null;
}

/** `npm prefix -g`, or null when npm can't be run. */
export function npmGlobalPrefix(): string | null {
  // npm is a .cmd script on Windows, which only cmd.exe can start.
  const cmd =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", "npm prefix -g"]
      : ["npm", "prefix", "-g"];
  try {
    const out = Bun.spawnSync(cmd, {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
    });
    const text = out.stdout.toString().trim();
    return out.exitCode === 0 && text !== "" ? text : null;
  } catch {
    return null;
  }
}

// ── releases ────────────────────────────────────────────────────────────────────────

export interface Release {
  readonly tag: string;
  readonly version: Version;
  readonly prerelease: boolean;
  /** Asset name → download URL. */
  readonly assets: ReadonlyMap<string, string>;
}

export class UpdateError extends Error {}

/** GitHub's REST API for the repository. */
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${REPO}`;

/** Where releases come from. */
export interface ReleaseSource {
  readonly api: string;
  /** TOKENHUD_RELEASES_API points away from GitHub: the caller must say so. */
  readonly overridden: boolean;
  /** TOKENHUD_INSECURE_TEST=1: plain http:// is allowed, for tests against a local server. */
  readonly insecure: boolean;
}

/** Throws unless `url` is https://, or http:// with `insecure`. */
export function requireHttps(url: string, what: string, insecure: boolean): void {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new UpdateError(`${what} is not a URL: ${url}`);
  }
  if (scheme === "https:" || (insecure && scheme === "http:")) return;
  throw new UpdateError(
    `${what} must be an https:// URL, not ${url} (TOKENHUD_INSECURE_TEST=1 allows http:// for tests)`,
  );
}

/**
 * GitHub's API, or TOKENHUD_RELEASES_API for tests. An override must be https:// unless
 * TOKENHUD_INSECURE_TEST=1. Its SHA256SUMS comes from the same server as its binaries, so
 * callers warn whenever it is set.
 */
export function releaseSource(env: Readonly<Record<string, string | undefined>>): ReleaseSource {
  const insecure = env.TOKENHUD_INSECURE_TEST === "1";
  const api = (env.TOKENHUD_RELEASES_API || GITHUB_RELEASES_API).replace(/\/+$/, "");
  const overridden = api !== GITHUB_RELEASES_API;
  if (overridden) requireHttps(api, "TOKENHUD_RELEASES_API", insecure);
  return { api, overridden, insecure };
}

const HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": `tokenhud/${VERSION}`,
  "x-github-api-version": "2022-11-28",
};

function toRelease(raw: unknown): Release | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.draft === true || typeof r.tag_name !== "string") return null;
  const version = parseVersion(r.tag_name);
  if (version === null) return null;
  const assets = new Map<string, string>();
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    const { name, browser_download_url: url } = (a ?? {}) as Record<string, unknown>;
    if (typeof name === "string" && typeof url === "string") assets.set(name, url);
  }
  return { tag: r.tag_name, version, prerelease: r.prerelease === true, assets };
}

async function getJson(url: string, fetchFn: typeof fetch, insecure: boolean): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new UpdateError(`can't reach ${new URL(url).host}: ${(error as Error).message}`);
  }
  if (res.url !== "") requireHttps(res.url, "the releases API", insecure);
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    throw new UpdateError("GitHub's API rate limit was hit; try again in an hour");
  }
  if (!res.ok) throw new UpdateError(`${url} answered HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new UpdateError(`${url} didn't answer with JSON`);
  }
}

/**
 * The newest release: GitHub's "latest" (never a prerelease), or with `prerelease` the
 * highest version among the recent releases, prereleases included. Null when there is none.
 */
export async function newestRelease(
  source: ReleaseSource,
  prerelease: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<Release | null> {
  const { api, insecure } = source;
  if (!prerelease) return toRelease(await getJson(`${api}/releases/latest`, fetchFn, insecure));
  const list = await getJson(`${api}/releases?per_page=30`, fetchFn, insecure);
  const releases = (Array.isArray(list) ? list : []).map(toRelease).filter((r) => r !== null);
  return releases.reduce<Release | null>(
    (best, r) => (best === null || compareVersions(r.version, best.version) > 0 ? r : best),
    null,
  );
}

// ── download and replace ────────────────────────────────────────────────────────────

async function fetchOk(url: string, fetchFn: typeof fetch, timeoutMs: number, insecure: boolean) {
  requireHttps(url, "a release download", insecure);
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "user-agent": HEADERS["user-agent"] },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpdateError(`can't reach ${new URL(url).host}: ${(error as Error).message}`);
  }
  // Where the redirects (GitHub sends assets to its CDN) ended up must be https:// too.
  if (res.url !== "") requireHttps(res.url, "a release download", insecure);
  if (res.status === 404) throw new UpdateError(`${url} is not there (HTTP 404)`);
  if (!res.ok || res.body === null) throw new UpdateError(`${url} answered HTTP ${res.status}`);
  return res;
}

/**
 * Downloads release asset `name` to `dest` and checks it against the release's SHA256SUMS.
 * On any failure `dest` is gone. Returns the size in bytes.
 */
export async function downloadVerified(
  release: Release,
  name: string,
  dest: string,
  fetchFn: typeof fetch = fetch,
  insecure = false,
): Promise<number> {
  const url = release.assets.get(name);
  const sumsUrl = release.assets.get(SUMS_FILE);
  if (url === undefined) throw new UpdateError(`release ${release.tag} has no ${name}`);
  if (sumsUrl === undefined) throw new UpdateError(`release ${release.tag} has no ${SUMS_FILE}`);
  const sums = await (await fetchOk(sumsUrl, fetchFn, 30_000, insecure)).text();
  const expected = sumFor(sums, name);
  if (expected === null) throw new UpdateError(`${SUMS_FILE} of ${release.tag} lists no ${name}`);

  const res = await fetchOk(url, fetchFn, 15 * 60_000, insecure);
  const hasher = new Bun.CryptoHasher("sha256");
  // An explicit handle, closed before anything runs the file: Windows refuses to start an
  // .exe that is still open for writing (EBUSY).
  const file = await open(dest, "w");
  let bytes = 0;
  try {
    for await (const chunk of res.body as ReadableStream<Uint8Array>) {
      hasher.update(chunk);
      // The hash covers the bytes received, so every one of them must reach the file.
      for (let at = 0; at < chunk.byteLength; ) {
        at += (await file.write(chunk, at)).bytesWritten;
      }
      bytes += chunk.byteLength;
    }
  } catch (error) {
    await file.close();
    rmSync(dest, { force: true });
    throw new UpdateError(`download failed: ${(error as Error).message}`);
  }
  await file.close();
  const actual = hasher.digest("hex");
  if (actual !== expected) {
    rmSync(dest, { force: true });
    throw new UpdateError(
      `${name} failed its checksum (expected ${expected}, got ${actual}); nothing was changed`,
    );
  }
  return bytes;
}

/** Where the new binary is written first: beside the old one, so the swap is a rename. */
export function stagingPath(exe: string, platform: NodeJS.Platform = process.platform): string {
  const dir = dirname(exe);
  return platform === "win32"
    ? join(dir, `tokenhud-update-${process.pid}.exe`)
    : join(dir, `.tokenhud-update-${process.pid}`);
}

/**
 * Runs `fn`, retrying for up to 15 s while Windows reports the file busy: its antivirus scans
 * a newly written .exe, and briefly holds one that just ran, locking it meanwhile. Other
 * platforms, and other errors, fail at once.
 */
export function whenFree<T>(fn: () => T, platform: NodeJS.Platform = process.platform): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const busy = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (platform !== "win32" || !busy || attempt >= 60) throw error;
      Bun.sleepSync(250);
    }
  }
}

/**
 * Puts `fresh` in place of `exe` atomically. POSIX renames over the old file (running
 * copies keep theirs). Windows can't replace a running .exe but can rename it, so the old
 * one is parked as `<exe>.old` first (deleted on the next start, `removeStaleOld`), and
 * put back if the new one can't take its place.
 */
export function replaceBinary(
  exe: string,
  fresh: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    renameSync(fresh, exe);
    return;
  }
  let parked = `${exe}.old`;
  try {
    rmSync(parked, { force: true });
  } catch {
    // Still running from an earlier update: park this one under its own name.
    parked = `${exe}.${Date.now()}.old`;
  }
  whenFree(() => renameSync(exe, parked), platform);
  try {
    whenFree(() => renameSync(fresh, exe), platform);
  } catch (error) {
    whenFree(() => renameSync(parked, exe), platform);
    throw error;
  }
}

/**
 * Where a package manager's update parks this .exe on Windows: beside the package tree
 * (`~/.bun/install/global`, npm's prefix), outside it. Null for a binary not in one.
 *
 * Windows can't delete a running .exe but can move it. Left in its package, it stops the
 * package manager from removing the old package: npm (10.9) then warns and leaves the whole
 * old copy behind for good. Moved out first, the package is free to replace, for npm and
 * bun alike; the next start deletes the parked file (`removeStaleOld`).
 */
export function parkingPath(exe: string, pid: number = process.pid): string | null {
  const at = exe.replaceAll("\\", "/").indexOf("/node_modules/");
  return at < 0 ? null : join(exe.slice(0, at), `tokenhud-update-${pid}.old`);
}

const PARKED = /^tokenhud-update-\d+\.old$/;

/** Deletes the files in `dir` that `stale` picks; ignores locked ones. */
function sweep(dir: string, stale: (name: string) => boolean): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!stale(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Still running (a TUI or MCP server started before the update); next time.
    }
  }
}

/**
 * Deletes what updates on Windows left behind: `<exe>.old` and `<exe>.<n>.old` beside a
 * standalone binary, and the .exe a package manager's update parked (`parkingPath`).
 * Ignores locked ones.
 */
export function removeStaleOld(exe: string): void {
  const base = basename(exe);
  sweep(
    dirname(exe),
    (name) => name.startsWith(`${base}.`) && /^\.(?:\d+\.)?old$/.test(name.slice(base.length)),
  );
  const parked = parkingPath(exe);
  if (parked !== null) sweep(dirname(parked), (name) => PARKED.test(name));
}

// ── the TUI's update note ───────────────────────────────────────────────────────────

/** How often the TUI may ask GitHub about a new release. */
export const CHECK_INTERVAL_MS = 24 * 3_600_000;

interface CheckState {
  /** Epoch ms of the last time GitHub was asked. */
  readonly checked_at: number;
  /** The newest release then (prereleases included for a prerelease build), or null. */
  readonly latest: string | null;
}

function readCheckState(path: string): CheckState | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const { checked_at, latest } = raw as Record<string, unknown>;
    if (typeof checked_at !== "number" || !Number.isFinite(checked_at)) return null;
    return { checked_at, latest: typeof latest === "string" ? latest : null };
  } catch {
    return null;
  }
}

function writeCheckState(path: string, state: CheckState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`);
    renameSync(tmp, path);
  } catch {
    // Only costs an extra check tomorrow.
  }
}

export interface UpdateCheck {
  /** `update-check.json` in the config dir: when GitHub was last asked, and its answer. */
  readonly statePath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly now: number;
  readonly fetch?: typeof fetch;
}

/**
 * A newer release for the TUI to mention, or null. Asks GitHub at most once a day (a failed
 * ask counts too) and otherwise answers from the last answer. A prerelease build hears about
 * prereleases; a release build only about releases. Never throws.
 */
export async function availableUpdate(check: UpdateCheck): Promise<string | null> {
  const current = parseVersion(check.version);
  if (current === null) return null;
  const state = readCheckState(check.statePath);
  let latest = state?.latest ?? null;
  const fresh =
    state !== null &&
    state.checked_at <= check.now &&
    check.now - state.checked_at < CHECK_INTERVAL_MS;
  if (!fresh) {
    try {
      // An override that isn't https:// throws here, so the TUI never asks it.
      const release = await newestRelease(
        releaseSource(check.env),
        current.pre.length > 0,
        check.fetch ?? fetch,
      );
      latest = release === null ? null : release.tag.replace(/^v/, "");
    } catch {
      // Offline or rate-limited: keep the last answer, and try again tomorrow.
    }
    writeCheckState(check.statePath, { checked_at: check.now, latest });
  }
  const newest = latest === null ? null : parseVersion(latest);
  return newest !== null && compareVersions(newest, current) > 0 ? latest : null;
}

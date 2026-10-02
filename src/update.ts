// The pieces of `tokenhud update` (src/commands/update.ts): how this copy of tokenhud was
// installed, which release is the newest on GitHub, and replacing the binary with a
// downloaded one only once its SHA-256 matches the release's SHA256SUMS.

import { readdirSync, renameSync, rmSync } from "node:fs";
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
  | { readonly kind: "bun-global" }
  /** npm, globally (under `npm prefix -g`) or as a project's dependency. */
  | { readonly kind: "npm"; readonly global: boolean }
  /** A standalone binary: install.sh, install.ps1, a download, or a local build. */
  | { readonly kind: "binary" };

/** Whether this process is a compiled binary rather than Bun running src/. */
export function isCompiled(main: string = Bun.main): boolean {
  return /^(?:\/\$bunfs\/|[A-Za-z]:[/\\]~BUN[/\\])/.test(main);
}

/**
 * How this copy was installed, from where its binary lives. The npm launcher runs the binary
 * from its platform package (`node_modules/@tokenhud/<platform>/bin/`), so that path tells
 * the package manager apart: npx and bunx keep packages in their caches, `bun add -g` in
 * `~/.bun/install/global`, and npm everywhere else, globally when under its prefix.
 * `npmPrefix` is `npm prefix -g`, asked only when the answer depends on it.
 */
export function installMethod(
  execPath: string,
  compiled: boolean,
  npmPrefix: () => string | null,
): InstallMethod {
  if (!compiled) return { kind: "source" };
  const path = execPath.replaceAll("\\", "/");
  if (!/\/node_modules\/@tokenhud\/[^/]+\/bin\/[^/]+$/.test(path)) return { kind: "binary" };
  if (path.includes("/_npx/")) return { kind: "npx" };
  if (/\/bunx-[^/]*\//.test(path) || path.includes("/.bun/install/cache/")) return { kind: "bunx" };
  if (path.includes("/.bun/install/global/")) return { kind: "bun-global" };
  const prefix = npmPrefix()?.replaceAll("\\", "/").replace(/\/+$/, "");
  // Without npm to ask, a global install is the likelier one.
  if (prefix === undefined || prefix === "") return { kind: "npm", global: true };
  const windows = /^[A-Za-z]:\//.test(path);
  const under = windows
    ? path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    : path.startsWith(`${prefix}/`);
  return { kind: "npm", global: under };
}

/** `npm prefix -g`, or null when npm can't be run. */
export function npmGlobalPrefix(): string | null {
  // npm is a .cmd script on Windows, which only cmd.exe can start.
  const cmd =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", "npm prefix -g"]
      : ["npm", "prefix", "-g"];
  try {
    const out = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
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

/** GitHub's REST API for the repository; tests point TOKENHUD_RELEASES_API at a fake one. */
export function releasesApi(env: Readonly<Record<string, string | undefined>>): string {
  return (env.TOKENHUD_RELEASES_API || `https://api.github.com/repos/${REPO}`).replace(/\/+$/, "");
}

export class UpdateError extends Error {}

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

async function getJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new UpdateError(`can't reach ${new URL(url).host}: ${(error as Error).message}`);
  }
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
  api: string,
  prerelease: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<Release | null> {
  if (!prerelease) return toRelease(await getJson(`${api}/releases/latest`, fetchFn));
  const list = await getJson(`${api}/releases?per_page=30`, fetchFn);
  const releases = (Array.isArray(list) ? list : []).map(toRelease).filter((r) => r !== null);
  return releases.reduce<Release | null>(
    (best, r) => (best === null || compareVersions(r.version, best.version) > 0 ? r : best),
    null,
  );
}

// ── download and replace ────────────────────────────────────────────────────────────

async function fetchOk(url: string, fetchFn: typeof fetch, timeoutMs: number) {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "user-agent": HEADERS["user-agent"] },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpdateError(`download failed: ${(error as Error).message}`);
  }
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
): Promise<number> {
  const url = release.assets.get(name);
  const sumsUrl = release.assets.get(SUMS_FILE);
  if (url === undefined) throw new UpdateError(`release ${release.tag} has no ${name}`);
  if (sumsUrl === undefined) throw new UpdateError(`release ${release.tag} has no ${SUMS_FILE}`);
  const sums = await (await fetchOk(sumsUrl, fetchFn, 30_000)).text();
  const expected = sumFor(sums, name);
  if (expected === null) throw new UpdateError(`${SUMS_FILE} of ${release.tag} lists no ${name}`);

  const res = await fetchOk(url, fetchFn, 15 * 60_000);
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

/** Deletes `<exe>.old` and `<exe>.<n>.old` left by an update on Windows; ignores locked ones. */
export function removeStaleOld(exe: string): void {
  const base = basename(exe);
  let names: string[];
  try {
    names = readdirSync(dirname(exe));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.`) || !/^\.(?:\d+\.)?old$/.test(name.slice(base.length))) {
      continue;
    }
    try {
      rmSync(join(dirname(exe), name), { force: true });
    } catch {
      // Still running (a TUI or MCP server started before the update); next time.
    }
  }
}

// What a release is made of: the platforms tokenhud ships binaries for, and how each one's
// release asset, Bun compile target and npm package are named. scripts/build.ts builds
// these, the npm staging script packages them, and `tokenhud update` downloads the one it
// is running as.

/** The GitHub repository releases are published to. */
export const REPO = "ZhuoQiuMcgill/tokenhud";

export interface ReleaseTarget {
  /** As release assets name it: `windows`, not Node's `win32`. */
  readonly os: "linux" | "darwin" | "windows";
  readonly arch: "x64" | "arm64";
  readonly musl: boolean;
}

/**
 * Every target, in the order builds and listings show them. "linux-x64-musl" and the like
 * are the `id`s: the asset name without `tokenhud-` and `.exe`.
 */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { os: "linux", arch: "x64", musl: false },
  { os: "linux", arch: "arm64", musl: false },
  { os: "linux", arch: "x64", musl: true },
  { os: "linux", arch: "arm64", musl: true },
  { os: "darwin", arch: "x64", musl: false },
  { os: "darwin", arch: "arm64", musl: false },
  { os: "windows", arch: "x64", musl: false },
  { os: "windows", arch: "arm64", musl: false },
];

export function targetId(t: ReleaseTarget): string {
  return `${t.os}-${t.arch}${t.musl ? "-musl" : ""}`;
}

/** `tokenhud-linux-x64-musl`, `tokenhud-windows-arm64.exe`. */
export function assetName(t: ReleaseTarget): string {
  return `tokenhud-${targetId(t)}${t.os === "windows" ? ".exe" : ""}`;
}

export function bunTarget(t: ReleaseTarget): Bun.Build.CompileTarget {
  return `bun-${targetId(t)}` as Bun.Build.CompileTarget;
}

/** Node's `process.platform` for the target, which npm's `os` field and the shim use. */
export function nodePlatform(t: ReleaseTarget): "linux" | "darwin" | "win32" {
  return t.os === "windows" ? "win32" : t.os;
}

/**
 * The npm package holding the target's binary. Named after Node's platform (`win32-x64`),
 * as npm platform packages conventionally are, so the shim can look one up from
 * `process.platform` and `process.arch` directly.
 */
export function npmPackage(t: ReleaseTarget): string {
  return `@tokenhud/${nodePlatform(t)}-${t.arch}${t.musl ? "-musl" : ""}`;
}

export function targetById(id: string): ReleaseTarget | undefined {
  return RELEASE_TARGETS.find((t) => targetId(t) === id);
}

/** The file the checksums of a release's assets are in, as `sha256sum` writes them. */
export const SUMS_FILE = "SHA256SUMS";

/** `<hex>  <name>` lines, sorted by name, as `sha256sum` prints and `sha256sum -c` reads. */
export function formatSums(sums: ReadonlyMap<string, string>): string {
  return [...sums]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, hex]) => `${hex}  ${name}\n`)
    .join("");
}

/**
 * The checksum listed for `name`, or null. Accepts `sha256sum`'s text (`<hex>  <name>`) and
 * binary (`<hex> *<name>`) forms.
 */
export function sumFor(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m !== null && m[2] === name) return (m[1] as string).toLowerCase();
  }
  return null;
}

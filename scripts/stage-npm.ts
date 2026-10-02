// Stages the npm packages from the release binaries in dist/, ready for `npm pack` or
// `npm publish`:
//
//   dist/npm/<platform>/   @tokenhud/<platform>: one binary, with os, cpu and libc set so
//                          a package manager installs it only where it runs
//   dist/npm/tokenhud/     tokenhud: the launcher (npm/tokenhud/bin/tokenhud.cjs) and its
//                          preinstall, with the platform packages as optional dependencies at
//                          this exact version
//
//   bun scripts/stage-npm.ts      # after `bun run build --release`
//
// The musl packages are not among the launcher's dependencies. Bun (1.4.2) ignores `libc`
// and filters optional dependencies by `os` and `cpu` only, so it would download a musl
// binary beside the glibc one on every Linux machine. On Alpine, the musl package is
// installed by name beside tokenhud; the launcher says so.
//
// Publish the platform packages first: the launcher's dependencies must exist when it lands.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { description, version as packageVersion } from "../package.json";
import {
  assetName,
  nodePlatform,
  npmPackage,
  RELEASE_TARGETS,
  REPO,
  type ReleaseTarget,
} from "../src/release.ts";

const root = join(import.meta.dir, "..");

const common = {
  license: "MIT",
  homepage: `https://github.com/${REPO}#readme`,
  repository: { type: "git", url: `git+https://github.com/${REPO}.git` },
  bugs: { url: `https://github.com/${REPO}/issues` },
};

const OS_NAMES = { linux: "Linux", darwin: "macOS", windows: "Windows" } as const;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface StageOptions {
  /** Where the release binaries (`tokenhud-<id>[.exe]`) are; dist/ by default. */
  readonly dist?: string;
  /** Where the packages go, emptied first; dist/npm/ by default. */
  readonly out?: string;
  /** The packages' version; package.json's by default. */
  readonly version?: string;
  /** The platform packages to stage; every release target by default. */
  readonly targets?: readonly ReleaseTarget[];
}

function stagePlatform(t: ReleaseTarget, dist: string, out: string, version: string): string {
  const name = npmPackage(t);
  const dir = join(out, name.slice("@tokenhud/".length));
  const exe = t.os === "windows" ? "tokenhud.exe" : "tokenhud";
  const binary = join(dist, assetName(t));
  if (!existsSync(binary)) throw new Error(`${relative(root, binary)} is missing`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(binary, join(dir, "bin", exe));
  chmodSync(join(dir, "bin", exe), 0o755);
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  const what = `${OS_NAMES[t.os]} ${t.arch}${t.musl ? " (musl)" : ""}`;
  const install = t.musl
    ? `On musl Linux, install it beside [\`tokenhud\`](https://www.npmjs.com/package/tokenhud): \`bun add -g ${name} tokenhud\` or \`npm install -g ${name} tokenhud\`.`
    : `Install [\`tokenhud\`](https://www.npmjs.com/package/tokenhud), which picks the right one of these.`;
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}\n\nThe tokenhud binary for ${what}. ${install}\n`,
  );
  writeJson(join(dir, "package.json"), {
    name,
    version,
    ...common,
    description: `The tokenhud binary for ${what}`,
    os: [nodePlatform(t)],
    cpu: [t.arch],
    ...(t.os === "linux" ? { libc: [t.musl ? "musl" : "glibc"] } : {}),
    files: [`bin/${exe}`],
    preferUnplugged: true,
  });
  return dir;
}

function stageLauncher(out: string, version: string): string {
  const dir = join(out, "tokenhud");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const shim = join(dir, "bin", "tokenhud.cjs");
  copyFileSync(join(root, "npm", "tokenhud", "bin", "tokenhud.cjs"), shim);
  chmodSync(shim, 0o755);
  copyFileSync(join(root, "npm", "tokenhud", "preinstall.cjs"), join(dir, "preinstall.cjs"));
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(root, "README.md"), join(dir, "README.md"));
  writeJson(join(dir, "package.json"), {
    name: "tokenhud",
    version,
    ...common,
    description,
    keywords: ["claude", "claude-code", "codex", "usage", "rate-limits", "tui", "mcp"],
    bin: { tokenhud: "bin/tokenhud.cjs" },
    files: ["bin/tokenhud.cjs", "preinstall.cjs"],
    scripts: { preinstall: "node preinstall.cjs" },
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(
      RELEASE_TARGETS.filter((t) => !t.musl).map((t) => [npmPackage(t), version]),
    ),
  });
  return dir;
}

/** Stages the packages; returns their directories, the launcher's last. */
export function stageNpm(options: StageOptions = {}): string[] {
  const dist = options.dist ?? join(root, "dist");
  const out = options.out ?? join(dist, "npm");
  const version = options.version ?? packageVersion;
  rmSync(out, { recursive: true, force: true });
  const dirs = (options.targets ?? RELEASE_TARGETS).map((t) =>
    stagePlatform(t, dist, out, version),
  );
  return [...dirs, stageLauncher(out, version)];
}

if (import.meta.main) {
  for (const dir of stageNpm()) console.log(`staged ${relative(root, dir)}`);
}

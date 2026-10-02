// Stages the npm packages from the release binaries in dist/, ready for `npm pack` or
// `npm publish`:
//
//   dist/npm/<platform>/   @tokenhud/<platform>: one binary, with os, cpu and libc set so
//                          npm installs it only where it runs
//   dist/npm/tokenhud/     tokenhud: the launcher (npm/tokenhud/bin/tokenhud.cjs), with every
//                          platform package as an optional dependency at this exact version
//
//   bun scripts/stage-npm.ts      # after `bun run build --release`
//
// Publish the platform packages first: the launcher's dependencies must exist when it lands.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { description, version } from "../package.json";
import {
  assetName,
  nodePlatform,
  npmPackage,
  RELEASE_TARGETS,
  REPO,
  type ReleaseTarget,
} from "../src/release.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const out = join(dist, "npm");

const common = {
  version,
  license: "MIT",
  homepage: `https://github.com/${REPO}#readme`,
  repository: { type: "git", url: `git+https://github.com/${REPO}.git` },
  bugs: { url: `https://github.com/${REPO}/issues` },
};

const OS_NAMES = { linux: "Linux", darwin: "macOS", windows: "Windows" } as const;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stagePlatform(t: ReleaseTarget): string {
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
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}\n\nThe tokenhud binary for ${what}. Install [\`tokenhud\`](https://www.npmjs.com/package/tokenhud), which picks the right one of these.\n`,
  );
  writeJson(join(dir, "package.json"), {
    name,
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

function stageLauncher(): string {
  const dir = join(out, "tokenhud");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const shim = join(dir, "bin", "tokenhud.cjs");
  copyFileSync(join(root, "npm", "tokenhud", "bin", "tokenhud.cjs"), shim);
  chmodSync(shim, 0o755);
  copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(root, "README.md"), join(dir, "README.md"));
  writeJson(join(dir, "package.json"), {
    name: "tokenhud",
    ...common,
    description,
    keywords: ["claude", "claude-code", "codex", "usage", "rate-limits", "tui", "mcp"],
    bin: { tokenhud: "bin/tokenhud.cjs" },
    files: ["bin/tokenhud.cjs"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(RELEASE_TARGETS.map((t) => [npmPackage(t), version])),
  });
  return dir;
}

rmSync(out, { recursive: true, force: true });
for (const t of RELEASE_TARGETS) console.log(`staged ${relative(root, stagePlatform(t))}`);
console.log(`staged ${relative(root, stageLauncher())}`);

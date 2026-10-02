// `bun add -g tokenhud` and `npm install -g tokenhud` end to end: this platform's packages,
// staged by scripts/stage-npm.ts and packed by `bun pm pack`, served by a fake npm registry
// on localhost (fake-npm.ts) beside a document for every other platform's package. Skipped
// unless pointed at two builds for this machine:
//
//   TOKENHUD_NPM_E2E_NEW=dist/tokenhud     this commit's build
//   TOKENHUD_NPM_E2E_OLD=old/tokenhud      a build that says it is 0.0.1, to update from
//
// bun runs with no Node on PATH, npm with no Bun on it. Each installs version 0.0.1, runs
// `tokenhud --version`, `doctor` and `update --print`, then `tokenhud update` moves it to
// this version through the package manager. Everything goes to temp dirs: BUN_INSTALL,
// npm's prefix, cache and config, HOME and the tokenhud config.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { stageNpm } from "../../scripts/stage-npm.ts";
import {
  assetName,
  nodePlatform,
  npmPackage,
  RELEASE_TARGETS,
  type ReleaseTarget,
  targetById,
} from "../../src/release.ts";
import { VERSION } from "../../src/version.ts";
import { guard } from "../guard.ts";
import { type FakeNpm, type FakeNpmPackage, fakeNpm } from "./fake-npm.ts";

guard();

const NEW = process.env.TOKENHUD_NPM_E2E_NEW;
const OLD = process.env.TOKENHUD_NPM_E2E_OLD;
const OLD_VERSION = "0.0.1";
const windows = process.platform === "win32";
const SLOW = 300_000;

/** The release target this machine runs. */
function hostTarget(): ReleaseTarget {
  const os = windows ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const musl =
    os === "linux" && existsSync(`/lib/ld-musl-${arch === "x64" ? "x86_64" : "aarch64"}.so.1`);
  const t = targetById(`${os}-${arch}${musl ? "-musl" : ""}`);
  if (t === undefined) throw new Error(`no release target for ${os}-${arch}`);
  return t;
}

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

// Always async: the fake registry answers from this process's event loop.
async function run(cmd: string[], env: Record<string, string>, cwd?: string): Promise<Ran> {
  // npm is npm.cmd on Windows, which only cmd.exe runs.
  const shim = windows && /\.(?:cmd|bat)$/i.test(cmd[0] as string);
  const argv = shim
    ? [
        process.env.ComSpec ?? "cmd.exe",
        "/d",
        "/s",
        "/c",
        `""${cmd[0]}" ${cmd.slice(1).join(" ")}"`,
      ]
    : cmd;
  const proc = Bun.spawn(argv, {
    env,
    ...(cwd === undefined ? {} : { cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
    windowsVerbatimArguments: shim,
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out.replaceAll("\r\n", "\n"), err: err.replaceAll("\r\n", "\n") };
}

/** PATH's directories, less any that holds `name` (an executable of that name). */
function pathWithout(name: string): string[] {
  const exes = windows ? [`${name}.exe`, `${name}.cmd`] : [name];
  const path = process.env.PATH ?? process.env.Path ?? "";
  return path
    .split(delimiter)
    .filter((dir) => dir !== "" && !exes.some((exe) => existsSync(join(dir, exe))));
}

const which = (name: string, path: string[]) => Bun.which(name, { PATH: path.join(delimiter) });

/** The environment for a package manager and tokenhud: this one, less anything that would
 * point either at the machine's own installs, registry or config. */
function baseEnv(dir: string, registry: string): Record<string, string> {
  const env: Record<string, string> = {};
  const skip =
    /^(path|home|userprofile|appdata|localappdata|xdg_config_home|bun_install|claude_config_dir|codex_home|node_options|npm_config_.*|bun_config_.*)$/i;
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !skip.test(name)) env[name] = value;
  }
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ...(windows
      ? { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") }
      : {}),
    XDG_CONFIG_HOME: join(dir, "xdg"),
    TOKENHUD_WSL_USERS: "",
    NO_COLOR: "1",
    // Every name either package manager reads its registry from: only the fake one.
    BUN_CONFIG_REGISTRY: registry,
    NPM_CONFIG_REGISTRY: registry,
    npm_config_registry: registry,
  };
}

const tempDirs: string[] = [];
function tempDir(): string {
  // The real path: Windows' temp dir may be an 8.3 short name, macOS's sits behind a link.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "tokenhud-npm-e2e-")));
  tempDirs.push(dir);
  return dir;
}

/** The documents of the platform packages not built here: os, cpu and libc, no tarball. */
function elsewhere(host: ReleaseTarget, version: string): FakeNpmPackage[] {
  return RELEASE_TARGETS.filter((t) => t !== host).map((t) => ({
    manifest: {
      name: npmPackage(t),
      version,
      os: [nodePlatform(t)],
      cpu: [t.arch],
      ...(t.os === "linux" ? { libc: [t.musl ? "musl" : "glibc"] } : {}),
    },
  }));
}

describe.skipIf(NEW === undefined || OLD === undefined)(
  "install and update with bun and npm",
  () => {
    const host = hostTarget();
    const platform = npmPackage(host);
    let registry: FakeNpm;

    beforeAll(async () => {
      const work = tempDir();
      const packs = join(work, "packs");
      mkdirSync(packs);
      const served: FakeNpmPackage[] = [];
      for (const [binary, version] of [
        [NEW, VERSION],
        [OLD, OLD_VERSION],
      ] as const) {
        const dist = join(work, `dist-${version}`);
        mkdirSync(dist);
        copyFileSync(resolve(binary as string), join(dist, assetName(host)));
        const dirs = stageNpm({
          dist,
          out: join(work, `npm-${version}`),
          version,
          targets: [host],
        });
        for (const dir of dirs) {
          const before = new Set(readdirSync(packs));
          const pack = await run(
            [process.execPath, "pm", "pack", "--destination", packs],
            {
              ...(process.env as Record<string, string>),
            },
            dir,
          );
          expect([dir, pack.code]).toEqual([dir, 0]);
          const made = readdirSync(packs).filter((f) => !before.has(f));
          expect(made).toHaveLength(1);
          served.push({
            manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
            tarball: join(packs, made[0] as string),
          });
        }
        served.push(...elsewhere(host, version));
      }
      const tags = { latest: VERSION, next: VERSION };
      registry = fakeNpm(served, {
        tokenhud: tags,
        ...Object.fromEntries(RELEASE_TARGETS.map((t) => [npmPackage(t), tags])),
      });
    }, SLOW);

    afterAll(async () => {
      registry?.stop();
      // Windows holds a just-run .exe for a moment.
      for (const dir of tempDirs) {
        for (let attempt = 1; ; attempt++) {
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
            break;
          } catch (error) {
            if (attempt >= 40) throw error;
            await Bun.sleep(250);
          }
        }
      }
    });

    /** The tarballs asked for since `from`, sorted. */
    const fetchedSince = (from: number) => registry.tarballs.slice(from).sort();

    test(
      "bun, with no Node: installs only this platform's package, runs, and updates through bun",
      async () => {
        const dir = tempDir();
        const bunHome = join(dir, "bun");
        const path = [join(bunHome, "bin"), dirname(process.execPath), ...pathWithout("node")];
        expect(which("node", path)).toBeNull();
        const env = {
          ...baseEnv(dir, registry.url),
          BUN_INSTALL: bunHome,
          PATH: path.join(delimiter),
        };

        const from = registry.tarballs.length;
        const add = await run([process.execPath, "add", "-g", `tokenhud@${OLD_VERSION}`], env);
        expect([add.code, add.err]).toEqual([0, expect.any(String)]);
        // Not one other platform's package was downloaded, nor its document's tarball asked for.
        expect(fetchedSince(from)).toEqual([
          `${platform}@${OLD_VERSION}`,
          `tokenhud@${OLD_VERSION}`,
        ]);
        const global = join(bunHome, "install", "global", "node_modules");
        expect(readdirSync(join(global, "@tokenhud"))).toEqual([
          platform.slice("@tokenhud/".length),
        ]);

        const tokenhud = join(bunHome, "bin", windows ? "tokenhud.exe" : "tokenhud");
        expect(await run([tokenhud, "--version"], env)).toEqual({
          code: 0,
          out: `tokenhud ${OLD_VERSION}\n`,
          err: "",
        });
        const doctor = await run([tokenhud, "doctor"], env);
        expect(doctor.code).toBe(0);
        expect(doctor.out).toContain("  this copy     bun (bun add -g)");
        expect(doctor.out).toContain(`bun · ${OLD_VERSION} · runs as tokenhud · this copy`);
        expect(doctor.out).toContain("is on PATH");
        expect(doctor.out).not.toContain("  warning ");
        expect(await run([tokenhud, "update", "--print"], env)).toEqual({
          code: 0,
          out: "bun add -g --no-cache tokenhud@latest\n",
          err: "",
        });

        const update = await run([tokenhud, "update"], env);
        expect(update.code).toBe(0);
        expect(update.err).not.toContain("WARNING");
        expect(update.out).toContain("running: bun add -g --no-cache tokenhud@latest");
        expect(update.out).toEndWith(`updated tokenhud ${OLD_VERSION} → ${VERSION}\n`);
        expect(fetchedSince(from)).toContain(`${platform}@${VERSION}`);
        expect((await run([tokenhud, "--version"], env)).out).toBe(`tokenhud ${VERSION}\n`);
        if (windows) {
          // The .exe the update moved aside is deleted by a later start, once it is unlocked.
          const parked = () =>
            readdirSync(join(bunHome, "install", "global")).filter((n) => n.endsWith(".old"));
          for (let start = 1; parked().length > 0 && start < 10; start++) {
            await Bun.sleep(500);
            await run([tokenhud, "--version"], env);
          }
          expect(parked()).toEqual([]);
        }
        const again = await run([tokenhud, "update"], env);
        expect(again.code).toBe(0);
        expect(again.out).toEndWith(`tokenhud ${VERSION} is up to date\n`);
      },
      SLOW,
    );

    test.skipIf(which("npm", pathWithout("bun")) === null)(
      "npm, with no Bun: the launcher runs on Node, and tokenhud update runs npm",
      async () => {
        const dir = tempDir();
        const prefix = join(dir, "npm");
        const bin = windows ? prefix : join(prefix, "bin");
        const path = [bin, ...pathWithout("bun")];
        expect(which("bun", path)).toBeNull();
        const npm = which("npm", path) as string;
        writeFileSync(join(dir, "npmrc"), "");
        const env = {
          ...baseEnv(dir, registry.url),
          PATH: path.join(delimiter),
          npm_config_prefix: prefix,
          npm_config_cache: join(dir, "npm-cache"),
          npm_config_userconfig: join(dir, "npmrc"),
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
        };

        const from = registry.tarballs.length;
        const install = await run([npm, "install", "-g", `tokenhud@${OLD_VERSION}`], env);
        expect([install.code, install.err]).toEqual([0, expect.any(String)]);
        expect(fetchedSince(from)).toEqual([
          `${platform}@${OLD_VERSION}`,
          `tokenhud@${OLD_VERSION}`,
        ]);
        // npm ran the preinstall before linking the command: Node's line.
        const pkg = windows
          ? join(prefix, "node_modules", "tokenhud")
          : join(prefix, "lib", "node_modules", "tokenhud");
        expect(readFileSync(join(pkg, "bin", "tokenhud.cjs"), "utf8").split("\n")[0]).toBe(
          "#!/usr/bin/env node",
        );

        const tokenhud = join(bin, windows ? "tokenhud.cmd" : "tokenhud");
        expect(await run([tokenhud, "--version"], env)).toEqual({
          code: 0,
          out: `tokenhud ${OLD_VERSION}\n`,
          err: "",
        });
        const doctor = await run([tokenhud, "doctor"], env);
        expect(doctor.code).toBe(0);
        expect(doctor.out).toContain("  this copy     npm");
        expect(doctor.out).toContain(`npm · ${OLD_VERSION} · runs as tokenhud · this copy`);
        expect(await run([tokenhud, "update", "--print"], env)).toEqual({
          code: 0,
          out: "npm install -g tokenhud@latest\n",
          err: "",
        });

        const update = await run([tokenhud, "update"], env);
        expect(update.code).toBe(0);
        expect(update.err).not.toContain("WARNING");
        expect(update.out).toContain("running: npm install -g tokenhud@latest");
        expect(update.out).toEndWith(`updated tokenhud ${OLD_VERSION} → ${VERSION}\n`);
        expect((await run([tokenhud, "--version"], env)).out).toBe(`tokenhud ${VERSION}\n`);
        // npm removed the old package whole: the running .exe wasn't in it (Windows).
        expect(readdirSync(dirname(pkg)).filter((n) => n.startsWith(".tokenhud"))).toEqual([]);
      },
      SLOW,
    );
  },
);

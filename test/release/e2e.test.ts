// install.sh, install.ps1 and `tokenhud update` end to end, against release binaries served
// by a fake GitHub on localhost. Skipped unless pointed at binaries:
//
//   TOKENHUD_E2E_DIST=dist             release assets (`bun run build --release`)
//   TOKENHUD_E2E_OLD=old/tokenhud      an older build for this platform, to update from
//   TOKENHUD_E2E_WINDOWS_TMP=/mnt/c/…  from WSL: test install.ps1 and the Windows binary instead,
//                                      in a temp folder under this Windows directory
//
// Installs go to temp dirs only, and install.ps1 runs with TOKENHUD_NO_MODIFY_PATH=1, so the
// user PATH is never touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../../src/version.ts";
import { type FakeGitHub, fakeGitHub } from "./fake-github.ts";

const DIST = process.env.TOKENHUD_E2E_DIST;
const OLD = process.env.TOKENHUD_E2E_OLD;
const WIN_TMP = process.env.TOKENHUD_E2E_WINDOWS_TMP;
const TAG = `v${VERSION}`;
const ROOT = join(import.meta.dir, "..", "..");
const windows = process.platform === "win32" || WIN_TMP !== undefined;
const EXE = windows ? "tokenhud.exe" : "tokenhud";
const SLOW = 120_000;

interface Ran {
  code: number | null;
  out: string;
}

// Always async: the fake GitHub answers from this process's event loop, which a spawnSync
// would block while the installer waits on it.
async function spawn(
  cmd: string[],
  env: Record<string, string>,
  wslPaths: string[] = [],
): Promise<Ran> {
  const extra = Object.keys(env).map((k) => (wslPaths.includes(k) ? `${k}/p` : k));
  const proc = Bun.spawn(cmd, {
    env: {
      ...process.env,
      ...env,
      // From WSL, Windows programs see only the variables WSLENV lists.
      ...(WIN_TMP === undefined
        ? {}
        : { WSLENV: [process.env.WSLENV, ...extra].filter(Boolean).join(":") }),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: `${stdout}${stderr}`.replaceAll("\r\n", "\n") };
}

function windowsPath(path: string): string {
  if (WIN_TMP === undefined) return path;
  return Bun.spawnSync(["wslpath", "-w", path]).stdout.toString().trim();
}

/** Runs this platform's installer into `dir`. */
function install(gh: FakeGitHub, dir: string, version: string | null): Promise<Ran> {
  const env: Record<string, string> = {
    TOKENHUD_DOWNLOAD_BASE: gh.downloads,
    TOKENHUD_INSTALL: dir,
    TOKENHUD_NO_MODIFY_PATH: "1",
    ...(version === null ? {} : { TOKENHUD_VERSION: version }),
  };
  if (!windows) return spawn(["sh", join(ROOT, "install.sh")], env);
  const ps1 = windowsPath(join(ROOT, "install.ps1"));
  const ps = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  return spawn([...ps, "-File", ps1], env, ["TOKENHUD_INSTALL"]);
}

function tokenhud(bin: string, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return spawn([bin, ...args], env);
}

const tempDirs: string[] = [];
function tempDir(): string {
  // The real path: Windows' temp dir may be an 8.3 short name and macOS's sits behind a
  // symlink, while the installers and the binary print the path they see.
  const dir = realpathSync.native(mkdtempSync(join(WIN_TMP ?? tmpdir(), "tokenhud-e2e-")));
  tempDirs.push(dir);
  return dir;
}

describe.skipIf(DIST === undefined)("installers and update against a fake release", () => {
  const dist = resolve(DIST ?? ".");
  let gh: FakeGitHub;
  beforeAll(() => {
    gh = fakeGitHub({ dir: dist, tag: TAG });
  });
  afterAll(async () => {
    gh.stop();
    // Windows holds a just-run .exe for a moment, which WSL reports as EACCES.
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

  test(
    "installs this machine's binary, verified, and prints its version; again, in place",
    async () => {
      const dir = tempDir();
      for (const round of [1, 2]) {
        const ran = await install(gh, dir, TAG);
        expect([round, ran.code, ran.out]).toEqual([
          round,
          0,
          expect.stringContaining("Checksum ok"),
        ]);
        expect(ran.out).toContain(
          `Installed tokenhud ${VERSION} to ${windowsPath(join(dir, EXE))}`,
        );
        expect(readdirSync(dir)).toEqual([EXE]);
        expect(await tokenhud(join(dir, EXE), ["--version"])).toEqual({
          code: 0,
          out: `tokenhud ${VERSION}\n`,
        });
      }
    },
    SLOW,
  );

  test(
    "TOKENHUD_VERSION without the v works too",
    async () => {
      const dir = tempDir();
      expect((await install(gh, dir, VERSION)).code).toBe(0);
      expect((await tokenhud(join(dir, EXE), ["--version"])).out).toBe(`tokenhud ${VERSION}\n`);
    },
    SLOW,
  );

  test(
    "with no version given: the latest stable release, or a clear error while there is none",
    async () => {
      const dir = tempDir();
      const ran = await install(gh, dir, null);
      if (TAG.includes("-")) {
        expect(ran.code).toBe(1);
        expect(ran.out).toContain("no stable release found");
        expect(readdirSync(dir)).toEqual([]);
      } else {
        expect(ran.code).toBe(0);
        expect((await tokenhud(join(dir, EXE), ["--version"])).out).toBe(`tokenhud ${VERSION}\n`);
      }
    },
    SLOW,
  );

  test(
    "a binary that fails its checksum is not installed",
    async () => {
      const tampered = fakeGitHub({ dir: dist, tag: TAG, tamper: true });
      try {
        const dir = tempDir();
        const ran = await install(tampered, dir, TAG);
        expect(ran.code).toBe(1);
        expect(ran.out).toContain("failed its checksum");
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        tampered.stop();
      }
    },
    SLOW,
  );

  test.skipIf(OLD === undefined)(
    "tokenhud update replaces an older install with the release, then reports up to date",
    async () => {
      const dir = tempDir();
      const exe = join(dir, EXE);
      copyFileSync(resolve(OLD ?? ""), exe);
      const old = (await tokenhud(exe, ["--version"])).out.trim().replace(/^tokenhud /, "");
      expect(old).not.toBe(VERSION);
      const api = { TOKENHUD_RELEASES_API: gh.api };

      const check = await tokenhud(exe, ["update", "--check", "--prerelease"], api);
      expect(check).toEqual({
        code: 0,
        out: `update available: tokenhud ${old} → ${VERSION}\nrun: tokenhud update --prerelease\n`,
      });
      const ran = await tokenhud(exe, ["update", "--prerelease"], api);
      expect([ran.code, ran.out]).toEqual([0, expect.stringContaining("checksum ok")]);
      expect(ran.out).toEndWith(`updated tokenhud ${old} → ${VERSION} (${windowsPath(exe)})\n`);
      // Windows parks the replaced exe beside the new one until the next start.
      expect(readdirSync(dir).sort()).toEqual(windows ? [EXE, `${EXE}.old`] : [EXE]);

      expect(await tokenhud(exe, ["--version"])).toEqual({ code: 0, out: `tokenhud ${VERSION}\n` });
      // Each start deletes the parked exe; one may still be locked a moment after its exit.
      for (let start = 1; readdirSync(dir).length > 1 && start < 10; start++) {
        await Bun.sleep(500);
        await tokenhud(exe, ["--version"]);
      }
      expect(readdirSync(dir)).toEqual([EXE]);
      expect(await tokenhud(exe, ["update", "--prerelease"], api)).toEqual({
        code: 0,
        out: `tokenhud ${VERSION} is up to date\n`,
      });
      expect(existsSync(exe)).toBe(true);
    },
    SLOW,
  );
});

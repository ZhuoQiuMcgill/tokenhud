// install.sh, install.ps1 and `tokenhud update` end to end, against release binaries served
// by a fake GitHub on localhost. Skipped unless pointed at binaries:
//
//   TOKENHUD_E2E_DIST=dist             release assets (`bun run build --release`)
//   TOKENHUD_E2E_OLD=old/tokenhud      an older build for this platform, to update from
//   TOKENHUD_E2E_WINDOWS_TMP=/mnt/c/…  from WSL: test install.ps1 and the Windows binary instead,
//                                      in a temp folder under this Windows directory
//
// The fake GitHub is plain http on 127.0.0.1, which the installers and `tokenhud update`
// accept only with TOKENHUD_INSECURE_TEST=1. Installs go to temp dirs only. install.ps1 runs
// with TOKENHUD_NO_MODIFY_PATH=1, except in one test that runs only on a CI Windows runner,
// whose user profile is thrown away with the machine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const INSECURE = { TOKENHUD_INSECURE_TEST: "1" };

interface Ran {
  code: number | null;
  out: string;
  err: string;
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
  return {
    code,
    out: stdout.replaceAll("\r\n", "\n"),
    err: stderr.replaceAll("\r\n", "\n"),
  };
}

function windowsPath(path: string): string {
  if (WIN_TMP === undefined) return path;
  return Bun.spawnSync(["wslpath", "-w", path]).stdout.toString().trim();
}

const PS = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

/** Runs this platform's installer into `dir`, from `base` (the fake GitHub's, by default). */
function install(
  gh: FakeGitHub | string,
  dir: string,
  version: string | null,
  over: Record<string, string> = INSECURE,
): Promise<Ran> {
  const env: Record<string, string> = {
    TOKENHUD_DOWNLOAD_BASE: typeof gh === "string" ? gh : gh.downloads,
    TOKENHUD_INSTALL: dir,
    TOKENHUD_NO_MODIFY_PATH: "1",
    ...(version === null ? {} : { TOKENHUD_VERSION: version }),
    ...over,
  };
  if (!windows) return spawn(["sh", join(ROOT, "install.sh")], env);
  return spawn([...PS, "-File", windowsPath(join(ROOT, "install.ps1"))], env, ["TOKENHUD_INSTALL"]);
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

const WARNING = "WARNING: downloading from";

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
          chmodSync(dir, 0o755);
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
        // Not GitHub, so it says where from, on stderr.
        expect(ran.err).toContain(`${WARNING} ${gh.downloads} (TOKENHUD_DOWNLOAD_BASE)`);
        expect(readdirSync(dir)).toEqual([EXE]);
        expect(await tokenhud(join(dir, EXE), ["--version"])).toEqual({
          code: 0,
          out: `tokenhud ${VERSION}\n`,
          err: "",
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
    "a plain-http source without TOKENHUD_INSECURE_TEST is refused before anything downloads",
    async () => {
      const dir = tempDir();
      const ran = await install(gh, dir, TAG, {});
      expect(ran.code).toBe(1);
      expect(ran.err).toContain("TOKENHUD_DOWNLOAD_BASE must be an https:// URL");
      expect(readdirSync(dir)).toEqual([]);
    },
    SLOW,
  );

  describe("each failure says what went wrong", () => {
    test(
      "no stable release yet, or no such version",
      async () => {
        const dir = tempDir();
        const latest = await install(gh, dir, null);
        if (TAG.includes("-")) {
          expect(latest.code).toBe(1);
          expect(latest.err).toContain("no stable release found");
        } else {
          expect(latest.code).toBe(0);
        }
        const missing = await install(gh, tempDir(), "9.9.9");
        expect(missing.code).toBe(1);
        expect(missing.err).toContain("release v9.9.9 not found");
      },
      SLOW,
    );

    test(
      "the server can't be reached",
      async () => {
        const dir = tempDir();
        const ran = await install("http://127.0.0.1:9/releases", dir, TAG);
        expect(ran.code).toBe(1);
        expect(ran.err).toContain("couldn't download from http://127.0.0.1:9/releases");
        expect(ran.err).not.toContain("not found");
        expect(readdirSync(dir)).toEqual([]);
      },
      SLOW,
    );

    test(
      "a binary that fails its checksum",
      async () => {
        const tampered = fakeGitHub({ dir: dist, tag: TAG, tamper: true });
        try {
          const dir = tempDir();
          const ran = await install(tampered, dir, TAG);
          expect(ran.code).toBe(1);
          expect(ran.err).toContain("failed its checksum");
          expect(readdirSync(dir)).toEqual([]);
        } finally {
          tampered.stop();
        }
      },
      SLOW,
    );

    test(
      "a binary the release lists but the server doesn't have",
      async () => {
        const gone = fakeGitHub({ dir: dist, tag: TAG, missingBinaries: true });
        try {
          const dir = tempDir();
          const ran = await install(gone, dir, TAG);
          expect(ran.code).toBe(1);
          expect(ran.err).toContain("but the server doesn't have it");
          expect(readdirSync(dir)).toEqual([]);
        } finally {
          gone.stop();
        }
      },
      SLOW,
    );

    test.skipIf(!windows && process.getuid?.() === 0)(
      "an install directory it can't write to",
      async () => {
        const parent = tempDir();
        let dir: string;
        if (windows) {
          // A file where a folder of the path should be: no folder can be made there.
          writeFileSync(join(parent, "file"), "");
          dir = join(parent, "file", "bin");
        } else {
          dir = join(parent, "locked");
          mkdirSync(dir);
          chmodSync(dir, 0o555);
        }
        const ran = await install(gh, dir, TAG);
        expect(ran.code).toBe(1);
        expect(ran.err).toContain(`can't write to ${windowsPath(dir)}`);
        if (!windows) chmodSync(dir, 0o755);
      },
      SLOW,
    );
  });

  // The user PATH write is real only on a throwaway CI machine (m5 of the T14 critique).
  test.skipIf(!(process.platform === "win32" && process.env.CI === "true"))(
    "install.ps1 adds its folder to the user PATH once, keeping %VAR% entries unexpanded",
    async () => {
      const ps = (script: string) => spawn([...PS, "-Command", script], {});
      const read = async () => {
        const out = await ps(
          "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); " +
            "$o = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames; " +
            "if ($k -and $null -ne $k.GetValue('Path')) { " +
            "Write-Output ($k.GetValueKind('Path').ToString() + '|' + $k.GetValue('Path', '', $o)) " +
            "} else { Write-Output 'None|' }",
        );
        const [kind, ...value] = out.out.trim().split("|");
        return { kind, value: value.join("|") };
      };
      const write = (kind: string, value: string) =>
        ps(
          kind === "None"
            ? "[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment').DeleteValue('Path', $false)"
            : `[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment').SetValue('Path', '${value.replaceAll("'", "''")}', [Microsoft.Win32.RegistryValueKind]::${kind})`,
        );
      const before = await read();
      const seed = "%USERPROFILE%\\tokenhud-e2e-seed";
      try {
        await write("ExpandString", before.value === "" ? seed : `${before.value};${seed}`);
        const dir = tempDir();
        for (const round of [1, 2]) {
          const ran = await install(gh, dir, TAG, { ...INSECURE, TOKENHUD_NO_MODIFY_PATH: "" });
          expect([round, ran.code]).toEqual([round, 0]);
          if (round === 1) expect(ran.out).toContain(`Added ${dir} to your user PATH`);
          else expect(ran.out).not.toContain("Added");
        }
        const after = await read();
        expect(after.kind).toBe("ExpandString");
        expect(after.value).toContain(seed);
        expect(after.value.split(";").filter((e) => e.toLowerCase() === dir.toLowerCase())).toEqual(
          [dir],
        );
        const fresh = await ps("[Environment]::GetEnvironmentVariable('Path', 'User')");
        expect(fresh.out.toLowerCase()).toContain(dir.toLowerCase());
      } finally {
        await write(before.kind ?? "None", before.value);
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
      const api = { TOKENHUD_RELEASES_API: gh.api, ...INSECURE };

      const check = await tokenhud(exe, ["update", "--check", "--prerelease"], api);
      expect([check.code, check.out]).toEqual([
        0,
        `update available: tokenhud ${old} → ${VERSION}\nrun: tokenhud update --prerelease\n`,
      ]);
      expect(check.err).toContain(`WARNING: releases come from ${gh.api} (TOKENHUD_RELEASES_API)`);
      const ran = await tokenhud(exe, ["update", "--prerelease"], api);
      expect([ran.code, ran.out]).toEqual([0, expect.stringContaining("checksum ok")]);
      expect(ran.out).toEndWith(`updated tokenhud ${old} → ${VERSION} (${windowsPath(exe)})\n`);
      // Windows parks the replaced exe beside the new one until the next start.
      expect(readdirSync(dir).sort()).toEqual(windows ? [EXE, `${EXE}.old`] : [EXE]);

      expect((await tokenhud(exe, ["--version"])).out).toBe(`tokenhud ${VERSION}\n`);
      // Each start deletes the parked exe; one may still be locked a moment after its exit.
      for (let start = 1; readdirSync(dir).length > 1 && start < 10; start++) {
        await Bun.sleep(500);
        await tokenhud(exe, ["--version"]);
      }
      expect(readdirSync(dir)).toEqual([EXE]);
      const again = await tokenhud(exe, ["update", "--prerelease"], api);
      expect([again.code, again.out]).toEqual([0, `tokenhud ${VERSION} is up to date\n`]);
      expect(existsSync(exe)).toBe(true);
    },
    SLOW,
  );
});

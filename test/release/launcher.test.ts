// The `tokenhud` command on Linux and macOS (npm/tokenhud/bin/tokenhud): a POSIX sh script
// that finds the platform package and execs its binary. Here in node_modules trees laid out
// as bun, npm, npx and pnpm lay them out, reached through the links they make, with a sh
// script standing in for the binary. Every case runs under each shell there is: sh (dash on
// Debian and Ubuntu, bash on macOS), dash and bash; and BusyBox in an Alpine container when
// Docker and the image are there (offline, never pulled: test/docker.ts). `uname`, `getconf`
// and `ldd` stubs first on PATH make it see another OS, CPU or C library.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { RELEASE_TARGETS, targetId } from "../../src/release.ts";
import { DOCKER_RUN, haveImage } from "../docker.ts";
import { guard } from "../guard.ts";

guard();

const ROOT = join(import.meta.dir, "..", "..");
const COMMAND = join(ROOT, "npm", "tokenhud", "bin", "tokenhud");
const script = readFileSync(COMMAND, "utf8");
/** A repo file's text with LF line ends: a Windows checkout gives install.sh CRLF ones. */
const text = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

test("its libc detection is install.sh's, word for word", () => {
  const fn = (text: string) => /^host_libc\(\) \{\n[\s\S]*?\n\}$/m.exec(text)?.[0];
  const mine = fn(script);
  expect(mine).toContain("getconf GNU_LIBC_VERSION");
  expect(mine).toBe(fn(text(join(ROOT, "install.sh"))));
});

test("it knows exactly the Linux and macOS targets releases are built for", () => {
  const list = /^ {2}(linux-x64 \| [^)]*)\) ;;$/m.exec(script)?.[1] ?? "";
  expect(list.split(" | ")).toEqual(
    RELEASE_TARGETS.filter((t) => t.os !== "windows").map((t) => targetId(t)),
  );
});

/** The shells to run it under: name → the argv prefix that runs a script with it. */
function shells(): Array<[string, string[]]> {
  const found: Array<[string, string[]]> = [["sh", ["/bin/sh"]]];
  for (const name of ["dash", "bash"]) {
    const path = Bun.which(name);
    if (path !== null) found.push([name, [path]]);
  }
  return found;
}

const posix = process.platform !== "win32";

describe.skipIf(!posix).each(shells())("the sh command under %s", (_, shell) => {
  let dir: string;
  /** Stub `uname`, `getconf` and `ldd`, first on PATH. */
  let fake: string;

  beforeEach(() => {
    // The real path: macOS's temp dir is behind a link, and the command reports real paths.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tokenhud-launcher-test-")));
    fake = join(dir, "fake-bin");
    mkdirSync(fake);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(path: string, text: string, mode = 0o755): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
  }

  /** The tokenhud package at `pkg`: its command and package.json. */
  function launcherAt(pkg: string, version = "1.2.3"): string {
    file(
      join(pkg, "package.json"),
      `{\n  "name": "tokenhud",\n  "version": "${version}",\n  "bin": {}\n}\n`,
    );
    return file(join(pkg, "bin", "tokenhud"), script);
  }

  /** A platform package at `pkg` whose stand-in binary prints its pid, arguments and $0. */
  function platformAt(pkg: string, version = "1.2.3", body = ""): string {
    file(
      join(pkg, "package.json"),
      `{\n  "name": "@tokenhud/${pkg.split("/").at(-1)}",\n  "version": "${version}",\n  "os": []\n}\n`,
    );
    return file(
      join(pkg, "bin", "tokenhud"),
      `#!/bin/sh\necho "pid=$$"\nfor a in "$@"; do echo "arg=[$a]"; done\n${body}\n`,
    );
  }

  /** Makes this machine look like `os`/`arch`, and on Linux like `libc`. */
  function looksLike(os: string, arch: string, libc: "glibc" | "musl" = "glibc"): void {
    file(
      join(fake, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac\n`,
    );
    file(
      join(fake, "getconf"),
      libc === "glibc" ? "#!/bin/sh\necho glibc 2.41\n" : "#!/bin/sh\nexit 1\n",
    );
    file(
      join(fake, "ldd"),
      `#!/bin/sh\necho '${libc === "musl" ? "musl libc (x86_64)" : "ldd (GNU libc) 2.41"}'\n`,
    );
  }

  /** This machine's id, as the command picks it (glibc on the CI and dev machines). */
  const here = () => {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return `${process.platform === "darwin" ? "darwin" : "linux"}-${arch}`;
  };

  async function run(path: string, args: string[] = [], cwd = dir) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${fake}:/usr/bin:/bin`,
    };
    delete env.CLAUDE_CONFIG_DIR;
    const proc = Bun.spawn([...shell, path, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, pid: proc.pid, stdout, stderr };
  }

  const relink = (link: string, target: string) => {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), target), link);
    return link;
  };

  test("bun's global install: through its relative link, with every argument as given", async () => {
    const global = join(dir, ".bun", "install", "global", "node_modules");
    const command = launcherAt(join(global, "tokenhud"));
    platformAt(join(global, "@tokenhud", here()), "1.2.3", "exit 7");
    const link = relink(join(dir, ".bun", "bin", "tokenhud"), command);
    const out = await run(link, ["doctor", "--json", "a b", "", "*", "$HOME"]);
    expect(out.code).toBe(7);
    expect(out.stderr).toBe("");
    // exec: the binary is the process that was started, so signals reach it directly.
    expect(out.stdout).toBe(
      [
        `pid=${out.pid}`,
        "arg=[doctor]",
        "arg=[--json]",
        "arg=[a b]",
        "arg=[]",
        "arg=[*]",
        "arg=[$HOME]",
        "",
      ].join("\n"),
    );
  });

  test("npm's global install: the platform package nested under tokenhud", async () => {
    const top = join(dir, "prefix", "lib", "node_modules", "tokenhud");
    const command = launcherAt(top);
    platformAt(join(top, "node_modules", "@tokenhud", here()));
    const link = relink(join(dir, "prefix", "bin", "tokenhud"), command);
    expect((await run(link, ["--version"])).stdout).toContain("arg=[--version]");
  });

  test("pnpm's layout: through a linked package directory, the platform package beside it", async () => {
    const store = join(dir, "app", "node_modules", ".pnpm");
    const real = join(store, "tokenhud@1.2.3", "node_modules", "tokenhud");
    launcherAt(real);
    const platformReal = join(
      store,
      `@tokenhud+${here()}@1.2.3`,
      "node_modules",
      "@tokenhud",
      here(),
    );
    platformAt(platformReal);
    relink(join(store, "tokenhud@1.2.3", "node_modules", "@tokenhud", here()), platformReal);
    relink(join(dir, "app", "node_modules", "tokenhud"), real);
    const link = relink(
      join(dir, "app", "node_modules", ".bin", "tokenhud"),
      join(dir, "app", "node_modules", "tokenhud", "bin", "tokenhud"),
    );
    expect((await run(link, ["x"])).stdout).toContain("arg=[x]");
  });

  test("a chain of links, absolute and relative, in directories with spaces", async () => {
    const global = join(dir, "my tools", "node_modules");
    const command = launcherAt(join(global, "tokenhud"));
    platformAt(join(global, "@tokenhud", here()));
    const first = join(dir, "bin one", "tokenhud");
    mkdirSync(dirname(first), { recursive: true });
    symlinkSync(command, first);
    const second = relink(join(dir, "bin two", "tokenhud"), first);
    expect((await run(second, ["ok"])).stdout).toContain("arg=[ok]");
    // Run by a bare name from its own directory too.
    expect((await run("tokenhud", ["ok"], join(dir, "bin two"))).stdout).toContain("arg=[ok]");
  });

  test("no platform package: exit 1, which package, and how to get it", async () => {
    const global = join(dir, "g", "node_modules");
    const command = launcherAt(join(global, "tokenhud"));
    // Another platform's package doesn't count.
    platformAt(join(global, "@tokenhud", "win32-x64"));
    const out = await run(command);
    expect([out.code, out.stdout]).toEqual([1, ""]);
    // Both causes: optional dependencies left out, and a download that failed, as npm's CDN
    // 404ed @tokenhud/linux-x64 for minutes after v0.1.0 was published.
    expect(out.stderr).toBe(
      [
        `tokenhud: the package with the tokenhud binary for this machine, @tokenhud/${here()},`,
        "is not installed. It comes as an optional dependency, so it is missing when",
        "optional dependencies were skipped (--omit=optional, --no-optional, or a lockfile",
        "made on another platform). Reinstall tokenhud the same way, without --omit=optional:",
        "  bun add -g tokenhud          (a global install with bun)",
        "  npm install -g tokenhud      (a global install with npm)",
        "  npm install tokenhud         (in a project)",
        "It is also missing when its download failed, which bun and npm pass over without an",
        "error. If tokenhud was just released, wait a few minutes and reinstall:",
        "  bun remove -g tokenhud && bun add -g --no-cache tokenhud",
        "  npm install -g --prefer-online tokenhud",
        "or install the binary directly: https://github.com/ZhuoQiuMcgill/tokenhud#install",
        "",
      ].join("\n"),
    );
  });

  test("musl: its own package, never the glibc one, and how to install both it and libstdc++", async () => {
    looksLike("Linux", "x86_64", "musl");
    const global = join(dir, "g", "node_modules");
    const command = launcherAt(join(global, "tokenhud"));
    platformAt(join(global, "@tokenhud", "linux-x64"));
    const missing = await run(command);
    expect([missing.code, missing.stdout]).toEqual([1, ""]);
    expect(missing.stderr).toBe(
      [
        "tokenhud: on musl Linux (Alpine), the tokenhud binary is a package of its own,",
        "@tokenhud/linux-x64-musl, and it needs the C++ runtime. Install them beside tokenhud:",
        "  apk add libstdc++ libgcc                       (as root)",
        "  bun add -g @tokenhud/linux-x64-musl tokenhud",
        "  npm install -g @tokenhud/linux-x64-musl tokenhud",
        "or install the binary directly: https://github.com/ZhuoQiuMcgill/tokenhud#install",
        "",
      ].join("\n"),
    );
    platformAt(join(global, "@tokenhud", "linux-x64-musl"), "1.2.3", "echo musl");
    expect((await run(command)).stdout).toEndWith("musl\n");
  });

  test("a musl package left at another version: a warning naming the command that matches it", async () => {
    looksLike("Linux", "aarch64", "musl");
    const global = join(dir, "g", "node_modules");
    const command = launcherAt(join(global, "tokenhud"), "0.2.0");
    platformAt(join(global, "@tokenhud", "linux-arm64-musl"), "0.1.0", "echo ran");
    const out = await run(command);
    expect([out.code, out.stdout.endsWith("ran\n")]).toEqual([0, true]);
    expect(out.stderr).toBe(
      "tokenhud: warning: @tokenhud/linux-arm64-musl is 0.1.0, but tokenhud is 0.2.0. Update it\n" +
        "to match: bun add -g @tokenhud/linux-arm64-musl@0.2.0 (or npm install -g @tokenhud/linux-arm64-musl@0.2.0)\n",
    );
  });

  test("a Mac runs the other architecture's package when its own is missing", async () => {
    looksLike("Darwin", "arm64");
    const global = join(dir, "g", "node_modules");
    const command = launcherAt(join(global, "tokenhud"));
    platformAt(join(global, "@tokenhud", "darwin-x64"), "1.2.3", "echo x64");
    expect((await run(command)).stdout).toEndWith("x64\n");
    platformAt(join(global, "@tokenhud", "darwin-arm64"), "1.2.3", "echo arm64");
    expect((await run(command)).stdout).toEndWith("arm64\n");
  });

  test("an OS or CPU with no release: exit 1 and the supported list", async () => {
    looksLike("FreeBSD", "riscv64");
    const command = launcherAt(join(dir, "g", "node_modules", "tokenhud"));
    const out = await run(command);
    expect(out.code).toBe(1);
    expect(out.stderr).toStartWith("tokenhud: there is no tokenhud binary for FreeBSD-riscv64.");
  });

  // Critique R-n3: with PATH=/nonexistent it said `readlink: not found`, `uname: not found`.
  test("a PATH without its tools: it finds them, and the binary gets PATH as it was", async () => {
    const global = join(dir, "g", "node_modules");
    const command = launcherAt(join(global, "tokenhud"));
    platformAt(join(global, "@tokenhud", here()), "1.2.3", 'echo "path=[$PATH]"');
    const proc = Bun.spawn([...shell, command], {
      cwd: dir,
      env: { PATH: "/nonexistent" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect([await proc.exited, stderr]).toEqual([0, ""]);
    // The test guard puts its stub dir (claude and codex only) first on every child's PATH.
    expect(stdout).toEndWith(`path=[${process.env.TOKENHUD_TEST_STUBS}:/nonexistent]\n`);
  });

  test("the working directory's .env and bunfig.toml mean nothing to it", async () => {
    const global = join(dir, "g", "node_modules");
    const command = launcherAt(join(global, "tokenhud"));
    platformAt(join(global, "@tokenhud", here()), "1.2.3", 'echo "dir=[$CLAUDE_CONFIG_DIR]"');
    const project = join(dir, "project");
    file(join(project, ".env"), "CLAUDE_CONFIG_DIR=/attacker\n", 0o644);
    file(join(project, "bunfig.toml"), 'preload = ["./evil.ts"]\n', 0o644);
    file(join(project, "evil.ts"), 'require("fs").writeFileSync("PRELOADED", "")\n', 0o644);
    const out = await run(command, [], project);
    expect(out.stdout).toEndWith("dir=[]\n");
    expect(existsSync(join(project, "PRELOADED"))).toBe(false);
  });
});

// BusyBox ash on a real musl system: what Alpine's /bin/sh is. Offline.
describe.skipIf(!haveImage("alpine:3.22"))("the sh command in Alpine (BusyBox, musl)", () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tokenhud-launcher-alpine-")));
  });
  afterAll(() => {
    // The container only reads the mounted dir.
    rmSync(dir, { recursive: true, force: true });
  });

  test("finds the musl package through bun's link and execs it", async () => {
    const global = join(dir, "g", ".bun", "install", "global", "node_modules");
    mkdirSync(join(global, "tokenhud", "bin"), { recursive: true });
    cpSync(COMMAND, join(global, "tokenhud", "bin", "tokenhud"));
    writeFileSync(join(global, "tokenhud", "package.json"), '{\n  "version": "1.0.0"\n}\n');
    for (const id of ["linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl"]) {
      mkdirSync(join(global, "@tokenhud", id, "bin"), { recursive: true });
      writeFileSync(join(global, "@tokenhud", id, "package.json"), '{\n  "version": "1.0.0"\n}\n');
      writeFileSync(
        join(global, "@tokenhud", id, "bin", "tokenhud"),
        `#!/bin/sh\necho "${id} $*"\n`,
      );
      chmodSync(join(global, "@tokenhud", id, "bin", "tokenhud"), 0o755);
    }
    chmodSync(join(global, "tokenhud", "bin", "tokenhud"), 0o755);
    mkdirSync(join(dir, "g", ".bun", "bin"));
    symlinkSync(
      "../install/global/node_modules/tokenhud/bin/tokenhud",
      join(dir, "g", ".bun", "bin", "tokenhud"),
    );
    const proc = Bun.spawn(
      [...DOCKER_RUN, "-v", `${dir}:/w:ro`, "alpine:3.22", "/w/g/.bun/bin/tokenhud", "a b", "c"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/^linux-(x64|arm64)-musl a b c\n$/);
  }, 120_000);
});

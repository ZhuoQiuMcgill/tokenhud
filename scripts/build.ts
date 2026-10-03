// Compiles src/cli.ts into standalone binaries: the programmatic form of
// `bun build --compile`.
//
//   bun run build                                 # this machine: dist/tokenhud[.exe]
//   bun run build --target=bun-windows-x64        # one Bun compile target: dist/tokenhud[.exe]
//   bun run build --release                       # every release target, plus SHA256SUMS
//   bun run build --sums                          # rewrite dist/SHA256SUMS from the binaries there
//   bun run build --smoke [id...] [--workdir=DIR] # run the release binaries this machine can
//
// --release writes dist/tokenhud-<os>-<arch>[-musl][.exe] for every target in
// src/release.ts. Cross-compiling needs every platform's OpenTUI native package, so install
// with `bun install --os="*" --cpu="*"` first.
//
// --smoke runs each release binary in dist/ that can run here with --version, with a
// headless `--once --width 100` against a fixture store, as `tokenhud hook` (silent, then
// telling a fixture alert), and as `tokenhud mcp`
// (scripts/mcp-smoke.ts), from a temp copy that is deleted afterwards. Ids (`linux-x64-musl`)
// name the binaries that must run; without ids, every binary that can run here does, and
// the others are listed as skipped. Beyond the native ones: musl binaries run in an Alpine
// container when Docker is there, x64 macOS binaries under Rosetta, and Windows binaries
// from WSL when --workdir is on a Windows drive.
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  assetName,
  bunTarget,
  formatSums,
  RELEASE_TARGETS,
  type ReleaseTarget,
  SUMS_FILE,
  targetById,
  targetId,
} from "../src/release.ts";
import { openStore } from "../src/store/store.ts";
import { VERSION } from "../src/version.ts";
import { mcpMachine, smokeMcp } from "./mcp-smoke.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string" },
    release: { type: "boolean", default: false },
    sums: { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
    workdir: { type: "string" },
  },
  allowPositionals: true,
  strict: true,
});

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

/** The release target a Bun compile target string names; its segments may come in any order. */
function targetOf(bun: string): ReleaseTarget {
  const parts = bun.split("-");
  return {
    os: parts.includes("windows") ? "windows" : parts.includes("darwin") ? "darwin" : "linux",
    arch: parts.includes("arm64") || parts.includes("aarch64") ? "arm64" : "x64",
    musl: parts.includes("musl"),
  };
}

function hostTarget(): ReleaseTarget {
  return {
    os:
      process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    // Host builds on Linux are glibc; musl binaries come from the *-musl targets.
    musl: false,
  };
}

/** Compiles one binary. `bun` is the compile target, or undefined for this machine. */
async function compile(target: ReleaseTarget, bun: string | undefined, outfile: string) {
  // Bun.build throws on failure (its `throw` option defaults to true), which fails the script.
  const result = await Bun.build({
    // Worker scripts must be entrypoints too, or the compiled binary has no module to start
    // them from (`new Worker(new URL(...))` then exits silently).
    entrypoints: [
      join(root, "src", "cli.ts"),
      join(root, "src", "ingest", "worker.ts"),
      join(root, "src", "ingest", "parse-worker.ts"),
      join(root, "src", "tui", "vm", "worker.ts"),
    ],
    define: {
      // OpenTUI picks its native library by process.platform/arch and, on Linux, by
      // OPENTUI_LIBC. Defined at build time, the bundler keeps only the matching library's
      // import, so the binary embeds the right one (ARCHITECTURE §9.1).
      ...(target.os === "linux"
        ? { "process.env.OPENTUI_LIBC": JSON.stringify(target.musl ? "musl" : "glibc") }
        : {}),
      // Which release asset this binary is, for `tokenhud update`.
      "process.env.TOKENHUD_TARGET": JSON.stringify(targetId(target)),
    },
    // Identifiers stay unmangled: stack frames take function names from the runtime, which a
    // sourcemap does not rename back (`keepNames` doesn't either), so mangling would turn
    // `main` into `f` in every crash report. Mangling saves about a fifth of our own JS (420
    // bytes at T1), which is noise next to the ~80 MB Bun runtime in the binary.
    minify: { whitespace: true, syntax: true, identifiers: false },
    // Each command's modules go in chunks of their own, loaded when the command runs: one
    // bundle made every start parse all of tokenhud (the TUI, the MCP SDK), about 50 ms on
    // Linux, which `tokenhud hook`, run by Claude Code after every batch of tool calls,
    // can't afford (T29: under 60 ms in all). With chunks, `--version` takes about 15 ms.
    splitting: true,
    // With `compile`, this embeds a zstd-compressed sourcemap in the binary (the API form of
    // `--compile --sourcemap`), so stack frames point at src/*.ts lines, not the bundle.
    sourcemap: "linked",
    compile: {
      ...(bun === undefined ? {} : { target: bun as Bun.Build.CompileTarget }),
      outfile,
      // A compiled binary would otherwise load .env and bunfig.toml from whatever directory
      // the user runs it in. tokenhud runs inside arbitrary projects, where a .env could
      // inject CLAUDE_CONFIG_DIR and a bunfig.toml `preload` could run code.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  // Bun also writes the map next to the binary. The binary doesn't need it, so keep dist/ to
  // the files that ship.
  for (const output of result.outputs) {
    // Two entrypoints named worker.ts share a map name, so the second rm finds it gone.
    if (output.kind === "sourcemap") await rm(output.path, { force: true });
  }
  return Bun.file(outfile).size;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

/** Writes dist/SHA256SUMS for the release binaries in dist/; fails if one is missing. */
async function writeSums(): Promise<void> {
  const sums = new Map<string, string>();
  for (const t of RELEASE_TARGETS) {
    const path = join(dist, assetName(t));
    if (!existsSync(path)) throw new Error(`${relative(process.cwd(), path)} is missing`);
    sums.set(assetName(t), await sha256(path));
  }
  await writeFile(join(dist, SUMS_FILE), formatSums(sums));
  console.log(`wrote ${relative(process.cwd(), join(dist, SUMS_FILE))} (${sums.size} binaries)`);
}

async function buildRelease(): Promise<void> {
  await mkdir(dist, { recursive: true });
  for (const t of RELEASE_TARGETS) {
    const bytes = await compile(t, bunTarget(t), join(dist, assetName(t)));
    console.log(`  ${assetName(t).padEnd(30)}${mb(bytes).padStart(9)}  (${bytes} bytes)`);
  }
  await writeSums();
  console.log(`built tokenhud ${VERSION} for ${RELEASE_TARGETS.length} targets`);
}

// ── smoke test ───────────────────────────────────────────────────────────────────────

const MUSL_IMAGE = "tokenhud-smoke-musl:alpine3.22";
/**
 * The fixture's Codex model, as the Overview's top models (the last 24 h) name it: there
 * whatever the time of day, since the store's usage is minutes old.
 */
const FIXTURE_MODEL = "gpt-5.5";

let muslImage: boolean | null = null;
/** Builds, once, an Alpine image with the C++ runtime that Bun's musl builds link against. */
function dockerMusl(): boolean {
  if (muslImage !== null) return muslImage;
  if (Bun.which("docker") === null) {
    muslImage = false;
    return false;
  }
  const built = Bun.spawnSync(["docker", "build", "-q", "-t", MUSL_IMAGE, "-"], {
    stdin: Buffer.from("FROM alpine:3.22\nRUN apk add --no-cache libstdc++ libgcc\n"),
    stdout: "ignore",
    stderr: "inherit",
  });
  muslImage = built.exitCode === 0;
  return muslImage;
}

function isWsl(): boolean {
  if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** Turns a binary, its arguments and the test environment into what to spawn. */
type Wrap = (
  bin: string,
  args: string[],
  env: Record<string, string>,
) => { cmd: string[]; env: Record<string, string | undefined> };

const native: Wrap = (bin, args, env) => ({ cmd: [bin, ...args], env: { ...process.env, ...env } });

/** How to run `t`'s binary here, from a copy in `work`, or why it can't run. */
function runnerFor(t: ReleaseTarget, work: string): Wrap | string {
  const host = hostTarget();
  if (t.os === "linux" && host.os === "linux" && t.arch === host.arch) {
    const hostMusl = existsSync(`/lib/ld-musl-${t.arch === "x64" ? "x86_64" : "aarch64"}.so.1`);
    if (t.musl === hostMusl) return native;
    if (!t.musl) return "a glibc binary on a musl system";
    if (!dockerMusl()) return "a musl binary needs an Alpine container, and Docker is missing";
    return (bin, args, env) => ({
      cmd: [
        "docker",
        "run",
        "--rm",
        // Keeps stdin attached: `tokenhud mcp` reads its requests there.
        "-i",
        "--network",
        "none",
        "-v",
        `${work}:${work}`,
        ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        MUSL_IMAGE,
        bin,
        ...args,
      ],
      env: process.env,
    });
  }
  if (t.os === "darwin" && host.os === "darwin") {
    if (t.arch === host.arch) return native;
    const rosetta = Bun.spawnSync(["arch", "-x86_64", "/usr/bin/true"], { stderr: "ignore" });
    return t.arch === "x64" && rosetta.exitCode === 0 ? native : "x64 on arm64 needs Rosetta";
  }
  if (t.os === "windows" && host.os === "windows" && t.arch === host.arch) return native;
  if (t.os === "windows" && t.arch === "x64" && host.os === "linux" && host.arch === "x64") {
    if (!isWsl()) return "a Windows binary on Linux";
    if (!/^\/mnt\/[a-z]\//.test(work)) return "from WSL, pass --workdir on a Windows drive";
    // WSL hands Windows programs only the variables WSLENV lists; /p translates the paths.
    const wslenv =
      "HOME/p:USERPROFILE/p:XDG_CONFIG_HOME/p:TOKENHUD_WSL_USERS:TOKENHUD_TEST:NO_COLOR";
    return (bin, args, env) => ({
      cmd: [bin, ...args],
      env: {
        ...process.env,
        ...env,
        WSLENV: [process.env.WSLENV, wslenv].filter(Boolean).join(":"),
      },
    });
  }
  return `a ${targetId(t)} binary on ${targetId(host)}`;
}

/** A store with two made-up accounts' usage in the last hour, at `<xdg>/tokenhud/tokenhud.db`. */
function writeFixtureStore(xdg: string): void {
  const now = Date.now();
  const store = openStore(join(xdg, "tokenhud", "tokenhud.db"));
  const usage = { inp: 1200, outp: 400, cr: 20_000, cc: 3000, e5: null, e1: null, tier: 0 };
  store.upsert([
    {
      ...usage,
      key: 1n,
      provider: "claude",
      identity: "smoke-identity-claude",
      label: "smoke-claude",
      ts: now - 30 * 60_000,
      model: "claude-sonnet-4-6",
    },
    {
      ...usage,
      key: 2n,
      provider: "codex",
      identity: "smoke-identity-codex",
      label: "smoke-codex",
      ts: now - 20 * 60_000,
      model: "gpt-5.5",
    },
  ]);
  store.close();
}

async function run(
  wrap: Wrap,
  bin: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
) {
  const { cmd, env: full } = wrap(bin, args, env);
  const stdin = input === undefined ? "ignore" : Buffer.from(input);
  const proc = Bun.spawn(cmd, { env: full, stdin, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/**
 * Deletes a smoke dir. Windows keeps a just-exited program's files locked for a moment (an
 * antivirus scan of the new .exe, say), which WSL reports as EACCES, a code rm's own
 * retries skip.
 */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 30 || (code !== "EACCES" && code !== "EPERM" && code !== "EBUSY")) throw error;
      await Bun.sleep(500);
    }
  }
}

const firstLines = (text: string) => text.trim().split("\n").slice(0, 5).join("\n");

const HOOK_SESSION = "00000000-0000-4000-8000-000000000001";

/**
 * `tokenhud hook` as Claude Code runs it, the command code splitting exists for: a
 * PostToolBatch event on stdin, first with no alerts (silence), then with a session alert
 * whose 5-hour window is over the line (its line in a hook reply).
 */
async function smokeHook(
  wrap: Wrap,
  bin: string,
  env: Record<string, string>,
  home: string,
  xdg: string,
): Promise<string[]> {
  const event = JSON.stringify({
    session_id: HOOK_SESSION,
    transcript_path: join(home, ".claude", "projects", "-smoke", `${HOOK_SESSION}.jsonl`),
    cwd: home,
    hook_event_name: "PostToolBatch",
    tool_calls: [],
    tool_results: [],
  });
  // Made here, not by the binary: in the musl container it runs as root, and a directory
  // root makes could not be emptied afterwards.
  await mkdir(join(xdg, "tokenhud", "mcp"), { recursive: true });
  await mkdir(join(xdg, "tokenhud", "logs"), { recursive: true });
  const silent = await run(wrap, bin, ["hook"], env, event);
  if (silent.code !== 0 || silent.stdout !== "") {
    return [`hook, no alerts: exit ${silent.code}, printed ${JSON.stringify(silent.stdout)}`];
  }
  const now = Date.now();
  const id = "smoke-identity-claude";
  const config = join(xdg, "tokenhud");
  await writeFile(
    join(config, "limits.json"),
    JSON.stringify({
      providers: {
        [id]: {
          captured_at: now / 1000 - 30,
          source: "claude",
          via: "api",
          rate_limits: {
            session: { label: "5-HOUR", used_percentage: 82, resets_at: now / 1000 + 3600 },
          },
        },
      },
      status: {},
    }),
  );
  await writeFile(
    join(config, "alerts.json"),
    JSON.stringify({
      alerts: [
        {
          id: "smoke001",
          created_at: now,
          session: HOOK_SESSION,
          account: { id, label: "smoke-claude", provider: "claude", group: null, members: [id] },
          window: "5h",
          at: 80,
          note: null,
          delivered: [],
        },
      ],
    }),
  );
  const told = await run(wrap, bin, ["hook"], env, event);
  let context = "";
  try {
    context = JSON.parse(told.stdout).hookSpecificOutput.additionalContext;
  } catch {
    // reported below
  }
  if (
    told.code !== 0 ||
    !context.startsWith("[tokenhud alert] 5-hour limit (smoke-claude) is at 82%")
  ) {
    return [
      `hook, an alert over the line: exit ${told.code}, printed ${JSON.stringify(told.stdout)}`,
    ];
  }
  return [];
}

/** Smoke-tests one binary from a copy in `dir`; returns the problems found. */
async function smokeOne(t: ReleaseTarget, wrap: Wrap, dir: string): Promise<string[]> {
  const bin = join(dir, assetName(t));
  await cp(join(dist, assetName(t)), bin);
  const home = join(dir, "home");
  const xdg = join(dir, "xdg");
  await mkdir(home, { recursive: true });
  writeFixtureStore(xdg);
  // Nothing from this machine: an empty home, the fixture store, no WSL or env roots.
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    TOKENHUD_WSL_USERS: "",
    CLAUDE_CONFIG_DIR: "",
    CODEX_HOME: "",
    NO_COLOR: "1",
  };
  const version = await run(wrap, bin, ["--version"], env);
  if (version.code !== 0 || version.stdout.trim() !== `tokenhud ${VERSION}`) {
    return [
      `--version: exit ${version.code}, printed ${JSON.stringify(version.stdout)}`,
      firstLines(version.stderr),
    ];
  }
  const once = await run(wrap, bin, ["--once", "--width", "100"], env);
  const header = once.stdout.split("\n")[0] ?? "";
  const problems: string[] = [];
  if (once.code !== 0) problems.push(`--once: exit ${once.code}`);
  if (!header.startsWith(" tokenhud ")) problems.push(`--once: header ${JSON.stringify(header)}`);
  if (!once.stdout.includes(FIXTURE_MODEL)) {
    problems.push("--once: the fixture store's usage is not on screen");
  }
  if (problems.length > 0) problems.push(firstLines(once.stderr));
  problems.push(...(await smokeHook(wrap, bin, env, home, xdg)));
  const mcp = wrap(bin, ["mcp"], await mcpMachine(dir));
  problems.push(...(await smokeMcp(mcp.cmd, mcp.env)).map((p) => `mcp: ${p}`));
  return problems;
}

async function smoke(ids: string[], workdir: string): Promise<boolean> {
  const named = ids.map((id) => {
    const t = targetById(id);
    if (t === undefined) throw new Error(`unknown target '${id}'`);
    return t;
  });
  const required = named.length > 0;
  let ok = true;
  let ran = 0;
  for (const t of required ? named : RELEASE_TARGETS) {
    const name = assetName(t);
    if (!existsSync(join(dist, name))) {
      if (required) {
        console.log(`FAIL ${name}: not in dist/`);
        ok = false;
      }
      continue;
    }
    const work = await mkdtemp(join(workdir, "tokenhud-smoke-"));
    try {
      const wrap = runnerFor(t, work);
      if (typeof wrap === "string") {
        console.log(`${required ? "FAIL" : "skip"} ${name}: ${wrap}`);
        if (required) ok = false;
        continue;
      }
      const problems = (await smokeOne(t, wrap, work)).filter(Boolean);
      ran++;
      if (problems.length === 0)
        console.log(`ok   ${name}: --version, --once --width 100, hook, mcp`);
      else {
        ok = false;
        console.log(`FAIL ${name}\n${problems.map((p) => `     ${p}`).join("\n")}`);
      }
    } finally {
      await removeDir(work);
    }
  }
  if (ran === 0) console.log("no release binary in dist/ can run here");
  return ok && (ran > 0 || !required);
}

// ── main ─────────────────────────────────────────────────────────────────────────────

if (values.smoke) {
  if (!(await smoke(positionals, values.workdir ?? tmpdir()))) process.exit(1);
} else if (values.sums) {
  await writeSums();
} else if (values.release) {
  await buildRelease();
} else {
  if (positionals.length > 0) throw new Error(`unexpected argument '${positionals[0]}'`);
  const target = values.target;
  const t = target === undefined ? hostTarget() : targetOf(target);
  const outfile = join(dist, t.os === "windows" ? "tokenhud.exe" : "tokenhud");
  const bytes = await compile(t, target, outfile);
  console.log(
    `built tokenhud ${VERSION} for ${target ?? "host"}: ${relative(process.cwd(), outfile)}, ` +
      `${mb(bytes)} (${bytes} bytes)`,
  );
}

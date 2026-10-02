// Compiles src/cli.ts into a standalone binary: the programmatic form of
// `bun build --compile`.
//
//   bun run build                                # host platform
//   bun run build --target=bun-windows-x64       # cross-compile (any Bun compile target)
//
// The output is always dist/tokenhud, plus .exe for Windows targets.
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { VERSION } from "../src/version.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: "string" } },
  strict: true,
});
// Bun.build validates the target string and fails the build on an unknown one.
const target = values.target as Bun.Build.CompileTarget | undefined;

const windows = target === undefined ? process.platform === "win32" : target.includes("windows");
const linux = target === undefined ? process.platform === "linux" : target.includes("linux");
// OpenTUI picks its native library by process.platform/arch and, on Linux, by
// OPENTUI_LIBC. Defined at build time, the bundler keeps only the matching library's
// import, so the binary embeds the right one (ARCHITECTURE §9.1). Host builds on Linux are
// glibc; musl binaries come from the *-musl targets.
const libc = target?.includes("musl") ? "musl" : "glibc";
const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", windows ? "tokenhud.exe" : "tokenhud");

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
  define: linux ? { "process.env.OPENTUI_LIBC": JSON.stringify(libc) } : {},
  // Identifiers stay unmangled: stack frames take function names from the runtime, which a
  // sourcemap does not rename back (`keepNames` doesn't either), so mangling would turn
  // `main` into `f` in every crash report. Mangling saves about a fifth of our own JS (420
  // bytes at T1), which is noise next to the ~80 MB Bun runtime in the binary.
  minify: { whitespace: true, syntax: true, identifiers: false },
  // With `compile`, this embeds a zstd-compressed sourcemap in the binary (the API form of
  // `--compile --sourcemap`), so stack frames point at src/*.ts lines, not the bundle.
  sourcemap: "linked",
  compile: {
    ...(target === undefined ? {} : { target }),
    outfile,
    // A compiled binary would otherwise load .env and bunfig.toml from whatever directory
    // the user runs it in. tokenhud runs inside arbitrary projects, where a .env could
    // inject CLAUDE_CONFIG_DIR and a bunfig.toml `preload` could run code.
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});

// Bun also writes the map next to the binary. The binary doesn't need it, so keep dist/ to
// the one file that ships.
for (const output of result.outputs) {
  // Two entrypoints named worker.ts share a map name, so the second rm finds it gone.
  if (output.kind === "sourcemap") await rm(output.path, { force: true });
}

const bytes = Bun.file(outfile).size;
const megabytes = (bytes / 1e6).toFixed(1);
console.log(
  `built tokenhud ${VERSION} for ${target ?? "host"}: ${relative(process.cwd(), outfile)}, ` +
    `${megabytes} MB (${bytes} bytes)`,
);

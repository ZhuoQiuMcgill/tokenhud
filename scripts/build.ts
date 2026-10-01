// Compiles src/cli.ts into a standalone binary: the programmatic form of
// `bun build --compile`.
//
//   bun run build                                # host platform
//   bun run build --target=bun-windows-x64       # cross-compile (any Bun compile target)
//
// The output is always dist/tokenhud, plus .exe for Windows targets.
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
const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", windows ? "tokenhud.exe" : "tokenhud");

// Bun.build throws on failure (its `throw` option defaults to true), which fails the script.
await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  minify: true,
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

const bytes = Bun.file(outfile).size;
const megabytes = (bytes / 1e6).toFixed(1);
console.log(
  `built tokenhud ${VERSION} for ${target ?? "host"}: ${relative(process.cwd(), outfile)}, ` +
    `${megabytes} MB (${bytes} bytes)`,
);

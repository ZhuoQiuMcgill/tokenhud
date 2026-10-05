// bun scripts/t31-probe/build.ts <outfile> [bun-target]
import { join } from "node:path";

const args = Bun.argv.slice(2);
const split = !args.includes("--no-split");
const [outfile, target] = args.filter((a) => a !== "--no-split");
if (outfile === undefined) throw new Error("outfile?");
const src = join(import.meta.dir, "src");
await Bun.build({
  entrypoints: [
    join(src, "cli.ts"),
    join(src, "ingest", "worker.ts"),
    join(src, "ingest", "parse-worker.ts"),
    join(src, "tui", "vm", "worker.ts"),
  ],
  minify: { whitespace: true, syntax: true, identifiers: false },
  splitting: split,
  compile: {
    ...(target ? { target: target as Bun.Build.CompileTarget } : {}),
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});
console.log(`built ${outfile} for ${target ?? "host"}, splitting ${split}`);

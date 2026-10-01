import { VERSION } from "./version.ts";

// The commands from docs/ARCHITECTURE.md §3, in its order. None is implemented yet: each
// is listed in the help as "(not yet available)" and exits 2 when run. Bare `tokenhud`
// (the TUI) counts as one of them.
const PLANNED: ReadonlyArray<readonly [usage: string, summary: string]> = [
  ["tokenhud", "interactive TUI (default)"],
  ["tokenhud --once", "one static frame to stdout"],
  ["tokenhud json <query>", "output for scripts and agents"],
  ["tokenhud mcp", "MCP server for Claude Code"],
  ["tokenhud import-cc-usage", "one-time import from cc-usage"],
  ["tokenhud doctor", "store health and data coverage"],
  ["tokenhud update", "self-update (npm or binary)"],
];

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  "json",
  "mcp",
  "import-cc-usage",
  "doctor",
  "update",
]);

const OPTIONS: ReadonlyArray<readonly [usage: string, summary: string]> = [
  ["-h, --help", "show this help"],
  ["-v, --version", "print the version"],
];

const EXIT_OK = 0;
const EXIT_USAGE = 2;

function helpText(): string {
  const usageWidth = Math.max(...[...PLANNED, ...OPTIONS].map(([usage]) => usage.length)) + 2;
  const summaryWidth = Math.max(...PLANNED.map(([, summary]) => summary.length)) + 2;
  const commands = PLANNED.map(
    ([usage, summary]) =>
      `  ${usage.padEnd(usageWidth)}${summary.padEnd(summaryWidth)}(not yet available)`,
  );
  const options = OPTIONS.map(([usage, summary]) => `  ${usage.padEnd(usageWidth)}${summary}`);
  return [
    `tokenhud ${VERSION}`,
    "Live terminal heads-up display for coding-agent usage, limits and cost.",
    "",
    "Usage:",
    ...commands,
    "",
    "Options:",
    ...options,
  ].join("\n");
}

function usageError(message: string): number {
  process.stderr.write(`tokenhud: ${message}\nrun tokenhud --help for usage\n`);
  return EXIT_USAGE;
}

// Arguments are read left to right and the first decisive one wins: `--help` and
// `--version` answer at once, and an unknown option or command fails at once. So
// `tokenhud doctor --help` shows the help, and `tokenhud --bogus --help` is an error.
function main(args: readonly string[]): number {
  let subcommand: string | undefined;
  let once = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${helpText()}\n`);
      return EXIT_OK;
    }
    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`tokenhud ${VERSION}\n`);
      return EXIT_OK;
    }
    if (arg === "--once") {
      once = true;
    } else if (arg.startsWith("-")) {
      return usageError(`unknown option '${arg}'`);
    } else if (subcommand === undefined) {
      // Only the first positional names a command; later ones are its arguments, such as
      // the json query.
      if (!SUBCOMMANDS.has(arg)) return usageError(`unknown command '${arg}'`);
      subcommand = arg;
    }
  }
  const requested = subcommand ?? (once ? "--once" : "tokenhud");
  process.stderr.write(`tokenhud: '${requested}' is not available yet\n`);
  return EXIT_USAGE;
}

const argv = process.argv.slice(2);
// `ingest` is a developer command, kept out of --help and parsed by its own module.
if (argv[0] === "ingest") {
  const { runIngest } = await import("./commands/ingest.ts");
  process.exitCode = await runIngest(argv.slice(1));
} else {
  process.exitCode = main(argv);
}

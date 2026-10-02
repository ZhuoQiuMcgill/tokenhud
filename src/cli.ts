import { VERSION } from "./version.ts";

// The commands from docs/ARCHITECTURE.md §3, in its order. Those not implemented yet are
// listed in the help as "(not yet available)" and exit 2 when run.
const PLANNED: ReadonlyArray<readonly [usage: string, summary: string]> = [
  ["tokenhud", "interactive TUI (default)"],
  ["tokenhud --once", "one static frame to stdout"],
  ["tokenhud json <query>", "output for scripts and agents"],
  ["tokenhud mcp", "MCP server for Claude Code"],
  ["tokenhud import-cc-usage", "one-time import from cc-usage"],
  ["tokenhud doctor", "store health and data coverage"],
  ["tokenhud update", "self-update (npm or binary)"],
];

type Command = (args: readonly string[]) => number | Promise<number>;

/**
 * The implemented commands, each loaded only when run: the TUI's UI thread must never load
 * the query layer (T6 critic Q1), and nothing else needs to pay for loading the others
 * (the MCP SDK is the largest module tree). Each command parses its own arguments, its
 * --help included.
 */
const COMMANDS: ReadonlyMap<string, () => Promise<Command>> = new Map<
  string,
  () => Promise<Command>
>([
  ["json", async () => (await import("./commands/json.ts")).runJson],
  ["mcp", async () => (await import("./commands/mcp.ts")).runMcp],
  ["import-cc-usage", async () => (await import("./commands/import-cc-usage.ts")).runImportCcUsage],
  ["doctor", async () => (await import("./commands/doctor.ts")).runDoctor],
]);

/** The TUI and --once, which are not subcommands. */
const BARE: ReadonlySet<string> = new Set(["tokenhud", "tokenhud --once"]);

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  "json",
  "mcp",
  "import-cc-usage",
  "doctor",
  "update",
]);

const OPTIONS: ReadonlyArray<readonly [usage: string, summary: string]> = [
  ["--width N", "width of the --once frame (default: the terminal's)"],
  ["-h, --help", "show this help"],
  ["-v, --version", "print the version"],
];

const EXIT_OK = 0;
const EXIT_USAGE = 2;

function helpText(): string {
  const usageWidth = Math.max(...[...PLANNED, ...OPTIONS].map(([usage]) => usage.length)) + 2;
  const summaryWidth = Math.max(...PLANNED.map(([, summary]) => summary.length)) + 2;
  const commands = PLANNED.map(([usage, summary]) => {
    const available = BARE.has(usage) || COMMANDS.has(usage.split(" ")[1] ?? "");
    const line = `  ${usage.padEnd(usageWidth)}${available ? summary : summary.padEnd(summaryWidth)}`;
    return available ? line : `${line}(not yet available)`;
  });
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

/** The narrowest --once frame (the TUI's own minimum) and a sane upper bound. */
const WIDTH_MIN = 40;
const WIDTH_MAX = 1000;

// Arguments are read left to right and the first decisive one wins: `--help` and
// `--version` answer at once, and an unknown option or command fails at once. An
// implemented command takes every argument after its name, so `tokenhud doctor --help`
// is the doctor's help, while `tokenhud update --help` is still the general one.
async function main(args: readonly string[]): Promise<number> {
  let subcommand: string | undefined;
  let once = false;
  let width: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (subcommand === undefined) {
      const command = COMMANDS.get(arg);
      if (command !== undefined) return (await command())(args.slice(i + 1));
    }
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
    } else if (arg === "--width" || arg.startsWith("--width=")) {
      const text = arg === "--width" ? args[++i] : arg.slice("--width=".length);
      const n = Number(text);
      if (text === undefined || !Number.isInteger(n) || n < WIDTH_MIN || n > WIDTH_MAX) {
        return usageError(`--width takes a whole number from ${WIDTH_MIN} to ${WIDTH_MAX}`);
      }
      width = n;
    } else if (arg.startsWith("-")) {
      return usageError(`unknown option '${arg}'`);
    } else if (subcommand === undefined) {
      // Only the first positional names a command; later ones are its arguments.
      if (!SUBCOMMANDS.has(arg)) return usageError(`unknown command '${arg}'`);
      subcommand = arg;
    }
  }
  if (subcommand !== undefined) {
    process.stderr.write(`tokenhud: '${subcommand}' is not available yet\n`);
    return EXIT_USAGE;
  }
  if (width !== null && !once) return usageError("--width applies to --once");
  if (once) {
    const { runOnce } = await import("./tui/once.tsx");
    return runOnce(width);
  }
  const { runTui } = await import("./tui/main.ts");
  // The TUI's Workers and terminal handles are closed by now; exit without waiting on
  // anything a library left behind.
  process.exit(await runTui());
}

const argv = process.argv.slice(2);
// `ingest` is a developer command, kept out of --help and parsed by its own module.
if (argv[0] === "ingest") {
  const { runIngest } = await import("./commands/ingest.ts");
  process.exitCode = await runIngest(argv.slice(1));
} else {
  process.exitCode = await main(argv);
}

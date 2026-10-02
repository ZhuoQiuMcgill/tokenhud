// Checks that the user docs only mention what exists:
// - every `tokenhud …` command line in a code span or block: its command is in
//   `tokenhud --help`, its options are in that command's --help, and a `tokenhud json`
//   query is one json's help lists;
// - every TOKENHUD_* variable is read somewhere in src/ or the installers;
// - the keys in the README's "Keys" section are keys the TUI binds, and every key the TUI's
//   footer and help show is documented there.
//
//   bun scripts/check-docs.ts      # prints the problems, exit 1 if any
//
// test/docs.test.ts runs it in `bun run check`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const cli = join(root, "src", "cli.ts");

/** The docs a user reads. */
export function docFiles(): string[] {
  const pub = join(root, "docs-public");
  return [
    join(root, "README.md"),
    join(root, "CHANGELOG.md"),
    join(root, "VERSIONING.md"),
    ...readdirSync(pub)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(pub, f)),
  ];
}

function help(args: string[]): string {
  const run = Bun.spawnSync([process.execPath, cli, ...args, "--help"], { stdout: "pipe" });
  if (run.exitCode !== 0) throw new Error(`tokenhud ${args.join(" ")} --help failed`);
  return run.stdout.toString();
}

interface Help {
  /** Options, and whether each takes a value (`--width N`, `--period P`). */
  readonly options: ReadonlyMap<string, boolean>;
  /** For `json`: its queries. */
  readonly queries: ReadonlySet<string>;
}

function parseHelp(text: string, command: string | null): Help {
  const options = new Map<string, boolean>([
    ["--help", false],
    ["-h", false],
  ]);
  for (const m of text.matchAll(
    /(?<![\w-])(--?[a-z][\w-]*)(?:(?:[ =])([A-Z][A-Z_]*\b|<[^>]+>))?/g,
  )) {
    const name = m[1] as string;
    options.set(name, (options.get(name) ?? false) || m[2] !== undefined);
  }
  for (const m of text.matchAll(/(-\w), (--[\w-]+)/g)) options.set(m[1] as string, false);
  const queries = new Set<string>();
  if (command !== null) {
    for (const m of text.matchAll(new RegExp(`tokenhud ${command} ([a-z][\\w-]*)`, "g"))) {
      queries.add(m[1] as string);
    }
  }
  return { options, queries };
}

export interface CliSpec {
  readonly top: Help;
  readonly commands: ReadonlyMap<string, Help>;
}

/** What `tokenhud --help` and each command's --help say exists. */
export function cliSpec(): CliSpec {
  const text = help([]);
  const names = [...text.matchAll(/^\s+tokenhud ([a-z][\w-]*)/gm)].map((m) => m[1] as string);
  return {
    top: parseHelp(text, null),
    commands: new Map(names.map((name) => [name, parseHelp(help([name]), name)])),
  };
}

/** Fenced blocks in these languages hold commands; other blocks (output, JSON) don't. */
const SHELLS = new Set(["sh", "bash", "shell", "console", "powershell", "ps1", "pwsh"]);

/** The commands in a markdown text (shell blocks and inline code), with their lines. */
function codeOf(text: string): Array<{ line: number; code: string }> {
  const out: Array<{ line: number; code: string }> = [];
  let fence: { shell: boolean } | null = null;
  text.split("\n").forEach((line, i) => {
    const open = /^\s*```\s*(\S*)/.exec(line);
    if (open !== null) {
      fence = fence === null ? { shell: SHELLS.has((open[1] as string).toLowerCase()) } : null;
      return;
    }
    if (fence !== null) {
      if (fence.shell) out.push({ line: i + 1, code: line });
      return;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push({ line: i + 1, code: m[1] as string });
  });
  return out;
}

const STOP = new Set(["|", "||", "&&", ";", "--", "#", ">", "2>&1"]);

/** Problems with one `tokenhud` command line (the words after `tokenhud`). */
export function checkInvocation(words: string[], spec: CliSpec): string[] {
  const problems: string[] = [];
  let command: string | null = null;
  let query: string | null = null;
  for (let i = 0; i < words.length; i++) {
    let word = words[i] as string;
    if (STOP.has(word) || word.startsWith("#")) break;
    // Usage notation: [--check], <query>, A..., …
    word = word.replace(/^\[+|\]+$|\.\.\.$|…$/g, "");
    if (word === "" || /^<.*>$/.test(word) || word === "|") continue;
    const help = command === null ? spec.top : (spec.commands.get(command) as Help);
    if (word.startsWith("-")) {
      const name = word.split("=")[0] as string;
      const takesValue = help.options.get(name);
      if (takesValue === undefined) {
        problems.push(`${command === null ? "tokenhud" : `tokenhud ${command}`} has no ${name}`);
      } else if (takesValue && !word.includes("=")) {
        i++;
      }
    } else if (command === null) {
      if (!spec.commands.has(word)) {
        problems.push(`there is no command 'tokenhud ${word}'`);
        break;
      }
      command = word;
    } else if (query === null && (spec.commands.get(command) as Help).queries.size > 0) {
      if (!(spec.commands.get(command) as Help).queries.has(word)) {
        problems.push(`there is no 'tokenhud ${command} ${word}'`);
      }
      query = word;
    }
  }
  return problems;
}

/** Every `tokenhud` command line in a markdown text. */
export function invocations(text: string): Array<{ line: number; words: string[] }> {
  const out: Array<{ line: number; words: string[] }> = [];
  for (const { line, code } of codeOf(text)) {
    // A command, not a path, package or URL: tokenhud.db, tokenhud@latest, /tokenhud.
    for (const m of code.matchAll(/(?:^|[\s($])tokenhud(?=\s|$)([^\n]*)/g)) {
      out.push({ line, words: (m[1] as string).trim().split(/\s+/).filter(Boolean) });
    }
  }
  return out;
}

function sourceText(): string {
  const files: string[] = [join(root, "install.sh"), join(root, "install.ps1")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(root, "src"));
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  escape: "esc",
  return: "enter",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/**
 * The keys the TUI binds and shows: the footer and help hints (`{ key: "…" }`), the help
 * panel's rows, and the keys the handlers compare against (`key.name === "…"`).
 */
export function keymap(): { bound: Set<string>; shown: Set<string> } {
  const shown = new Set<string>();
  const bound = new Set<string>(["Ctrl-C"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/\bkey: "([^"]+)"/g)) shown.add(m[1] as string);
        for (const m of text.matchAll(/\brow\("([^"]+)"/g)) {
          for (const k of (m[1] as string).split(" ")) bound.add(k);
        }
        for (const m of text.matchAll(/key(?:\.name)? === "([^"]+)"/g)) {
          const k = m[1] as string;
          bound.add(KEY_NAMES[k] ?? k);
        }
        // Hint lines such as "e enable/disable · l rename · esc back".
        for (const m of text.matchAll(/hint\("([^"]+)"\)/g)) {
          for (const part of (m[1] as string).split(" · ")) bound.add(part.split(" ")[0] as string);
        }
      }
    }
  };
  walk(join(root, "src", "tui"));
  for (const k of shown) {
    bound.add(k);
    // "↑/↓" binds both arrows; "1-4" binds 1 to 4.
    for (const part of k.split("/")) bound.add(part);
  }
  return { bound, shown };
}

/** The keys a "## Keys" section documents: the code spans in its tables' first column. */
export function documentedKeys(text: string): Array<{ line: number; key: string }> {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^## Keys\b/.test(l));
  if (start < 0) return [];
  const out: Array<{ line: number; key: string }> = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i] as string); i++) {
    const cells = (lines[i] as string).split("|");
    if (cells.length < 3 || /^\s*-+\s*$/.test(cells[1] as string)) continue;
    for (const m of (cells[1] as string).matchAll(/`([^`]+)`/g)) {
      out.push({ line: i + 1, key: m[1] as string });
    }
  }
  return out;
}

export function checkDocs(): string[] {
  const problems: string[] = [];
  const spec = cliSpec();
  const source = sourceText();
  const keys = keymap();
  for (const file of docFiles()) {
    const text = readFileSync(file, "utf8");
    const name = relative(root, file);
    for (const { line, words } of invocations(text)) {
      for (const p of checkInvocation(words, spec)) problems.push(`${name}:${line}: ${p}`);
    }
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/\bTOKENHUD_[A-Z0-9_]+/g)) {
        if (!source.includes(m[0])) problems.push(`${name}:${i + 1}: nothing reads ${m[0]}`);
      }
    });
  }
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const documented = documentedKeys(readme);
  if (documented.length === 0) problems.push("README.md: no keys documented under ## Keys");
  for (const { line, key } of documented) {
    if (!keys.bound.has(key)) problems.push(`README.md:${line}: the TUI binds no key '${key}'`);
  }
  const listed = new Set(documented.map((d) => d.key));
  for (const key of keys.shown) {
    if (!listed.has(key)) problems.push(`README.md: the TUI shows key '${key}', ## Keys doesn't`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkDocs();
  for (const p of problems) console.log(p);
  console.log(problems.length === 0 ? "docs ok" : `${problems.length} problem(s)`);
  if (problems.length > 0) process.exit(1);
}

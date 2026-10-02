// Checks that the user docs only mention what exists:
// - every `tokenhud …` command line in a code span or block: its command is in
//   `tokenhud --help`, its options are in that command's --help, and a `tokenhud json`
//   query is one json's help lists;
// - every TOKENHUD_* variable is read somewhere in src/ or the installers;
// - every key the README names (its "Keys" tables and inline code in its prose) is one the
//   TUI binds; and the "Keys" tables list exactly the keys the keymaps show (src/tui/keys.ts),
//   each where it belongs: movement and the global keys in the first tables, each view's
//   under `### <view title>`, the action menu's and the settings screen's under their own.
//
//   bun scripts/check-docs.ts      # prints the problems, exit 1 if any
//
// test/docs.test.ts runs it in `bun run check`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GLOBAL_KEYS, type KeyHelp, MOVE_KEYS, TEXT } from "../src/tui/keys.ts";
import { MENU_KEYMAP } from "../src/tui/menu.ts";
import { SETTINGS_KEYS } from "../src/tui/settings.ts";
import { VIEWS } from "../src/tui/views/index.ts";

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

/** Words that end a command line: shell operators, a comment, and `--` (after which comes
 * another program's command, as in `claude mcp add … -- tokenhud mcp`). */
const STOP = new Set(["|", "||", "&&", ";", "--", ">", "2>&1"]);
const stops = (word: string) => STOP.has(word) || word.startsWith("#");

/** Problems with one `tokenhud` command line (the words after `tokenhud`). */
export function checkInvocation(words: string[], spec: CliSpec): string[] {
  const problems: string[] = [];
  let command: string | null = null;
  let query: string | null = null;
  for (let i = 0; i < words.length; i++) {
    let word = words[i] as string;
    if (stops(word)) break;
    // Usage notation: [--check], <query>, A..., …
    word = word.replace(/^\[+|\]+$|\.\.\.$|…$/g, "");
    if (word === "" || /^<.*>$/.test(word)) continue;
    const name = command === null ? "tokenhud" : `tokenhud ${command}`;
    const help = command === null ? spec.top : (spec.commands.get(command) as Help);
    if (word.startsWith("-")) {
      const option = word.split("=")[0] as string;
      const takesValue = help.options.get(option);
      if (takesValue === undefined) problems.push(`${name} has no ${option}`);
      else if (takesValue && !word.includes("=")) i++;
    } else if (command === null) {
      if (!spec.commands.has(word)) {
        problems.push(`there is no command 'tokenhud ${word}'`);
        break;
      }
      command = word;
    } else if (query === null && help.queries.size > 0) {
      if (!help.queries.has(word)) problems.push(`there is no 'tokenhud ${command} ${word}'`);
      query = word;
    } else {
      // Every value an option takes was skipped above, so this is a stray argument.
      problems.push(`${query === null ? name : `${name} ${query}`} takes no argument '${word}'`);
    }
  }
  return problems;
}

/**
 * Every `tokenhud` command line in a markdown text: each `tokenhud` word in a command and
 * the words after it, up to the end of that command. Paths, packages and URLs
 * (tokenhud.db, tokenhud@latest, ZhuoQiuMcgill/tokenhud) are not the word.
 */
export function invocations(text: string): Array<{ line: number; words: string[] }> {
  const out: Array<{ line: number; words: string[] }> = [];
  for (const { line, code } of codeOf(text)) {
    const words = code.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (words[i]?.startsWith("#")) break;
      if (words[i]?.replace(/^\$?\(/, "") !== "tokenhud") continue;
      let end = i + 1;
      while (end < words.length && !stops(words[end] as string)) end++;
      out.push({ line, words: words.slice(i + 1, end) });
      i = end - 1;
    }
  }
  return out;
}

/** A code span that names a key: a letter, digit or `?`, a named key, arrows, or `d/w/m`. */
const KEY_LIKE =
  /^(?:[a-zA-Z0-9?/]|esc|enter|tab|space|backspace|Ctrl-[A-Z]|[↑↓←→]+|[↑↓←→]\/[↑↓←→]|\d-\d|[a-zA-Z](?:\/[a-zA-Z])+)$/;

/** The keys named in a markdown text's prose (inline code outside code blocks). */
export function proseKeys(text: string): Array<{ line: number; key: string }> {
  const out: Array<{ line: number; key: string }> = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      if (KEY_LIKE.test(m[1] as string)) out.push({ line: i + 1, key: m[1] as string });
    }
  });
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

/** The keys an entry shows, in the help and README: its key and its alias; none for typing. */
function shownKeys(entry: KeyHelp): string[] {
  if (entry.keys.includes(TEXT)) return [];
  return entry.alias === undefined ? [entry.show] : [entry.show, entry.alias];
}

/** Every keymap, by the README "## Keys" subsection it belongs under ("" for the first). */
function keymaps(): Map<string, readonly KeyHelp[]> {
  const maps = new Map<string, readonly KeyHelp[]>([
    ["", [...Object.values(MOVE_KEYS), ...Object.values(GLOBAL_KEYS)]],
  ]);
  for (const view of Object.values(VIEWS)) maps.set(view.title, view.keymap);
  maps.set("Account menu", MENU_KEYMAP);
  maps.set("Settings", Object.values(SETTINGS_KEYS).flat());
  return maps;
}

/**
 * The keys the TUI binds: every key an entry shows (and each half of `a/d`), and every key
 * name an entry answers, as the README writes it (`esc`, `↑`, `o`).
 */
export function boundKeys(): Set<string> {
  const bound = new Set<string>();
  for (const k of [...keySections().values()].flat()) {
    bound.add(k);
    for (const part of k.split("/")) bound.add(part);
  }
  for (const entries of keymaps().values()) {
    for (const e of entries) for (const k of e.keys) if (k !== TEXT) bound.add(KEY_NAMES[k] ?? k);
  }
  return bound;
}

/**
 * The keys a "## Keys" section documents: the code spans in its tables' first column, with
 * the `### ` heading they are under ("" for the section's first tables, the global keys).
 */
export function documentedKeys(
  text: string,
): Array<{ line: number; key: string; section: string }> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Keys\b/.test(l));
  if (start < 0) return [];
  const out: Array<{ line: number; key: string; section: string }> = [];
  let section = "";
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i] as string); i++) {
    const heading = /^### (.+)$/.exec(lines[i] as string);
    if (heading !== null) {
      section = (heading[1] as string).trim();
      continue;
    }
    const cells = (lines[i] as string).split("|");
    if (cells.length < 3 || /^\s*-+\s*$/.test(cells[1] as string)) continue;
    for (const m of (cells[1] as string).matchAll(/`([^`]+)`/g)) {
      out.push({ line: i + 1, key: m[1] as string, section });
    }
  }
  return out;
}

/**
 * Where each key the TUI shows belongs in the README's "## Keys" section: movement and the
 * global keys in its first tables (""), each view's under `### <view title>`, the action
 * menu's under `### Account menu`, the settings screen's under `### Settings`.
 */
export function keySections(): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  for (const [section, entries] of keymaps()) {
    sections.set(section, [...new Set(entries.flatMap(shownKeys))]);
  }
  return sections;
}

/** A doc's text with LF line ends: a Windows checkout has CRLF, and headings must match. */
function readDoc(path: string): string {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

export function checkDocs(): string[] {
  const problems: string[] = [];
  const spec = cliSpec();
  const source = sourceText();
  const bound = boundKeys();
  for (const file of docFiles()) {
    const text = readDoc(file);
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
  const readme = readDoc(join(root, "README.md"));
  const documented = documentedKeys(readme);
  if (documented.length === 0) problems.push("README.md: no keys documented under ## Keys");
  for (const { line, key } of [...documented, ...proseKeys(readme)]) {
    const problem = `README.md:${line}: the TUI binds no key '${key}'`;
    if (!bound.has(key) && !problems.includes(problem)) problems.push(problem);
  }
  for (const [section, shown] of keySections()) {
    const there = new Set(documented.filter((d) => d.section === section).map((d) => d.key));
    const where = section === "" ? "the first tables" : `### ${section}`;
    for (const key of shown) {
      if (!there.has(key)) problems.push(`README.md: ## Keys doesn't list '${key}' under ${where}`);
    }
    for (const key of there) {
      if (!shown.includes(key)) {
        problems.push(
          `README.md: ## Keys lists '${key}' under ${where}, whose keymap doesn't show it`,
        );
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkDocs();
  for (const p of problems) console.log(p);
  console.log(problems.length === 0 ? "docs ok" : `${problems.length} problem(s)`);
  if (problems.length > 0) process.exit(1);
}

// Rules the test guard (test/guard.ts) depends on, checked over the source tree (T15).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { guard } from "./guard.ts";

guard();

const ROOT = join(import.meta.dir, "..");

/** Every file under `dir` (relative to the repo root) whose name matches `pattern`. */
function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => pattern.test(f))
    .map((f) => relative(ROOT, join(ROOT, dir, f)).replaceAll("\\", "/"))
    .sort();
}

/**
 * `source` with comments and the contents of strings and template literals blanked out
 * (same length, newlines kept), so only code is matched.
 */
function codeOnly(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const to = end === -1 ? source.length : end;
      blank(i, to);
      i = to;
    } else if (c === "/" && source[i + 1] === "*") {
      const to = source.indexOf("*/", i + 2) + 2;
      blank(i, to);
      i = to;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Where `code` starts a process, and the text of each call's arguments. */
function spawnCalls(source: string): { at: number; call: string; args: string }[] {
  const code = codeOnly(source);
  const childProcess = /from\s+["'](node:)?child_process["']/.test(source);
  const starts = childProcess
    ? /\bBun\s*\.\s*spawn(Sync)?\s*\(|(?<![.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g
    : /\bBun\s*\.\s*spawn(Sync)?\s*\(/g;
  const calls: { at: number; call: string; args: string }[] = [];
  for (const m of code.matchAll(starts)) {
    const open = (m.index as number) + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < code.length; close++) {
      if (code[close] === "(") depth++;
      else if (code[close] === ")" && --depth === 0) break;
    }
    const line = code.slice(0, m.index).split("\n").length;
    calls.push({ at: line, call: m[0].replace(/\s+/g, ""), args: code.slice(open + 1, close) });
  }
  return calls;
}

/** An options object naming `env`: `env: …`, or the shorthand `{ env }`. */
const HAS_ENV = /(^|[{,\s])env\s*[:,}]/;

/** Each `src/` call that starts a process without an explicit env, as "file:line call". */
function spawnsWithoutEnv(file: string, source: string): string[] {
  const bad = spawnCalls(source)
    .filter((c) => !HAS_ENV.test(c.args))
    .map((c) => `${file}:${c.at} ${c.call}`);
  // Bun's shell takes its env from a chained .env(); simplest to keep it out of src/.
  const shellImport = /import\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/.test(source);
  if (shellImport || /\bBun\s*\.\s*\$/.test(codeOnly(source))) {
    bad.push(`${file} uses Bun's $ shell`);
  }
  return bad;
}

describe("the test guard is installed by every test file", () => {
  test("each *.test.ts(x) under test/ imports guard.ts and calls guard() at its top", () => {
    const missing = files("test", /\.test\.tsx?$/).filter((f) => {
      const source = readFileSync(join(ROOT, f), "utf8");
      const imports = /import \{[^}]*\bguard\b[^}]*\} from "(\.\.?\/)+guard\.ts";/.test(source);
      return !(imports && /^guard\(\);$/m.test(source));
    });
    expect(missing).toEqual([]);
  });
});

describe("product code starts processes with an explicit env", () => {
  // Bun starts a child with the environment the process started with when no env is given,
  // not process.env as it is now (T15): a test's guard, or anything else set at runtime,
  // would not reach it.
  test("every Bun.spawn, spawnSync and child_process call in src/ passes env", () => {
    const bad = files("src", /\.tsx?$/).flatMap((f) =>
      spawnsWithoutEnv(f, readFileSync(join(ROOT, f), "utf8")),
    );
    expect(bad).toEqual([]);
  });

  test("the check finds calls without env and only those", () => {
    const sample = [
      'Bun.spawn(["a"], { stdout: "pipe" });',
      'Bun.spawnSync(["b"], { env, stdout: "pipe" });',
      'Bun.spawn(argv, { env: run.env, stdin: "ignore" });',
      'const x = "Bun.spawn(not code)"; // Bun.spawn(nor this)',
      'Bun.spawnSync({ cmd: ["c"], stdout: "inherit" });',
      'db.exec("PRAGMA x"); /re/.exec("y");',
    ].join("\n");
    expect(spawnsWithoutEnv("x.ts", sample)).toEqual([
      "x.ts:1 Bun.spawn(",
      "x.ts:5 Bun.spawnSync(",
    ]);
    const node = `import { execFile, spawn } from "node:child_process";\nspawn("a", []);\nexecFile("b", [], { env: process.env }, cb);\ndb.exec("c");`;
    expect(spawnsWithoutEnv("y.ts", node)).toEqual(["y.ts:2 spawn("]);
  });
});

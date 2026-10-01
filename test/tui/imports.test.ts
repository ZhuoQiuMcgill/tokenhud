// The UI thread never runs store queries (T6 critic Q1): nothing the interactive TUI's
// entry imports, statically or dynamically, may reach the query layer, the store or SQLite.
// View models come from the view-model Worker, which is started by URL, not imported.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cachePath } from "../../src/ingest/cursors.ts";
import { tuiPaths } from "../../src/tui/main.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");
const transpiler = new Bun.Transpiler({ loader: "tsx" });

/**
 * Every module reachable from `entry`: repo files as paths relative to src/, packages and
 * builtins by specifier. Type-only imports are erased, as at run time.
 */
function graph(entry: string, options: { dynamic: boolean }): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const id = relative(SRC, file).split("\\").join("/");
    if (seen.has(id)) continue;
    seen.add(id);
    if (!/\.tsx?$/.test(file)) continue;
    for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (imp.kind === "dynamic-import" && !options.dynamic) continue;
      if (imp.path.startsWith(".")) queue.push(resolve(dirname(file), imp.path));
      else seen.add(imp.path);
    }
  }
  return seen;
}

const FORBIDDEN = [
  /^query\//,
  /^store\//,
  /^commands\//,
  /^bun:sqlite$/,
  /^tui\/vm\/(compute|session|worker)\.ts$/,
  /^tui\/once\.tsx$/,
  /^ingest\/(?!client\.ts$|worker-url\.ts$)/,
];

function forbidden(modules: Set<string>): string[] {
  return [...modules].filter((m) => FORBIDDEN.some((f) => f.test(m)));
}

describe("the UI thread's import graph", () => {
  const ui = graph(join(SRC, "tui", "main.ts"), { dynamic: true });

  test("reaches the renderer, the app and the Worker clients", () => {
    for (const m of [
      "tui/run.tsx",
      "tui/app.tsx",
      "tui/vm/client.ts",
      "ingest/client.ts",
      "lock.ts",
      "@opentui/core",
    ]) {
      expect(ui).toContain(m);
    }
  });

  test("never reaches the query layer, the store, SQLite or the view-model computations", () => {
    expect(forbidden(ui)).toEqual([]);
  });

  test("the CLI loads no command and no query code before it knows what to run", () => {
    const cli = graph(join(SRC, "cli.ts"), { dynamic: false });
    expect(forbidden(cli)).toEqual([]);
    expect([...cli].filter((m) => m.startsWith("tui/"))).toEqual([]);
  });

  test("the check can see what it forbids: the view-model Worker does reach the queries", () => {
    const worker = graph(join(SRC, "tui", "vm", "worker.ts"), { dynamic: true });
    expect(worker).toContain("query/engine.ts");
    expect(worker).toContain("bun:sqlite");
  });
});

test("the UI's cache.db path is the ingest cursors' (spelled out to keep SQLite off the UI thread)", () => {
  for (const env of [{}, { XDG_CONFIG_HOME: "/x/cfg" }]) {
    expect(tuiPaths(env, "/home/someone").cache).toBe(cachePath(env, "/home/someone"));
  }
});

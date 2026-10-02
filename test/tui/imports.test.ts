// The UI thread never runs store queries (T6 critic Q1): nothing the interactive TUI's
// entry imports, statically or dynamically, may reach the query layer, the store or SQLite.
// View models come from the view-model Worker, which is started by URL, not imported.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cachePath } from "../../src/ingest/cursors.ts";
import { ccUsageLimitsPath, limitsPath } from "../../src/limits/cache.ts";
import { tuiPaths } from "../../src/tui/main.ts";
import { guard } from "../guard.ts";

guard();

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");
const transpiler = new Bun.Transpiler({ loader: "tsx" });

/**
 * Every module reachable from `entry`, with who imports it: repo files as paths relative to
 * src/, packages and builtins by specifier. Type-only imports are erased, as at run time.
 */
function graph(entry: string, options: { dynamic: boolean }): Map<string, Set<string>> {
  const importers = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const queue: [string, string][] = [[resolve(entry), ""]];
  const note = (id: string, by: string) => {
    if (!importers.has(id)) importers.set(id, new Set());
    if (by !== "") importers.get(id)?.add(by);
  };
  while (queue.length > 0) {
    const [file, by] = queue.pop() as [string, string];
    const id = relative(SRC, file).split("\\").join("/");
    note(id, by);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!/\.tsx?$/.test(file)) continue;
    for (const imp of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (imp.kind === "dynamic-import" && !options.dynamic) continue;
      if (imp.path.startsWith(".")) queue.push([resolve(dirname(file), imp.path), id]);
      else note(imp.path, id);
    }
  }
  return importers;
}

const FORBIDDEN = [
  /^query\//,
  /^store\//,
  /^commands\//,
  /^tui\/vm\/(compute|history|overview|session|worker)\.ts$/,
  /^tui\/once\.tsx$/,
  /^ingest\/(?!client\.ts$|worker-url\.ts$)/,
];

function forbidden(modules: Map<string, Set<string>>): string[] {
  const out = [...modules.keys()].filter((m) => FORBIDDEN.some((f) => f.test(m)));
  // SQLite only for the single-writer lock, an OS-level lock held through a lock database
  // that holds no usage data.
  const sqlite = [...(modules.get("bun:sqlite") ?? [])].filter((by) => by !== "lock.ts");
  return [...out, ...sqlite.map((by) => `bun:sqlite from ${by}`)];
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
      expect(ui.has(m)).toBe(true);
    }
  });

  test("never reaches the query layer, the store, SQLite or the view-model computations", () => {
    expect(forbidden(ui)).toEqual([]);
    // The one SQLite user is the lock (an OS-level lock, not the store).
    expect([...(ui.get("bun:sqlite") ?? [])]).toEqual(["lock.ts"]);
  });

  test("the check can see a forbidden SQLite import", () => {
    const fake = new Map([["bun:sqlite", new Set(["lock.ts", "tui/app.tsx"])]]);
    expect(forbidden(fake)).toEqual(["bun:sqlite from tui/app.tsx"]);
  });

  test("the CLI loads no command and no query code before it knows what to run", () => {
    const cli = graph(join(SRC, "cli.ts"), { dynamic: false });
    expect(forbidden(cli)).toEqual([]);
    expect([...cli.keys()].filter((m) => m.startsWith("tui/"))).toEqual([]);
  });

  test("the check can see what it forbids: the view-model Worker does reach the queries", () => {
    const worker = graph(join(SRC, "tui", "vm", "worker.ts"), { dynamic: true });
    expect(worker.has("query/engine.ts")).toBe(true);
    expect(worker.get("bun:sqlite")?.size).toBeGreaterThan(0);
  });
});

test("the UI's cache.db path is the ingest cursors' (spelled out to keep SQLite off the UI thread)", () => {
  for (const env of [{}, { XDG_CONFIG_HOME: "/x/cfg" }]) {
    expect(tuiPaths(env, "/home/someone").cache).toBe(cachePath(env, "/home/someone"));
  }
});

test("the UI's limits.json and cc-usage limits paths are the limits module's", () => {
  for (const env of [{}, { XDG_CONFIG_HOME: "/x/cfg" }]) {
    const paths = tuiPaths(env, "/home/someone");
    expect(paths.limits).toBe(limitsPath(env, "/home/someone"));
    expect(paths.ccUsageLimits).toBe(ccUsageLimitsPath(env, "/home/someone"));
  }
});

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, defaultConfig } from "../../src/config.ts";
import { type EngineOptions, IngestEngine } from "../../src/ingest/engine.ts";
import cases from "../fixtures/sources/codex-cases.json";
import { tempDir, track } from "../ingest/helpers.ts";

/** A temp Codex home holding codex-cases.json's rollouts; returns its path. */
export function materialize(): string {
  const home = join(tempDir(), ".codex");
  for (const [name, b64] of Object.entries(cases.files)) {
    const path = join(home, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(b64, "base64"));
  }
  return home;
}

/** An engine over exactly the Codex homes `homes` (no Claude roots, no Windows side, no import). */
export function openCodexEngine(homes: string[], over: Partial<EngineOptions> = {}): IngestEngine {
  const dir = tempDir();
  const config: Config = { ...defaultConfig(), codex_roots: homes.map((path) => ({ path })) };
  return track(
    IngestEngine.open({
      storePath: join(dir, "tokenhud.db"),
      cachePath: join(dir, "cache.db"),
      config,
      discover: { home: join(dir, "home"), env: {}, wslUsersDir: null },
      importLedger: null,
      poolSize: 1,
      ...over,
    }),
  );
}

/** The engine's root for the Codex home at `home`. */
export function codexRoot(engine: IngestEngine, home: string) {
  const root = engine.roots.find((r) => r.provider === "codex" && r.path === home);
  if (root === undefined) throw new Error("no such Codex root");
  return root;
}

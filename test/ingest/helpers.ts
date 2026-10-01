import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig, type RootEntry } from "../../src/config.ts";
import { type EngineOptions, IngestEngine } from "../../src/ingest/engine.ts";
import type { Store } from "../../src/store/store.ts";

const made: string[] = [];
const engines: IngestEngine[] = [];

/** Stops tracked engines and removes temp dirs; each test file registers it with afterEach. */
export async function cleanup(): Promise<void> {
  for (const engine of engines.splice(0)) {
    try {
      await engine.stop();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-ingest-test-"));
  made.push(dir);
  return dir;
}

/** A Claude config dir `<base>/<name>` with an empty `projects` tree; returns the config dir. */
export function makeRoot(base: string, name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, "projects"), { recursive: true });
  return root;
}

export const T0_ISO = "2026-06-01T00:00:00.000Z";
export const T0_MS = Date.parse(T0_ISO);

/** One Claude usage line (newline-terminated), with obviously fake ids. */
export function claudeLine(
  req: string,
  mid: string,
  inp: number,
  out = 0,
  options: { ts?: string; model?: string; speed?: string } = {},
): string {
  const usage: Record<string, unknown> = { input_tokens: inp, output_tokens: out };
  if (options.speed !== undefined) usage.speed = options.speed;
  return `${JSON.stringify({
    type: "assistant",
    requestId: `req_FAKE${req}`,
    timestamp: options.ts ?? T0_ISO,
    message: { id: `msg_FAKE${mid}`, model: options.model ?? "claude-opus-4-8", usage },
  })}\n`;
}

/** An engine over exactly `roots` (config dirs): no default root, no Windows side, no import. */
export function openEngine(
  roots: (string | RootEntry)[],
  over: Partial<EngineOptions> = {},
): IngestEngine {
  const dir = tempDir();
  const config: Config = {
    ...defaultConfig(),
    claude_roots: roots.map((r) => (typeof r === "string" ? { path: r } : r)),
  };
  const engine = IngestEngine.open({
    storePath: join(dir, "tokenhud.db"),
    cachePath: join(dir, "cache.db"),
    config,
    discover: { home: join(dir, "home"), env: {}, wslUsersDir: null },
    importLedger: null,
    poolSize: 1,
    ...over,
  });
  engines.push(engine);
  return engine;
}

/** Every stored row with its account identity and model name, keyed by key. */
export function storedRows(store: Store) {
  const accounts = store.accounts();
  const models = store.models();
  return new Map(
    store.rows([...store.keys()]).map((r) => [
      r.key,
      {
        ...r,
        identity: accounts.get(r.acct)?.identity,
        label: accounts.get(r.acct)?.label,
        model: models.get(r.model),
      },
    ]),
  );
}

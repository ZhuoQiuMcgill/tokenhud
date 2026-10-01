// The limits schedule inside the real ingest Worker. Network-free by construction: the
// temp Claude roots have no credential file (so they are found signed out before any
// request) and the temp home has no ~/.codex (so no app-server is started).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { type IngestMessage, startIngestWorker } from "../../src/ingest/client.ts";
import { loadLimitsCache } from "../../src/limits/cache.ts";
import { Limits } from "../../src/limits/index.ts";
import { discoverClaudeRoots, discoverCodexRoots } from "../../src/sources/roots.ts";
import { capture, cleanup, tempDir } from "./helpers.ts";

afterEach(cleanup);

async function waitFor<T>(probe: () => T | undefined | null | false, ms: number): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`timed out after ${ms} ms`);
    await Bun.sleep(10);
  }
}

test("after the first scan the Worker fetches limits, and answers refreshLimits", async () => {
  const dir = tempDir();
  const home = join(dir, "home");
  const work = join(dir, "work-claude");
  mkdirSync(join(work, "projects"), { recursive: true });
  const config = { ...defaultConfig(), claude_roots: [{ path: work, label: "work" }] };
  const discover = { home, env: {}, wslUsersDir: null };
  const roots = () => {
    const claude = discoverClaudeRoots(config, discover);
    return [...claude, ...discoverCodexRoots(config, discover, claude)];
  };
  const workRoot = roots().find((r) => r.label === "work");
  const limitsPath = join(dir, "limits.json");
  const ccUsage = join(dir, "provider-limits.json");
  const old = capture("claude", 1_790_000_000, {
    weekly_all: { pct: 9, resets: 1_790_500_000, label: "WEEKLY" },
  });
  writeFileSync(ccUsage, JSON.stringify({ providers: { "claude:work": old } }));

  const messages: IngestMessage[] = [];
  const worker = startIngestWorker(
    {
      storePath: join(dir, "tokenhud.db"),
      cachePath: join(dir, "cache.db"),
      config,
      discover,
      importLedger: null,
      poolSize: 1,
      limits: { limitsPath, ccUsageLimits: ccUsage },
    },
    (message) => messages.push(message),
  );
  try {
    const changed = await waitFor(() => {
      const seen = messages.filter((m) => m.type === "limits").flatMap((m) => m.accounts);
      return seen.length >= 2 && seen;
    }, 10_000);
    expect(messages.findIndex((m) => m.type === "ready")).toBeLessThan(
      messages.findIndex((m) => m.type === "limits"),
    );
    expect(new Set(changed)).toEqual(
      new Set(
        roots()
          .filter((r) => r.provider === "claude")
          .map((r) => r.identity),
      ),
    );
    const file = loadLimitsCache(limitsPath);
    expect(file.status[workRoot?.identity as string]).toMatchObject({
      signed_in: false,
      history_only: "detected",
    });
    expect(file.providers[workRoot?.identity as string]).toEqual({ ...old, via: "cc-usage" });

    const outcomes = await worker.refreshLimits("work", 60);
    expect(outcomes).toEqual([
      {
        account: workRoot?.identity as string,
        fetched: false,
        error: "no Claude credentials in this config dir",
      },
    ]);
    const shown = new Limits({ limitsPath, roots, db: null, spend: null }).getLimits("work");
    expect(shown?.account.signed_in).toBe(false);
    expect(shown?.windows.map((w) => w.label)).toEqual(["WEEKLY"]);
  } finally {
    await worker.stop();
  }
  expect(await worker.refreshLimits(null, 60)).toEqual([]);
});

test("without limits options the Worker fetches nothing and answers with no outcomes", async () => {
  const dir = tempDir();
  const worker = startIngestWorker(
    {
      storePath: join(dir, "tokenhud.db"),
      cachePath: join(dir, "cache.db"),
      config: defaultConfig(),
      discover: { home: join(dir, "home"), env: {}, wslUsersDir: null },
      importLedger: null,
      poolSize: 1,
    },
    () => {},
  );
  try {
    expect(await worker.refreshLimits(null, 0)).toEqual([]);
  } finally {
    await worker.stop();
  }
});

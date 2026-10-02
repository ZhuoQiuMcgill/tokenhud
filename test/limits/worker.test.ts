// The limits schedule inside the real ingest Worker. Network-free by construction: the
// temp Claude roots have no credential file (so they are found signed out before any
// request) and the temp home has no ~/.codex (so no app-server is started).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { type IngestMessage, startIngestWorker } from "../../src/ingest/client.ts";
import { loadLimitsCache } from "../../src/limits/cache.ts";
import { readLimitEvents } from "../../src/limits/events.ts";
import { Limits } from "../../src/limits/index.ts";
import { discoverClaudeRoots, discoverCodexRoots } from "../../src/sources/roots.ts";
import { openStoreReader } from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { capture, cleanup, tempDir } from "./helpers.ts";

guard();

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

test("a limit event the Worker records goes out as `changed`, so views refresh without new usage", async () => {
  const dir = tempDir();
  const home = join(dir, "home");
  const work = join(dir, "work-claude");
  mkdirSync(join(work, "projects"), { recursive: true });
  const config = { ...defaultConfig(), claude_roots: [{ path: work, label: "work" }] };
  const discover = { home, env: {}, wslUsersDir: null };
  const workRoot = discoverClaudeRoots(config, discover).find((r) => r.label === "work");
  const ccUsage = join(dir, "provider-limits.json");
  // The weekly window at 100 % until its reset: a `reached` event, and no usage at all.
  const full = capture("claude", 1_790_000_000, {
    weekly_all: { pct: 100, resets: 1_790_500_000, label: "WEEKLY" },
  });
  writeFileSync(ccUsage, JSON.stringify({ providers: { "claude:work": full } }));
  const messages: IngestMessage[] = [];
  const storePath = join(dir, "tokenhud.db");
  const worker = startIngestWorker(
    {
      storePath,
      cachePath: join(dir, "cache.db"),
      config,
      discover,
      importLedger: null,
      poolSize: 1,
      limits: { limitsPath: join(dir, "limits.json"), ccUsageLimits: ccUsage },
    },
    (message) => messages.push(message),
  );
  try {
    const changed = await waitFor(() => messages.find((m) => m.type === "changed"), 10_000);
    expect(changed).toEqual({
      type: "changed",
      accounts: [workRoot?.identity as string],
      fromTs: 1_790_000_000_000,
      toTs: 1_790_000_000_000,
    });
  } finally {
    await worker.stop();
  }
  const db = openStoreReader(storePath);
  try {
    const events = readLimitEvents(db as NonNullable<typeof db>, { from: 0, to: 2e12 });
    // A weekly window at 100 % has passed 80 % too.
    expect(events.map((e) => [e.kind, e.at])).toEqual([
      ["reached", 1_790_000_000_000],
      ["passed_80", 1_790_000_000_000],
    ]);
  } finally {
    db?.close();
  }
});

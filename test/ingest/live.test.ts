import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { type IngestMessage, startIngestWorker } from "../../src/ingest/client.ts";
import type { EngineOptions } from "../../src/ingest/engine.ts";
import type { ChangedEvent } from "../../src/ingest/pass.ts";
import { ledgerKey } from "../../src/store/key.ts";
import { openStore } from "../../src/store/store.ts";
import {
  claudeLine,
  cleanup,
  lateWatch,
  makeRoot,
  openEngine,
  storedRows,
  tempDir,
  watcherReady,
} from "./helpers.ts";

afterEach(cleanup);

const key = (n: string) => ledgerKey(`c\x1freq_FAKE${n}\x1fmsg_FAKE${n}`);

/** Resolves with `probe()`'s first truthy value, checking every 10 ms; rejects after `ms`. */
async function waitFor<T>(probe: () => T | undefined | null | false, ms: number): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`timed out after ${ms} ms`);
    await Bun.sleep(10);
  }
}

const D1 = "2026-06-01T00:00:00Z";
const D3 = "2026-06-03T00:00:00Z";

// Watched roots are tested once the watcher is known to deliver events (see `watcherReady`),
// also with a watcher that starts 300 ms late, as macOS's FSEvents can. Polled roots use
// short poll intervals.
const modes: [string, Partial<EngineOptions>][] = [
  ["watching (Linux roots)", {}],
  ["watching, the watcher starting late", { watch: lateWatch(300) }],
  ["polling (Windows roots)", { pollAll: true, timing: { pollMs: 50, fastPollMs: 20 } }],
];

describe.each(modes)("live, %s", (_name, mode) => {
  function setup() {
    const root = makeRoot(tempDir(), "root");
    const proj = join(root, "projects", "proj");
    mkdirSync(proj, { recursive: true });
    const file = join(proj, "s.jsonl");
    writeFileSync(file, claudeLine("1", "1", 100, 0, { ts: D1 }));
    const events: ChangedEvent[] = [];
    let passes = 0;
    const engine = openEngine([root], {
      ...mode,
      onChanged: (e) => events.push(e),
      onPass: () => passes++,
    });
    /** Starts live updates and, for a watched root, waits until the watcher delivers. */
    const start = async () => {
      await engine.startLive();
      if (mode.pollAll !== true) await watcherReady(join(root, "projects"), () => passes);
    };
    return { root, proj, file, events, engine, start };
  }

  test("an appended line becomes a changed event and the right row within 1 s", async () => {
    const { file, events, engine, start } = setup();
    await start();
    expect(events).toHaveLength(1); // the first pass
    const identity = engine.roots.find((r) => r.source === "config")?.identity;
    const t0 = performance.now();
    appendFileSync(file, claudeLine("2", "2", 200, 7, { ts: D3 }));
    const event = await waitFor(() => events[1], 1000);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(event).toEqual({
      type: "changed",
      accounts: [identity as string],
      fromTs: Date.parse(D3),
      toTs: Date.parse(D3),
    });
    const rows = storedRows(engine.store);
    expect(rows.size).toBe(2);
    expect(rows.get(key("2"))).toMatchObject({ inp: 200, outp: 7 });
  });

  test("a streamed reply raises its row in place; the event spans the row's first timestamp", async () => {
    const { file, events, engine, start } = setup();
    await start();
    appendFileSync(file, claudeLine("1", "1", 100, 50, { ts: D3 }));
    const event = await waitFor(() => events[1], 1000);
    expect(event.fromTs).toBe(Date.parse(D1));
    expect(storedRows(engine.store).get(key("1"))).toMatchObject({
      inp: 100,
      outp: 50,
      ts: Date.parse(D1),
    });
  });

  test("truncating a file and writing it again counts nothing twice", async () => {
    const { file, events, engine, start } = setup();
    appendFileSync(file, claudeLine("2", "2", 200, 0, { ts: D1 }));
    await start();
    truncateSync(file, 0);
    writeFileSync(
      file,
      claudeLine("1", "1", 100, 0, { ts: D1 }) +
        claudeLine("2", "2", 200, 0, { ts: D1 }) +
        claudeLine("3", "3", 300, 0, { ts: D3 }),
    );
    await waitFor(() => events.some((e) => e.toTs === Date.parse(D3)), 1000);
    const rows = storedRows(engine.store);
    expect(rows.size).toBe(3);
    expect([...rows.values()].reduce((a, r) => a + r.inp, 0)).toBe(600);
  });

  test("a new session in a new project directory is picked up", async () => {
    const { root, events, engine, start } = setup();
    await start();
    const dir = join(root, "projects", "new-proj", "sess", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.jsonl"), claudeLine("9", "9", 900, 0, { ts: D3 }));
    await waitFor(() => events[1], 2000);
    expect(storedRows(engine.store).get(key("9"))?.inp).toBe(900);
  });

  test("stop() ends live updates", async () => {
    const { file, events, engine, start } = setup();
    await start();
    await engine.stop();
    appendFileSync(file, claudeLine("2", "2", 200));
    await Bun.sleep(150);
    expect(events).toHaveLength(1);
  });
});

test("the ingest Worker passes, reports changes, and exits when asked", async () => {
  const dir = tempDir();
  const root = makeRoot(dir, "root");
  const file = join(root, "projects", "s.jsonl");
  writeFileSync(file, claudeLine("1", "1", 100));
  const storePath = join(dir, "tokenhud.db");
  const messages: IngestMessage[] = [];
  const worker = startIngestWorker(
    {
      storePath,
      cachePath: join(dir, "cache.db"),
      config: { ...defaultConfig(), claude_roots: [{ path: root, label: "w" }] },
      discover: { home: join(dir, "home"), env: {}, wslUsersDir: null },
      importLedger: null,
      poolSize: 1,
    },
    (message) => messages.push(message),
  );
  try {
    await waitFor(() => messages.find((m) => m.type === "ready"), 10_000);
    await watcherReady(
      join(root, "projects"),
      () => messages.filter((m) => m.type === "pass").length,
    );
    expect(messages.filter((m) => m.type === "changed")).toHaveLength(1);
    appendFileSync(file, claudeLine("2", "2", 200));
    await waitFor(() => messages.filter((m) => m.type === "changed").length === 2, 2000);
  } finally {
    await worker.stop();
  }
  expect(messages.at(-1)?.type).toBe("stopped");
  expect(messages.some((m) => m.type === "log" && m.level === "error")).toBe(false);
  const store = openStore(storePath);
  try {
    expect(
      store
        .rows([key("1"), key("2")])
        .map((r) => r.inp)
        .sort(),
    ).toEqual([100, 200]);
  } finally {
    store.close();
  }
});

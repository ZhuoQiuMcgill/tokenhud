import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AcquireWriterLock,
  Freshener,
  type FreshnessOptions,
} from "../../src/mcp/freshness.ts";
import { guard } from "../guard.ts";
import { claudeLine } from "../ingest/helpers.ts";
import { cleanup, MIN, machine, NOW, rootNamed, usageRow, wire, writeStore } from "./helpers.ts";

guard();

afterEach(cleanup);

interface FakeLock {
  acquire: AcquireWriterLock;
  taken: number;
  released: number;
  beats: number;
}

function fakeLock(free = true): FakeLock {
  const lock: FakeLock = {
    taken: 0,
    released: 0,
    beats: 0,
    acquire: () => {
      if (!free) return null;
      lock.taken++;
      return {
        heartbeat: () => {
          lock.beats++;
          return true;
        },
        release: () => {
          lock.released++;
        },
      };
    },
  };
  return lock;
}

function freshener(over: Partial<FreshnessOptions>, newest: number | null = NOW - 10 * MIN) {
  const calls = { passes: 0, logs: [] as string[] };
  let now = NOW;
  const f = new Freshener({
    acquireWriterLock: null,
    newestData: () => newest,
    ingestOnce: async () => {
      calls.passes++;
    },
    now: () => now,
    log: (message) => calls.logs.push(message),
    ...over,
  });
  return { f, calls, advance: (ms: number) => (now += ms) };
}

describe("Freshener", () => {
  test("data under 2 minutes old: no lock taken, no pass", async () => {
    const lock = fakeLock();
    const { f, calls } = freshener({ acquireWriterLock: lock.acquire }, NOW - 60_000);
    expect(await f.ensure()).toEqual({ stale_s: 60, warning: null });
    expect(lock.taken).toBe(0);
    expect(calls.passes).toBe(0);
  });

  test("stale, and this build has no single-writer lock: answers as it is, with stale_s", async () => {
    const { f, calls } = freshener({ acquireWriterLock: null });
    expect(await f.ensure()).toEqual({
      stale_s: 600,
      warning:
        "the store was not refreshed: this build of the MCP server does not ingest (no single-writer lock yet); data is as of the last tokenhud ingest",
    });
    expect(calls.passes).toBe(0);
  });

  test("stale, lock held by another process: no pass, says so", async () => {
    const { f, calls } = freshener({ acquireWriterLock: fakeLock(false).acquire });
    expect(await f.ensure()).toEqual({
      stale_s: 600,
      warning:
        "the store was not refreshed: another tokenhud process holds the ingest lock and keeps the store current",
    });
    expect(calls.passes).toBe(0);
  });

  test("stale, lock free: one pass under the lock, then fresh for 2 minutes", async () => {
    const lock = fakeLock();
    const { f, calls, advance } = freshener({ acquireWriterLock: lock.acquire });
    expect(await f.ensure()).toEqual({ stale_s: 0, warning: null });
    expect([calls.passes, lock.taken, lock.released]).toEqual([1, 1, 1]);
    advance(2 * MIN);
    expect(await f.ensure()).toEqual({ stale_s: 120, warning: null });
    expect(calls.passes).toBe(1);
    advance(1);
    await f.ensure();
    expect([calls.passes, lock.taken, lock.released]).toEqual([2, 2, 2]);
  });

  test("concurrent calls share one pass", async () => {
    const lock = fakeLock();
    let finish = () => {};
    const { f, calls } = freshener({
      acquireWriterLock: lock.acquire,
      ingestOnce: () => {
        calls.passes++;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    const all = Promise.all([f.ensure(), f.ensure(), f.ensure()]);
    await Bun.sleep(5);
    finish();
    await all;
    expect([calls.passes, lock.taken, lock.released]).toEqual([1, 1, 1]);
  });

  test("a long pass keeps the lock's heartbeat going, and stops it after", async () => {
    const lock = fakeLock();
    const { f } = freshener({
      acquireWriterLock: lock.acquire,
      lockHeartbeatMs: 5,
      ingestOnce: () => Bun.sleep(60),
    });
    await f.ensure();
    const beats = lock.beats;
    expect(beats).toBeGreaterThanOrEqual(3);
    await Bun.sleep(30);
    expect(lock.beats).toBe(beats);
  });

  test("a lock lost during a long pass is logged once", async () => {
    const logs: string[] = [];
    let beats = 0;
    const { f } = freshener({
      acquireWriterLock: () => ({
        heartbeat: () => {
          beats++;
          return false;
        },
        release: () => {},
      }),
      lockHeartbeatMs: 5,
      ingestOnce: () => Bun.sleep(40),
      log: (message) => logs.push(message),
    });
    await f.ensure();
    expect(beats).toBe(1);
    expect(logs).toEqual(["lost the ingest lock to another process during a pass"]);
  });

  test("a failed pass releases the lock and warns", async () => {
    const lock = fakeLock();
    const { f, calls } = freshener({
      acquireWriterLock: lock.acquire,
      ingestOnce: async () => {
        throw new Error("disk full");
      },
    });
    expect(await f.ensure()).toEqual({
      stale_s: 600,
      warning: "the store was not refreshed: the ingest pass failed (see the MCP log)",
    });
    expect(lock.released).toBe(1);
    expect(calls.logs).toEqual(["ingest pass failed: disk full"]);
  });

  test("a lock that can't be taken at all (read-only config dir) warns with the code", async () => {
    const { f } = freshener({
      acquireWriterLock: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    expect((await f.ensure()).warning).toBe(
      "the store was not refreshed: cannot take the ingest lock (EACCES)",
    );
  });

  test("no data at all: stale_s is null", async () => {
    const { f } = freshener({}, null);
    expect((await f.ensure()).stale_s).toBeNull();
  });
});

describe("the usage tool with the store's freshness", () => {
  test("stale store, lock free: one real ingest pass picks up the transcripts", async () => {
    const m = machine();
    const dir = join(m.claude, "projects", "-fake-project");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "00000000-0000-4000-8000-000000000001.jsonl");
    const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();
    appendFileSync(file, claudeLine("1", "1", 1_000, 10, { ts: at(30) }));
    appendFileSync(file, claudeLine("2", "2", 2_000, 20, { ts: at(10) }));
    const lock = fakeLock();
    const { tools } = wire(m, { acquireWriterLock: lock.acquire });

    const first = await tools.usage({ period: "all" });
    expect(first.totals.records).toBe(2);
    expect(first.totals.tokens.input).toBe(3_000);
    expect(first.stale_s).toBe(0);
    expect(first.warnings).toEqual([]);
    expect([lock.taken, lock.released]).toEqual([1, 1]);

    // Within 2 minutes of that pass nothing is ingested, even though the file grew.
    appendFileSync(file, claudeLine("3", "3", 4_000, 40, { ts: at(1) }));
    const second = await tools.usage({ period: "all" });
    expect(second.totals.records).toBe(2);
    expect(lock.taken).toBe(1);
  });

  test("a request that will be refused never triggers an ingest pass", async () => {
    const m = machine();
    writeStore(m, [usageRow(rootNamed(m, "personal"), NOW - 7 * MIN)]);
    const lock = fakeLock();
    const { tools } = wire(m, { acquireWriterLock: lock.acquire });
    await expect(tools.usage({ period: "all", account: "nobody" })).rejects.toThrow(
      "unknown account 'nobody'",
    );
    await expect(
      tools.usage({ period: "custom", since: "2024-01-01", group_by: "day" }),
    ).rejects.toThrow("at most 500 per call");
    expect(lock.taken).toBe(0);
    await tools.usage({ period: "all" });
    expect(lock.taken).toBe(1);
  });

  test("lock busy: answers from the store as it is, with stale_s and a warning", async () => {
    const m = machine();
    writeStore(m, [usageRow(rootNamed(m, "personal"), NOW - 7 * MIN)]);
    const { tools } = wire(m, { acquireWriterLock: fakeLock(false).acquire });
    const doc = await tools.usage({ period: "today" });
    expect(doc.totals.records).toBe(1);
    expect(doc.stale_s).toBe(7 * 60);
    expect(doc.warnings).toEqual([
      "the store was not refreshed: another tokenhud process holds the ingest lock and keeps the store current",
    ]);
  });

  test("the default wiring has no lock: never ingests, says so", async () => {
    const m = machine();
    writeStore(m, [usageRow(rootNamed(m, "personal"), NOW - 7 * MIN)]);
    const { tools } = wire(m);
    const doc = await tools.usage({ period: "today" });
    expect(doc.stale_s).toBe(7 * 60);
    expect(doc.warnings[0]).toContain("does not ingest (no single-writer lock yet)");
  });
});

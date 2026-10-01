import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolder, lockPath, processAlive, STALE_MS, WriterLock } from "../../src/lock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-lock-test-"));
  dirs.push(dir);
  return join(dir, "tokenhud", "ingest.lock");
}

/** A pid that existed and has exited. */
function deadPid(): number {
  const proc = Bun.spawnSync([process.execPath, "-e", ""]);
  expect(processAlive(proc.pid)).toBe(false);
  return proc.pid;
}

function plant(path: string, holder: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(holder));
}

const fresh = (over: Record<string, unknown> = {}) => ({
  pid: process.pid,
  host: hostname(),
  owner: "tui",
  token: "someone-else",
  started_at: Date.now(),
  heartbeat_at: Date.now(),
  ...over,
});

test("the lock lives in tokenhud's config dir", () => {
  expect(lockPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/h")).toBe(
    join("/x/cfg", "tokenhud", "ingest.lock"),
  );
  expect(lockPath({}, "/home/h")).toBe(join("/home/h", ".config", "tokenhud", "ingest.lock"));
});

describe("acquire and release", () => {
  test("a free lock is taken: owner pid, host, token and heartbeat on disk", () => {
    const path = lockFile();
    const lock = WriterLock.tryAcquire({ path, owner: "tui" });
    expect(lock?.held).toBe(true);
    const disk = JSON.parse(readFileSync(path, "utf8"));
    expect(disk).toMatchObject({
      pid: process.pid,
      host: hostname(),
      owner: "tui",
      token: lock?.token,
    });
    expect(disk.heartbeat_at).toBe(disk.started_at);
    expect(lockHolder(path)).toMatchObject({ pid: process.pid, owner: "tui" });
    // No temp files are left beside it.
    expect(readdirSync(join(path, ".."))).toEqual(["ingest.lock"]);
  });

  test("a held lock can't be taken; once released it can", () => {
    const path = lockFile();
    const first = WriterLock.tryAcquire({ path, owner: "tui" }) as WriterLock;
    expect(WriterLock.tryAcquire({ path, owner: "mcp" })).toBeNull();
    first.release();
    expect(first.held).toBe(false);
    expect(lockHolder(path)).toBeNull();
    expect(WriterLock.tryAcquire({ path, owner: "mcp" })?.held).toBe(true);
    first.release(); // a second release does nothing
    expect(lockHolder(path)?.owner).toBe("mcp");
  });
});

describe("stale locks are taken over", () => {
  test("the holder's process is gone (same host)", () => {
    const path = lockFile();
    WriterLock.tryAcquire({ path, owner: "tui" })?.release();
    plant(path, fresh({ pid: deadPid() }));
    expect(lockHolder(path)).toBeNull();
    const lock = WriterLock.tryAcquire({ path, owner: "tui" });
    expect(lock?.held).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock?.token);
  });

  test("the heartbeat is older than STALE_MS, even with the pid alive (a suspended or reused pid)", () => {
    const path = lockFile();
    WriterLock.tryAcquire({ path, owner: "tui" })?.release();
    plant(path, fresh({ heartbeat_at: Date.now() - STALE_MS + 5000 }));
    expect(WriterLock.tryAcquire({ path, owner: "tui" })).toBeNull();
    plant(path, fresh({ heartbeat_at: Date.now() - STALE_MS - 1 }));
    expect(WriterLock.tryAcquire({ path, owner: "tui" })?.held).toBe(true);
  });

  test("another host's lock goes by its heartbeat alone", () => {
    const path = lockFile();
    WriterLock.tryAcquire({ path, owner: "tui" })?.release();
    plant(path, fresh({ host: "some-other-host", pid: deadPid() }));
    expect(WriterLock.tryAcquire({ path, owner: "tui" })).toBeNull();
    plant(path, fresh({ host: "some-other-host", heartbeat_at: Date.now() - STALE_MS - 1 }));
    expect(WriterLock.tryAcquire({ path, owner: "tui" })?.held).toBe(true);
  });

  test("a damaged file counts as held until it is STALE_MS old", () => {
    const path = lockFile();
    WriterLock.tryAcquire({ path, owner: "tui" })?.release();
    writeFileSync(path, "{not json");
    expect(WriterLock.tryAcquire({ path, owner: "tui" })).toBeNull();
    const old = (Date.now() - STALE_MS - 5000) / 1000;
    utimesSync(path, old, old);
    expect(WriterLock.tryAcquire({ path, owner: "tui" })?.held).toBe(true);
  });
});

describe("heartbeat", () => {
  test("refreshes heartbeat_at in place", () => {
    const path = lockFile();
    let now = 1_000_000;
    const lock = WriterLock.tryAcquire({ path, owner: "tui", now: () => now }) as WriterLock;
    now += 10_000;
    expect(lock.heartbeat()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).heartbeat_at).toBe(1_010_000);
    expect(readdirSync(join(path, ".."))).toEqual(["ingest.lock"]);
  });

  test("a holder that was taken over finds out on its next beat, and its release leaves the new lock", () => {
    const path = lockFile();
    let now = Date.now();
    const old = WriterLock.tryAcquire({ path, owner: "tui", now: () => now }) as WriterLock;
    // It was suspended past STALE_MS: a second instance takes over.
    now += STALE_MS + 1;
    const taker = WriterLock.tryAcquire({ path, owner: "tui", now: () => now }) as WriterLock;
    expect(taker.held).toBe(true);
    expect(old.heartbeat()).toBe(false);
    expect(old.held).toBe(false);
    old.release();
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(taker.token);
  });
});

describe("contention between processes", () => {
  async function race(path: string, n: number): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "tokenhud-lock-race-"));
    dirs.push(dir);
    const files = (prefix: string) => readdirSync(dir).filter((f) => f.startsWith(prefix));
    const until = async (pred: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error("the contenders did not report in time");
        await Bun.sleep(10);
      }
    };
    const procs = Array.from({ length: n }, () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "contender.ts"), path, dir]),
    );
    await until(() => files("ready-").length === n); // every one started and waiting
    writeFileSync(join(dir, "go"), "");
    await until(() => files("result-").length === n);
    const results = files("result-").map((f) => readFileSync(join(dir, f), "utf8"));
    writeFileSync(join(dir, "done"), "");
    await Promise.all(procs.map((p) => p.exited));
    return results;
  }

  test("of 8 processes starting together, exactly one takes a free lock", async () => {
    const path = lockFile();
    WriterLock.tryAcquire({ path, owner: "tui" })?.release();
    const results = await race(path, 8);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "lost")).toHaveLength(7);
  });

  test("of 12 processes finding the same stale lock, exactly one takes it over (3 rounds)", async () => {
    // Before the takeover file, a taker could move a fresh lock aside for a moment, and a
    // third process could win the empty slot: two holders in about one round in four.
    for (let round = 0; round < 3; round++) {
      const path = lockFile();
      WriterLock.tryAcquire({ path, owner: "tui" })?.release();
      plant(path, fresh({ pid: deadPid() }));
      const results = await race(path, 12);
      expect(results.filter((r) => r === "won")).toHaveLength(1);
      // The winner has released it; no takeover or temp file is left behind.
      expect(readdirSync(join(path, ".."))).toEqual([]);
    }
  });
});

describe("the takeover file", () => {
  test("is removed after a takeover, and one left by a crashed taker is cleared once old", () => {
    const path = lockFile();
    WriterLock.tryAcquire({ path, owner: "tui" })?.release();
    plant(path, fresh({ pid: deadPid() }));
    expect(WriterLock.tryAcquire({ path, owner: "tui" })?.held).toBe(true);
    expect(readdirSync(join(path, ".."))).toEqual(["ingest.lock"]);

    const turn = `${path}.takeover`;
    plant(path, fresh({ pid: deadPid() }));
    writeFileSync(turn, "{}");
    // A taker is (apparently) at work: leave it to them.
    expect(WriterLock.tryAcquire({ path, owner: "tui" })).toBeNull();
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(turn, old, old);
    expect(WriterLock.tryAcquire({ path, owner: "tui" })?.held).toBe(true);
  });
});

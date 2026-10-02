import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_FILE_NAME, lockHolder, lockPath, WriterLock } from "../../src/lock.ts";
import { round } from "./stress.ts";

const dirs: string[] = [];
const held: WriterLock[] = [];
afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenhud-lock-test-"));
  dirs.push(dir);
  return join(dir, "tokenhud", LOCK_FILE_NAME);
}

function take(path: string, owner: "tui" | "mcp" = "tui"): WriterLock | null {
  const lock = WriterLock.tryAcquire({ path, owner });
  if (lock !== null) held.push(lock);
  return lock;
}

/**
 * Another process holding the lock (or failing to); resolves once it has said which. The
 * path is written into its source, and its HOME and config dir point into the test's temp
 * dir, so nothing it does can reach a real config.
 */
async function otherProcess(path: string) {
  const script = `
import { WriterLock } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "lock.ts"))};
const lock = WriterLock.tryAcquire({ path: ${JSON.stringify(path)}, owner: "tui" });
process.stdout.write(lock === null ? "busy\\n" : "held\\n");
await Bun.sleep(60_000);
`;
  const home = join(path, "..", "..", "home");
  const proc = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, "config") },
  });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return { proc, said: new TextDecoder().decode(value).trim() };
}

test("the lock lives in tokenhud's config dir", () => {
  expect(lockPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/h")).toBe(
    join("/x/cfg", "tokenhud", "ingest.lock.db"),
  );
  expect(lockPath({}, "/home/h")).toBe(join("/home/h", ".config", "tokenhud", "ingest.lock.db"));
});

describe("in one process", () => {
  test("one holder at a time; released, it can be taken again", () => {
    const path = lockFile();
    const first = take(path) as WriterLock;
    expect(first.held).toBe(true);
    expect(take(path, "mcp")).toBeNull();
    first.release();
    expect(first.held).toBe(false);
    expect(take(path, "mcp")?.held).toBe(true);
    first.release(); // a second release does nothing
    expect(take(path)).toBeNull();
  });

  test("the holder record names the holder, for display; it goes on release", () => {
    const path = lockFile();
    let now = 1_000_000;
    const lock = WriterLock.tryAcquire({ path, owner: "mcp", now: () => now }) as WriterLock;
    held.push(lock);
    expect(lockHolder(path)).toEqual({
      pid: process.pid,
      host: hostname(),
      owner: "mcp",
      startedAt: 1_000_000,
      heartbeatAt: 1_000_000,
    });
    now += 10_000;
    expect(lock.heartbeat()).toBe(true);
    expect(lockHolder(path)?.heartbeatAt).toBe(1_010_000);
    lock.release();
    expect(lock.heartbeat()).toBe(false);
    expect(lockHolder(path)).toBeNull();
    // The lock file itself is never deleted: a waiter must lock this same file.
    expect(existsSync(path)).toBe(true);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unwritable config dir is an error, not a busy lock",
    () => {
      const path = lockFile();
      mkdirSync(join(path, ".."), { recursive: true });
      chmodSync(join(path, ".."), 0o500);
      try {
        expect(() => WriterLock.tryAcquire({ path, owner: "tui" })).toThrow();
      } finally {
        chmodSync(join(path, ".."), 0o700);
      }
    },
  );
});

describe("across processes", () => {
  test("a lock another process holds is busy, and freed by the kernel when it is killed", async () => {
    const path = lockFile();
    const other = await otherProcess(path);
    try {
      expect(other.said).toBe("held");
      expect(take(path)).toBeNull();
      expect(lockHolder(path)?.pid).toBe(other.proc.pid);
      other.proc.kill("SIGKILL");
      await other.proc.exited;
      // No waiting out a heartbeat: the lock is free as soon as the process is gone.
      expect(take(path)?.held).toBe(true);
      expect(JSON.parse(readFileSync(`${path}.holder.json`, "utf8")).pid).toBe(process.pid);
    } finally {
      other.proc.kill("SIGKILL");
    }
  });

  test("a lock this process holds is busy for another process", async () => {
    const path = lockFile();
    take(path);
    const other = await otherProcess(path);
    other.proc.kill("SIGKILL");
    expect(other.said).toBe("busy");
  });

  test("16 contenders with random kill -9s never hold it at the same moment (6 rounds)", async () => {
    // `bun test/lock/stress.ts 300` runs the full acceptance count.
    for (let r = 0; r < 6; r++) {
      const result = await round(16, 300, 4);
      expect(result.overlaps).toBe(0);
      expect(result.holds).toBeGreaterThan(0);
    }
  }, 120_000);
});

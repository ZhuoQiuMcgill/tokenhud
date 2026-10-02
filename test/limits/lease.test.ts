import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  initialStatus,
  leasePath,
  loadLimitsCache,
  updateLimitsCache,
} from "../../src/limits/cache.ts";
import { isContention, LeaseTimeoutError, tryLease, withLock } from "../../src/limits/lease.ts";
import { guard } from "../guard.ts";
import { cleanup, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

describe("tryLease", () => {
  test("one holder at a time; released, it can be taken again", () => {
    const path = join(tempDir(), "a.lease");
    const first = tryLease(path, 60_000);
    expect(first).not.toBeNull();
    expect(tryLease(path, 60_000)).toBeNull();
    first?.release();
    expect(existsSync(path)).toBe(false);
    expect(tryLease(path, 60_000)).not.toBeNull();
  });

  test("a stale lease is taken over, and its old holder's release leaves the new one", () => {
    const path = join(tempDir(), "a.lease");
    const crashed = tryLease(path, 1000, () => 0);
    expect(tryLease(path, 1000, () => 500)).toBeNull(); // still fresh
    const taker = tryLease(path, 1000, () => 2000);
    expect(taker).not.toBeNull();
    crashed?.release(); // the old holder wakes up late: not its lease any more
    expect(existsSync(path)).toBe(true);
    taker?.release();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(path))).toEqual([]); // no takeover leftovers
  });

  test("an unreadable lease is judged by its file's age", () => {
    const path = join(tempDir(), "a.lease");
    writeFileSync(path, "{half");
    expect(tryLease(path, 60_000)).toBeNull();
    expect(tryLease(path, 60_000, () => Date.now() + 61_000)).not.toBeNull();
  });

  test("withLock never runs the function without the lock: a lock that stays taken throws", () => {
    const path = join(tempDir(), "x.lock");
    // Another process's lease that won't go stale while we wait.
    const other = tryLease(path, 60_000, () => Date.now() + 60_000);
    let ran = false;
    const started = Date.now();
    expect(() =>
      withLock(
        path,
        () => {
          ran = true;
        },
        200,
      ),
    ).toThrow(LeaseTimeoutError);
    expect(ran).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200); // ttl + 1 s
    other?.release();
  });

  test("a limits.json write that can't get the lock throws and changes nothing", () => {
    const path = join(tempDir(), "limits.json");
    updateLimitsCache(path, new Map([["a", { status: initialStatus() }]]));
    const before = readFileSync(path, "utf8");
    const other = tryLease(`${path}.lock`, 60_000, () => Date.now() + 60_000);
    expect(() =>
      updateLimitsCache(path, new Map([["b", { status: initialStatus() }]]), 200),
    ).toThrow(LeaseTimeoutError);
    expect(readFileSync(path, "utf8")).toBe(before);
    other?.release();
  });

  test("withLock runs the function and leaves no lock behind", () => {
    const path = join(tempDir(), "x.lock");
    expect(withLock(path, () => 7)).toBe(7);
    expect(existsSync(path)).toBe(false);
    expect(() =>
      withLock(path, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });
});

describe("two real processes on one config dir", () => {
  const CHILD = join(import.meta.dir, "lease-child.ts");
  const run = (args: string[]) =>
    Bun.spawn([process.execPath, CHILD, ...args], { stdout: "pipe", stderr: "pipe" });

  async function finish(proc: ReturnType<typeof run>): Promise<string> {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`child failed (${code}): ${err}`);
    return out;
  }

  test("asked for the same account at the same moment, they fetch it once", async () => {
    const dir = tempDir();
    const limitsPath = join(dir, "tokenhud", "limits.json");
    const log = join(dir, "fetches.txt");
    const startAt = String(Date.now() + 1500);
    const outs = await Promise.all(
      [run(["fetch", limitsPath, log, startAt]), run(["fetch", limitsPath, log, startAt])].map(
        finish,
      ),
    );
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    const fetched = outs.map((o) => JSON.parse(o)[0].fetched as boolean).sort();
    expect(fetched).toEqual([false, true]);
    const id = "00000000000000000000000000000001";
    expect(loadLimitsCache(limitsPath).providers[id]?.rate_limits.session?.used_percentage).toBe(
      10,
    );
    expect(readdirSync(dirname(leasePath(limitsPath, id)))).toEqual([]);
  }, 20_000);

  test("writing limits.json at the same time, neither loses the other's updates", async () => {
    const dir = tempDir();
    const limitsPath = join(dir, "tokenhud", "limits.json");
    const startAt = String(Date.now() + 1500);
    await Promise.all(
      [run(["merge", limitsPath, "a", startAt]), run(["merge", limitsPath, "b", startAt])].map(
        finish,
      ),
    );
    expect(Object.keys(loadLimitsCache(limitsPath).status)).toHaveLength(80);
    expect(readdirSync(dirname(limitsPath))).toEqual(["limits.json"]);
  }, 20_000);
});

describe("Windows contention", () => {
  test("EPERM and EBUSY mean another process has the file there, and only there", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    for (const code of ["EPERM", "EBUSY"]) {
      expect(isContention(err(code), "win32")).toBe(true);
      expect(isContention(err(code), "linux")).toBe(false);
      expect(isContention(err(code), "darwin")).toBe(false);
    }
    for (const code of ["EEXIST", "EACCES", "ENOENT", "EIO"]) {
      expect(isContention(err(code), "win32")).toBe(false);
    }
  });
});

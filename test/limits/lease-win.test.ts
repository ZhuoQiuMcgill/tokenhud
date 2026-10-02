// Windows EPERM/EBUSY, simulated on any OS (critique m6): `openSync` fails as Windows
// fails it, and `process.platform` says win32. A real permission error must surface, fast,
// and never turn into a stall followed by an unguarded write.
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { guard } from "../guard.ts";
import { cleanup, tempDir } from "./helpers.ts";

guard();

const realOpen = fs.openSync;
let fault: { code: string; times: number } | null = null;
mock.module("node:fs", () => ({
  ...fs,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (fault !== null && fault.times > 0) {
      fault.times--;
      throw Object.assign(new Error(`${fault.code}: operation not permitted`), {
        code: fault.code,
      });
    }
    return realOpen(...args);
  },
}));
const { CONTENTION_WINDOW_MS, LeaseTimeoutError, tryLease, withLock } = await import(
  "../../src/limits/lease.ts"
);

const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }));
afterAll(() => Object.defineProperty(process, "platform", platform));
afterEach(() => {
  fault = null;
  cleanup();
});

test.each(["EPERM", "EBUSY"])(
  "a lasting %s with no lease file is thrown, not waited out",
  (code) => {
    const path = join(tempDir(), "x.lock");
    fault = { code, times: Number.POSITIVE_INFINITY };
    let started = Date.now();
    expect(() => tryLease(path, 5_000)).toThrow(code);
    expect(Date.now() - started).toBeLessThan(CONTENTION_WINDOW_MS + 500);
    let ran = false;
    started = Date.now();
    expect(() =>
      withLock(path, () => {
        ran = true;
      }),
    ).toThrow(code);
    expect(ran).toBe(false);
    expect(Date.now() - started).toBeLessThan(CONTENTION_WINDOW_MS + 500);
  },
);

test("a passing EPERM (a lease file being deleted) is retried and the lease taken", () => {
  const path = join(tempDir(), "x.lock");
  fault = { code: "EPERM", times: 3 };
  const lease = tryLease(path, 5_000);
  expect(lease).not.toBeNull();
  lease?.release();
});

test("EPERM while another holder's lease file is there is contention: withLock waits, then throws", () => {
  const path = join(tempDir(), "x.lock");
  const other = tryLease(path, 60_000, () => Date.now() + 60_000);
  expect(other).not.toBeNull();
  fault = { code: "EPERM", times: Number.POSITIVE_INFINITY };
  expect(tryLease(path, 200)).toBeNull();
  let ran = false;
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
  fault = null;
  other?.release();
});
